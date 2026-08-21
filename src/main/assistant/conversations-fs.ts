// M28 — persistence for the Rise assistant's conversations. One JSON file per
// conversation under userData/assistant-conversations, mirroring calls-fs.ts's
// proven shape: writeJsonAtomic for crash-safe writes, a per-id lock so
// concurrent mutations of the SAME conversation serialize while different
// conversations stay fully concurrent, and sanitize-on-read so a hand-edited
// or partially-corrupt file degrades to something valid instead of throwing.
//
// Deliberately NOT in memory.db: the assistant must work with Sales Brain OFF,
// and memory.db is native-module-gated (better-sqlite3 + sqlite-vec — the
// exact modules behind the 1.2.1–1.2.4 clean-Windows hotfix saga). Flat JSON
// keeps chat availability independent of that whole failure class.
//
// Like the coaching chat (calls-fs.ts's CoachChatMessage), a turn is persisted
// only once COMPLETE — user message + the assistant's full final reply — so an
// interrupted stream never leaves a half-written turn on disk. Unlike the
// coaching chat, suggestions/citations ARE persisted on the message: the M26
// lesson (BUG-048/BUG-050) is that AI output living only in component state
// gets destroyed by a navigation the user had every right to make.
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeJsonAtomic } from '../atomic-write'
import type { CoachChatContextSuggestion } from '../calls-fs'

export type AssistantRole = 'user' | 'assistant'

/** A grounded reference from an assistant reply back to its evidence — the
 *  Memory Center trust rule ("every claim traceable") made visible in chat.
 *  `label` is denormalized at cite time so the chip still renders meaningfully
 *  if the underlying memory/call is later deleted or superseded. */
export interface AssistantCitation {
  kind: 'memory' | 'call'
  id: string
  label: string
  /** The [n] marker number this citation was assigned in the turn's CONTEXT
   *  (audit V4): the renderer binds chips to citations BY THIS NUMBER, never
   *  by array position, so a model-invented marker can only ever render as
   *  plain text — it can never shift real chips onto the wrong evidence. */
  marker?: number
}

export interface PersistedTaskProposal {
  id: string
  title: string
  type: 'follow-up' | 'email' | 'meeting' | 'research' | 'general'
  priority: 'low' | 'medium' | 'high'
  /** 'accepted' once the user confirmed and the task was really created —
   *  persisted so a reopened conversation can't re-offer or double-create. */
  status: 'pending' | 'accepted'
}

export interface AssistantMessage {
  id: string
  role: AssistantRole
  text: string
  createdAt: string
  /** Only on assistant messages that grounded themselves in retrieved
   *  memories/calls. Order matches the [n] markers in `text`, when present. */
  citations?: AssistantCitation[]
  /** Only on user messages — the M23 chip pattern: facts the assistant
   *  offered to save. Never applied without a tap (no silent writes). */
  suggestions?: CoachChatContextSuggestion[]
  /** Ids from `suggestions` the user has applied — persisted so a chip can't
   *  be double-applied after a reload. */
  appliedSuggestionIds?: string[]
  /** Only on assistant messages — write actions proposed by the turn's tool
   *  dispatch. Persisted WITH the message (the BUG-048 lesson: AI output
   *  living only in component state gets destroyed by navigation). */
  taskProposals?: PersistedTaskProposal[]
  /** Only on user messages — the voice note this message was dictated from
   *  (M28 Phase 3). The audio file lives in the conversations media dir;
   *  the TEXT of the message is the reviewed/edited transcript, which is
   *  what the AI ever sees — the audio is playback-only. */
  voiceNote?: { mediaId: string; durationMs: number }
  /** Only on user messages — files sent with this message (metadata; the
   *  bytes live in the conversations media dir). M28 Part 3. */
  attachments?: AssistantAttachment[]
}

/** M28 Part 3 — a file attached to a user message. `kind` decides how it
 *  reaches the provider: image → vision input, pdf → document input, text →
 *  locally-extracted text injected as context. */
export interface AssistantAttachment {
  id: string
  name: string
  kind: 'image' | 'pdf' | 'text'
  mimeType: string
  sizeBytes: number
  /** For 'text': how many characters were extracted and actually sent. */
  extractedChars?: number
}

/** M28 Part 4 — a conversation born IN THE CONTEXT of one client. Fixed at
 *  creation (a scope is an identity, not a setting): context assembly leads
 *  with this client's memories/calls/deals, retrieval never touches another
 *  client's scope, and the UI always shows who Rise is talking about. */
export interface AssistantScope {
  contactId: string
  /** Denormalized for display + prompts so the header never needs a fetch. */
  contactName: string
  company?: string
  dealId?: string
  dealTitle?: string
}

export interface AssistantConversation {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messages: AssistantMessage[]
  /** M28 Phase 2 — "don't learn from this conversation". Mirrors the call
   *  record's salesBrainExcluded: read FRESH by the extraction hook every
   *  time (a permission, never snapshotted), and setting it retroactively
   *  forgets what the conversation already taught (assistant-ipc.ts). */
  salesBrainExcluded?: boolean
  scope?: AssistantScope
}

/** List-row projection — everything the conversation list needs without
 *  loading full message arrays for every conversation. */
export interface AssistantConversationMeta {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
  /** First line of the latest message, for the list row's preview. */
  preview: string
  scope?: AssistantScope
}

export const MAX_MESSAGES = 500
export const MAX_MESSAGE_TEXT = 16_000
export const MAX_TITLE_CHARS = 120
const MAX_CITATIONS = 20
const MAX_SUGGESTIONS = 5
const PREVIEW_CHARS = 140
const ID_RE = /^[A-Za-z0-9-]{1,64}$/

export function isSafeConversationId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id)
}

export function conversationsDir(userDataDir: string): string {
  return join(userDataDir, 'assistant-conversations')
}

// Same per-id chaining pattern as calls-fs.ts's withCallLock — see its doc
// comment for why a prior failure must not block the queue.
const locks = new Map<string, Promise<unknown>>()

async function withConversationLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  const settled = next.catch(() => {})
  locks.set(id, settled)
  settled.then(() => {
    if (locks.get(id) === settled) locks.delete(id)
  })
  return next
}

function clampText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function sanitizeCitations(value: unknown): AssistantCitation[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: AssistantCitation[] = []
  for (const v of value.slice(0, MAX_CITATIONS)) {
    const c = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
    if ((c.kind === 'memory' || c.kind === 'call') && isSafeConversationId(c.id)) {
      const marker =
        typeof c.marker === 'number' && Number.isInteger(c.marker) && c.marker >= 1 && c.marker <= 99
          ? c.marker
          : undefined
      out.push({ kind: c.kind, id: c.id, label: clampText(c.label, 300), marker })
    }
  }
  return out.length > 0 ? out : undefined
}

function sanitizeSuggestions(value: unknown): CoachChatContextSuggestion[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: CoachChatContextSuggestion[] = []
  for (const v of value.slice(0, MAX_SUGGESTIONS)) {
    const s = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
    const type = s.type
    if (type !== 'kyc' && type !== 'next-steps' && type !== 'call-notes' && type !== 'memory') {
      continue
    }
    const text = clampText(s.text, 1000)
    if (!text || !isSafeConversationId(s.id)) continue
    out.push({
      id: s.id,
      type,
      field: typeof s.field === 'string' ? s.field.slice(0, 100) : undefined,
      text,
      confidence: s.confidence === 'high' ? 'high' : 'medium',
      memoryScope: typeof s.memoryScope === 'string' ? s.memoryScope.slice(0, 100) : undefined,
      memoryCategory:
        typeof s.memoryCategory === 'string' ? s.memoryCategory.slice(0, 100) : undefined
    })
  }
  return out.length > 0 ? out : undefined
}

const MEDIA_FILE_RE = /^[A-Za-z0-9-]{1,64}\.(webm|ogg)$/
const MAX_VOICE_NOTE_DURATION_MS = 5 * 60 * 1000

function sanitizeVoiceNote(value: unknown): AssistantMessage['voiceNote'] {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  if (typeof v.mediaId !== 'string' || !MEDIA_FILE_RE.test(v.mediaId)) return undefined
  const durationMs =
    typeof v.durationMs === 'number' && Number.isFinite(v.durationMs)
      ? Math.max(0, Math.min(v.durationMs, MAX_VOICE_NOTE_DURATION_MS))
      : 0
  return { mediaId: v.mediaId, durationMs }
}

const TASK_TYPES = new Set(['follow-up', 'email', 'meeting', 'research', 'general'])
const TASK_PRIORITIES = new Set(['low', 'medium', 'high'])
const MAX_TASK_PROPOSALS = 5

function sanitizeTaskProposals(value: unknown): PersistedTaskProposal[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: PersistedTaskProposal[] = []
  for (const v of value.slice(0, MAX_TASK_PROPOSALS)) {
    const p = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
    const title = clampText(p.title, 200)
    if (!title || !isSafeConversationId(p.id)) continue
    out.push({
      id: p.id,
      title,
      type: (TASK_TYPES.has(p.type as string) ? p.type : 'general') as PersistedTaskProposal['type'],
      priority: (TASK_PRIORITIES.has(p.priority as string)
        ? p.priority
        : 'medium') as PersistedTaskProposal['priority'],
      status: p.status === 'accepted' ? 'accepted' : 'pending'
    })
  }
  return out.length > 0 ? out : undefined
}

const ATTACHMENT_KINDS = new Set(['image', 'pdf', 'text'])
const MAX_ATTACHMENTS = 6

function sanitizeAttachments(value: unknown): AssistantAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: AssistantAttachment[] = []
  for (const v of value.slice(0, MAX_ATTACHMENTS)) {
    const a = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
    if (!isSafeConversationId(a.id) || !ATTACHMENT_KINDS.has(a.kind as string)) continue
    out.push({
      id: a.id,
      name: clampText(a.name, 200) || 'file',
      kind: a.kind as AssistantAttachment['kind'],
      mimeType: clampText(a.mimeType, 100),
      sizeBytes: typeof a.sizeBytes === 'number' && a.sizeBytes >= 0 ? a.sizeBytes : 0,
      extractedChars:
        typeof a.extractedChars === 'number' && a.extractedChars >= 0 ? a.extractedChars : undefined
    })
  }
  return out.length > 0 ? out : undefined
}

export function sanitizeScope(value: unknown): AssistantScope | undefined {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  if (!isSafeConversationId(v.contactId)) return undefined
  const contactName = clampText(v.contactName, 200).trim()
  if (!contactName) return undefined
  return {
    contactId: v.contactId,
    contactName,
    company: clampText(v.company, 200) || undefined,
    dealId: isSafeConversationId(v.dealId) ? v.dealId : undefined,
    dealTitle: clampText(v.dealTitle, 200) || undefined
  }
}

function sanitizeMessage(value: unknown): AssistantMessage | null {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  if (v.role !== 'user' && v.role !== 'assistant') return null
  const text = clampText(v.text, MAX_MESSAGE_TEXT)
  if (!text) return null
  const applied = Array.isArray(v.appliedSuggestionIds)
    ? v.appliedSuggestionIds.filter(isSafeConversationId)
    : []
  return {
    id: isSafeConversationId(v.id) ? v.id : randomUUID(),
    role: v.role,
    text,
    createdAt: typeof v.createdAt === 'string' ? v.createdAt : new Date().toISOString(),
    citations: v.role === 'assistant' ? sanitizeCitations(v.citations) : undefined,
    suggestions: v.role === 'user' ? sanitizeSuggestions(v.suggestions) : undefined,
    appliedSuggestionIds: applied.length > 0 ? applied : undefined,
    taskProposals: v.role === 'assistant' ? sanitizeTaskProposals(v.taskProposals) : undefined,
    voiceNote: v.role === 'user' ? sanitizeVoiceNote(v.voiceNote) : undefined,
    attachments: v.role === 'user' ? sanitizeAttachments(v.attachments) : undefined
  }
}

export function sanitizeConversation(value: unknown): AssistantConversation | null {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  if (!isSafeConversationId(v.id)) return null
  const messages = Array.isArray(v.messages)
    ? v.messages
        .map(sanitizeMessage)
        .filter((m): m is AssistantMessage => m !== null)
        .slice(-MAX_MESSAGES)
    : []
  const now = new Date().toISOString()
  return {
    id: v.id,
    title: clampText(v.title, MAX_TITLE_CHARS) || 'New conversation',
    createdAt: typeof v.createdAt === 'string' ? v.createdAt : now,
    updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : now,
    messages,
    salesBrainExcluded: v.salesBrainExcluded === true ? true : undefined,
    scope: sanitizeScope(v.scope)
  }
}

async function readConversationFile(path: string): Promise<AssistantConversation | null> {
  try {
    const raw = await fs.readFile(path, 'utf8')
    return sanitizeConversation(JSON.parse(raw))
  } catch {
    // Unreadable/corrupt file: skip rather than throw — writeJsonAtomic
    // guarantees we never PRODUCE one, but disk history is not ours to trust.
    return null
  }
}

async function writeConversation(dir: string, conversation: AssistantConversation): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  await writeJsonAtomic(join(dir, `${conversation.id}.json`), conversation)
}

export async function getConversation(
  dir: string,
  id: string
): Promise<AssistantConversation | null> {
  if (!isSafeConversationId(id)) return null
  return readConversationFile(join(dir, `${id}.json`))
}

export async function listConversations(dir: string): Promise<AssistantConversationMeta[]> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return [] // dir doesn't exist yet — no conversations, not an error
  }
  const metas: AssistantConversationMeta[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const conv = await readConversationFile(join(dir, name))
    if (!conv) continue
    const last = conv.messages[conv.messages.length - 1]
    metas.push({
      id: conv.id,
      title: conv.title,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      messageCount: conv.messages.length,
      preview: last ? last.text.split('\n')[0].slice(0, PREVIEW_CHARS) : '',
      scope: conv.scope
    })
  }
  metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return metas
}

export function defaultTitleFor(scope: AssistantScope | undefined): string {
  return scope ? `About ${scope.contactName}` : 'New conversation'
}

export async function createConversation(
  dir: string,
  title?: string,
  scope?: AssistantScope
): Promise<AssistantConversation> {
  const now = new Date().toISOString()
  const cleanScope = sanitizeScope(scope)
  const conversation: AssistantConversation = {
    id: randomUUID(),
    title: clampText(title, MAX_TITLE_CHARS) || defaultTitleFor(cleanScope),
    createdAt: now,
    updatedAt: now,
    messages: [],
    scope: cleanScope
  }
  await writeConversation(dir, conversation)
  return conversation
}

export async function renameConversation(
  dir: string,
  id: string,
  title: string
): Promise<AssistantConversation | null> {
  const clean = clampText(title, MAX_TITLE_CHARS).trim()
  if (!clean) return null
  return withConversationLock(id, async () => {
    const conv = await getConversation(dir, id)
    if (!conv) return null
    conv.title = clean
    conv.updatedAt = new Date().toISOString()
    await writeConversation(dir, conv)
    return conv
  })
}

/** Hard delete — conversations are local-only (never in the cloud-backup
 *  allowlist, same posture as the coaching chat), so delete means delete. */
export async function deleteConversation(dir: string, id: string): Promise<boolean> {
  if (!isSafeConversationId(id)) return false
  return withConversationLock(id, async () => {
    try {
      await fs.unlink(join(dir, `${id}.json`))
      return true
    } catch {
      return false
    }
  })
}

/** Append one COMPLETE turn (user + final assistant reply) under the lock.
 *  Also auto-titles a still-default conversation from the first user message
 *  so the list is scannable without the user ever renaming anything. */
export async function appendTurn(
  dir: string,
  id: string,
  userMessage: Omit<AssistantMessage, 'id' | 'createdAt' | 'role'>,
  assistantMessage: Omit<AssistantMessage, 'id' | 'createdAt' | 'role'>
): Promise<AssistantConversation | null> {
  return withConversationLock(id, async () => {
    const conv = await getConversation(dir, id)
    if (!conv) return null
    const now = new Date().toISOString()
    const user: AssistantMessage = {
      id: randomUUID(),
      role: 'user',
      createdAt: now,
      text: clampText(userMessage.text, MAX_MESSAGE_TEXT),
      suggestions: sanitizeSuggestions(userMessage.suggestions),
      voiceNote: sanitizeVoiceNote(userMessage.voiceNote),
      attachments: sanitizeAttachments(userMessage.attachments)
    }
    const assistant: AssistantMessage = {
      id: randomUUID(),
      role: 'assistant',
      createdAt: now,
      text: clampText(assistantMessage.text, MAX_MESSAGE_TEXT),
      citations: sanitizeCitations(assistantMessage.citations),
      taskProposals: sanitizeTaskProposals(assistantMessage.taskProposals)
    }
    conv.messages = [...conv.messages, user, assistant].slice(-MAX_MESSAGES)
    if (conv.title === defaultTitleFor(conv.scope) && user.text) {
      conv.title = user.text.split('\n')[0].slice(0, MAX_TITLE_CHARS)
    }
    conv.updatedAt = now
    await writeConversation(dir, conv)
    return conv
  })
}

/** Flip a task proposal to accepted — persisted so a reopened conversation
 *  can't double-create the task. Returns the proposal, or null when missing
 *  or ALREADY accepted (the caller must treat that as "do not create"). */
export async function acceptTaskProposal(
  dir: string,
  conversationId: string,
  messageId: string,
  proposalId: string
): Promise<PersistedTaskProposal | null> {
  return withConversationLock(conversationId, async () => {
    const conv = await getConversation(dir, conversationId)
    if (!conv) return null
    const msg = conv.messages.find((m) => m.id === messageId)
    const proposal = msg?.taskProposals?.find((p) => p.id === proposalId)
    if (!proposal || proposal.status === 'accepted') return null
    proposal.status = 'accepted'
    conv.updatedAt = new Date().toISOString()
    await writeConversation(dir, conv)
    return proposal
  })
}

/** Set the per-conversation "don't learn from this" flag. The retroactive
 *  forget of already-extracted memories is the CALLER's job (assistant-ipc
 *  owns the memory db) — this only persists the permission. */
export async function setConversationSalesBrainExcluded(
  dir: string,
  id: string,
  excluded: boolean
): Promise<AssistantConversation | null> {
  return withConversationLock(id, async () => {
    const conv = await getConversation(dir, id)
    if (!conv) return null
    conv.salesBrainExcluded = excluded ? true : undefined
    conv.updatedAt = new Date().toISOString()
    await writeConversation(dir, conv)
    return conv
  })
}

/** Roll an accepted proposal back to pending — the compensation path when
 *  the task creation that followed acceptance failed. */
export async function revertTaskProposal(
  dir: string,
  conversationId: string,
  messageId: string,
  proposalId: string
): Promise<void> {
  await withConversationLock(conversationId, async () => {
    const conv = await getConversation(dir, conversationId)
    const proposal = conv?.messages
      .find((m) => m.id === messageId)
      ?.taskProposals?.find((p) => p.id === proposalId)
    if (!conv || !proposal) return
    proposal.status = 'pending'
    await writeConversation(dir, conv)
  })
}

/** Mark a chip applied — persisted so a reload can't re-offer it. */
export async function markSuggestionApplied(
  dir: string,
  conversationId: string,
  messageId: string,
  suggestionId: string
): Promise<AssistantConversation | null> {
  return withConversationLock(conversationId, async () => {
    const conv = await getConversation(dir, conversationId)
    if (!conv) return null
    const msg = conv.messages.find((m) => m.id === messageId)
    if (!msg) return null
    const applied = new Set(msg.appliedSuggestionIds ?? [])
    applied.add(suggestionId)
    msg.appliedSuggestionIds = [...applied]
    conv.updatedAt = new Date().toISOString()
    await writeConversation(dir, conv)
    return conv
  })
}
