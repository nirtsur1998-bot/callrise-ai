// M28 — IPC surface + turn engine for the Rise assistant. Streaming uses the
// app's one established shape (coaching-chat-ipc.ts): push events during the
// SAME invoke() that resolves with the final message. Two deliberate M28
// additions over that precedent, both answers to Phase 0 findings:
//
// 1. MAIN OWNS THE IN-FLIGHT TURN (the M26 principle — screens don't own
//    work). Deltas accumulate here, so a remounting renderer re-attaches via
//    assistant:attach and recovers the partial text instead of losing it to
//    navigation (the coaching chat's documented gap).
// 2. A REAL STOP. assistant:cancel aborts the walk through req.signal
//    (BUG-060's lesson: cancel must reach the actual work). A stop with
//    partial text persists the partial turn — already-streamed words the
//    user read are work product, not garbage (the BUG-048 lesson).
import { app, ipcMain, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { AIProviderError } from '../ai'
import {
  streamWithFallback,
  AllModelsExhaustedError,
  resolveChain
} from '../ai/complete-with-fallback'
import { noCapableModelMessage } from '../ai/capability-copy'
import {
  fitPromptToBudget,
  budgetCharsFor,
  truncationMarker,
  DEFAULT_CONTEXT_WINDOW_TOKENS
} from './prompt-budget'
import type { AIMessage } from '../ai/types'
import {
  businessProfileSection,
  clientProfileSection,
  repProfileSection
} from '../memory/profile-injection'
import { retrieveRelevantMemoriesStructured } from '../memory/rag'
import { consolidateNewCandidate } from '../memory/consolidation'
import { getMemoryDb, ensureMemoryDb } from '../memory/memory-runtime'
import { forgetCallContribution, getMemoryById } from '../memory/memories-store'
import { runMemoryExtractionForAssistantMessage } from '../memory/memory-hooks'
import { isSalesBrainEnabled } from '../app-settings'
import { extractContextSuggestions } from '../coaching-chat'
import type { CoachChatContextSuggestion } from '../calls-fs'
import type { MemoryCategory, MemoryScope } from '../memory/types'
import { buildAssistantContext, citationsUsedIn } from './context'
import { detectUnboundClientMentions } from './unbound-client'
import { unboundClientNotice } from './unbound-client-notice'
import {
  deleteVoiceNote,
  readVoiceNote,
  saveVoiceNote,
  transcribeVoiceNote,
  MAX_VOICE_NOTE_BYTES
} from './voice-note'
import {
  clientBriefSections,
  defaultToolDirs,
  executeLookups,
  planLookups,
  type TaskProposal
} from './tools'
import {
  addAttachment,
  deleteAttachment,
  readAttachmentBytes,
  readAttachmentRecord,
  ATTACHMENT_LIMITS
} from './attachments'
import { createTask } from '../tasks-fs'
import { scheduleBackup } from '../backup'
import {
  acceptTaskProposal,
  appendTurn,
  conversationsDir,
  createConversation,
  deleteConversation,
  getConversation,
  isSafeConversationId,
  listConversations,
  markSuggestionApplied,
  renameConversation,
  revertTaskProposal,
  sanitizeScope,
  setConversationSalesBrainExcluded,
  type AssistantAttachment,
  type AssistantCitation,
  type PersistedTaskProposal
} from './conversations-fs'

/** Replay window per turn — storage keeps up to MAX_MESSAGES (500), but the
 *  model re-reads only this many. Same split as the coaching chat's 40/300. */
const MAX_HISTORY_MESSAGES = 40
const MAX_INBOUND_CHARS = 8_000
const SUGGESTION_TIMEOUT_MS = 5_000
const MAX_TOKENS = 2_048

function dir(): string {
  return conversationsDir(app.getPath('userData'))
}

function tasksDirPath(): string {
  return join(app.getPath('userData'), 'tasks')
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

function friendlyError(err: unknown): string {
  if (err instanceof AllModelsExhaustedError) return err.message
  if (err instanceof AIProviderError) return err.message
  return 'Something went wrong. Please try again.'
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

export interface AssistantSendResult {
  ok: boolean
  /** Machine-readable failure class; `message` is always the human copy. */
  /** 'attachment-mismatch' (2026-08-24): a staged file belonged to a
   *  different conversation and was refused rather than sent. */
  error?:
    | 'not-found'
    | 'busy'
    | 'empty'
    | 'ai-failed'
    | 'cancelled'
    | 'attachment-mismatch'
    | 'too-many-documents'
  message?: string
  reply?: string
  citations?: AssistantCitation[]
  suggestions?: CoachChatContextSuggestion[]
  /** True when the user stopped the stream and the partial reply was kept. */
  stopped?: boolean
  /** The persisted user-message id, so the renderer can wire suggestion chips
   *  to applySuggestion without re-fetching the conversation. */
  userMessageId?: string
}

export interface AssistantAttachSnapshot {
  streaming: boolean
  /** Accumulated text of the in-flight reply, '' when idle. */
  accumulated: string
  /** The user message that started the in-flight turn, for optimistic render. */
  pendingUserText: string
}

interface InFlightTurn {
  controller: AbortController
  accumulated: string
  userText: string
  /** Set by assistant:cancel so the finally-block knows a stop is a stop,
   *  not a provider failure. */
  stopRequested: boolean
}

const inFlight = new Map<string, InFlightTurn>()

/** Test seam: assert idle state without reaching into module internals. */
export function inFlightCountForTests(): number {
  return inFlight.size
}

/** M28 Part 3 — resolve attachment ids (renderer-supplied) against the
 *  TRUSTED stored records, and load what each will contribute to the turn. */
/**
 * AUDIT FIX (2026-08-24) — refuses any attachment staged for a DIFFERENT
 * conversation. See StoredAttachmentRecord.conversationId for the leak.
 *
 * Fails CLOSED on a record with no owner: attachments are staged seconds
 * before they are sent, so an unowned record can only come from a build older
 * than this field, and trusting it would leave exactly the hole this closes.
 * The user gets a clear refusal and can re-attach.
 */
async function loadAttachments(
  ids: string[],
  conversationId: string
): Promise<{
  metadata: AssistantAttachment[]
  images: { mimeType: string; base64: string }[]
  document?: { base64: string; filename?: string }
  texts: { name: string; text: string }[]
  /** Names of files refused because they belong to another conversation. */
  rejected: string[]
  /** Names of PDFs beyond the first; the request shape carries only one. */
  extraDocuments: string[]
}> {
  const metadata: AssistantAttachment[] = []
  const images: { mimeType: string; base64: string }[] = []
  const texts: { name: string; text: string }[] = []
  let document: { base64: string; filename?: string } | undefined
  const rejected: string[] = []
  /** Names of PDFs beyond the first — the request carries only one. */
  const extraDocuments: string[] = []
  for (const id of ids.slice(0, 6)) {
    const record = await readAttachmentRecord(dir(), id)
    if (!record) continue
    if (record.conversationId !== conversationId) {
      rejected.push(record.name)
      continue
    }
    const bytes = await readAttachmentBytes(dir(), record)
    if (!bytes) continue
    const { storedExt: _ext, ...meta } = record
    void _ext
    metadata.push(meta)
    if (record.kind === 'image') images.push({ mimeType: record.mimeType, base64: bytes.toString('base64') })
    else if (record.kind === 'pdf') {
      // AUDIT FIX (2026-08-25) — this used to be `&& !document`, silently
      // keeping the FIRST pdf and discarding the rest while every chip in the
      // composer still said the file had been sent. The request shape carries
      // ONE document (req.document is singular across all four provider
      // adapters), so a second pdf cannot be delivered — and a silent drop is
      // the one outcome worse than refusing.
      if (document) extraDocuments.push(record.name)
      else document = { base64: bytes.toString('base64'), filename: record.name }
    }
    else if (record.kind === 'text') texts.push({ name: record.name, text: bytes.toString('utf8') })
  }
  return { metadata, images, document, texts, rejected, extraDocuments }
}

async function handleSend(
  conversationId: string,
  rawMessage: string,
  voiceNote?: { mediaId: string; durationMs: number },
  attachmentIds: string[] = []
): Promise<AssistantSendResult> {
  const message = typeof rawMessage === 'string' ? rawMessage.trim().slice(0, MAX_INBOUND_CHARS) : ''
  if (!isSafeConversationId(conversationId)) return { ok: false, error: 'not-found', message: 'Conversation not found.' }
  if (!message) return { ok: false, error: 'empty', message: 'Type a message first.' }

  // AUDIT FIX (2026-08-24) — CLAIM THE SLOT SYNCHRONOUSLY.
  //
  // This was a real check-then-act race, not a theoretical one. The busy
  // check used to sit AFTER `await getConversation(...)` and the registration
  // AFTER `await loadAttachments(...)`, so two sends on the same conversation
  // could both observe an empty `inFlight` and both proceed. The damage was
  // not just a duplicate turn: the second `inFlight.set` overwrote the first
  // turn's entry, and whichever turn settled first ran the `finally` that
  // deletes the SURVIVOR's registration — after which `assistant:cancel`
  // returned false and `assistant:attach` reported streaming:false while
  // tokens were still arriving, with both turns broadcasting deltas into the
  // same bubble. Trigger paths are ordinary: two windows on one conversation,
  // or a double Enter inside a single React batch (each renderer hook has its
  // own `sending` flag, so main's check is the only shared guard).
  //
  // The fix is to make check-and-claim ATOMIC — no await may separate them.
  // JS is single-threaded, so a synchronous has()+set() pair cannot interleave.
  // Everything that can fail now lives inside the try, whose finally releases
  // the slot on every exit path.
  if (inFlight.has(conversationId)) {
    return { ok: false, error: 'busy', message: 'A reply is already in progress — stop it first.' }
  }
  const turn: InFlightTurn = {
    controller: new AbortController(),
    accumulated: '',
    userText: message,
    stopRequested: false
  }
  inFlight.set(conversationId, turn)

  try {
    const conv = await getConversation(dir(), conversationId)
    if (!conv) return { ok: false, error: 'not-found', message: 'Conversation not found.' }

    // M28 Part 3 — attachments, with the vision gate BEFORE the turn starts:
    // an image with no vision-capable model is refused with the exact reason,
    // never silently dropped or sent to a model that can't read it.
    const files = await loadAttachments(attachmentIds, conversationId)
    if (files.extraDocuments.length > 0) {
      // Refuse rather than silently send one of them. The composer prevents
      // this from being reachable in normal use; this is the guard that makes
      // a silent drop impossible from any path.
      return {
        ok: false,
        error: 'too-many-documents',
        message:
          `Only one PDF can be sent per message. Remove ${files.extraDocuments.join(', ')} and send again, or send them in separate messages.`
      }
    }
    if (files.rejected.length > 0) {
      // AUDIT FIX (2026-08-24) — a staged file belonging to a DIFFERENT
      // conversation must never ride along. In a client-scoped chat that is
      // one client's document reaching another client's turn.
      return {
        ok: false,
        error: 'attachment-mismatch',
        message:
          files.rejected.length === 1
            ? `"${files.rejected[0]}" was attached in a different conversation. Attach it again here if you meant to send it.`
            : `${files.rejected.length} files were attached in a different conversation. Attach them again here if you meant to send them.`
      }
    }
    // AUDIT FIX (2026-08-24) — documents are gated exactly like images now.
    //
    // Before, only images were checked. A PDF rode into the chain ungated,
    // openai-compatible.ts emitted an OpenAI-only file part to providers that
    // reject it, and each 400 blacklisted a model for four hours. The refusal
    // copy right here made it worse by recommending PDF as the workaround for
    // an unreadable image.
    //
    // The message text now comes from noCapableModelMessage, the same
    // function the chain layer uses when it refuses for the same reason. It
    // was previously copy-pasted here, so the two could disagree — and while
    // they still agreed, they agreed on the wrong advice.
    const capabilityNeeds =
      files.images.length > 0
        ? { needsVision: true }
        : files.document
          ? { needsDocument: true }
          : null
    if (capabilityNeeds) {
      const { configured, capable } = resolveChain('assistant-chat', capabilityNeeds)
      if (configured.length > 0 && capable.length === 0) {
        return { ok: false, error: 'ai-failed', message: noCapableModelMessage(capabilityNeeds) }
      }
    }
    // M28 Part 4 — the conversation's client scope, read from the record:
    // retrieval and every lookup are narrowed to this one contact.
    const scope = conv.scope

    // Activity phases (P1 streaming-state work): honest, coarse progress for
    // the pre-first-token window — driven by what the turn is ACTUALLY doing,
    // never a fake ticker. The renderer clears it on the first delta.
    //
    // AUDIT FIX (2026-08-25) — 'reading' was broadcast UNCONDITIONALLY, so
    // "Reading your Sales Brain…" appeared on turns that never touched it:
    // Sales Brain off (the shipping default), or its DB unavailable. The
    // comment directly above asserted the exact property the code violated,
    // which is the worst version of this — a status that lies while claiming
    // it cannot.
    //
    // Same condition as salesBrain:status (BUG-100), deliberately: two places
    // answering "will the brain be consulted" must not drift. When it will
    // not be, the turn skips straight to the phase it IS in — planning runs
    // regardless — rather than inventing a step.
    if (isSalesBrainEnabled() && getMemoryDb() !== null) {
      broadcast('assistant:phase', { conversationId, phase: 'reading' })
    } else {
      broadcast('assistant:phase', { conversationId, phase: 'searching' })
    }
    // Foreground retrieval: ensureMemoryDb retry + bounded embedding, so a
    // cold start degrades to a memory-blind turn instead of a hung one.
    // Hypotheses included ON PURPOSE: a young install's Sales Brain is all
    // hypotheses, and "I don't know anything" next to a visibly full Memory
    // Center is the credibility trap Phase 0 flagged — context.ts hedges
    // their phrasing. Retrieval and lookup PLANNING run concurrently (both
    // need only the message); planning degrades to [] when no tool-capable
    // model exists.
    const toolDirs = defaultToolDirs(app.getPath('userData'))
    const [retrieved, planned, clientBrief, unboundMentions] = await Promise.all([
      retrieveRelevantMemoriesStructured(message, {
        foreground: true,
        includeHypotheses: true,
        // Scoped: rag searches rep + business + THIS client's scope and no
        // other client's — the cross-client invariant lives in rag.ts's scope
        // list, which is built from exactly this id.
        contactId: scope?.contactId ?? null
      }),
      planLookups(message, turn.controller.signal),
      scope ? clientBriefSections(scope.contactId, toolDirs) : Promise.resolve([]),
      // BUG-096 fix C — in an UNBOUND chat, work out which named clients this
      // conversation cannot reach. Runs only when there is no scope: a scoped
      // chat can reach its own client, and asking about a different one is
      // the cross-client case that other guards already refuse.
      //
      // Deliberately does NOT widen retrieval. The cross-client invariant
      // stays untouched BY CONSTRUCTION rather than by care — this path adds
      // a note about what is missing, never the missing data itself.
      scope
        ? Promise.resolve([])
        : detectUnboundClientMentions(message, toolDirs.contactsDir).catch(() => [])
    ])
    if (turn.stopRequested) return { ok: false, error: 'cancelled', message: 'Stopped.' }
    const unboundNotice = unboundClientNotice(unboundMentions)
    if (planned.length > 0) {
      broadcast('assistant:phase', { conversationId, phase: 'searching' })
    }
    const lookups = await executeLookups(
      planned,
      toolDirs,
      turn.controller.signal,
      scope?.contactId
    )
    if (turn.stopRequested) return { ok: false, error: 'cancelled', message: 'Stopped.' }
    const context = buildAssistantContext({
      repProfile: repProfileSection('full'),
      businessProfile: businessProfileSection('full'),
      retrieved,
      // The client brief LEADS the lookup sections in a scoped turn.
      // The unreachable-client notice LEADS, for the same reason the client
      // brief leads in a scoped turn: it changes how everything after it
      // should be read.
      lookupSections: [
        ...(unboundNotice ? [unboundNotice] : []),
        ...clientBrief,
        ...lookups.sections
      ],
      scope: scope
        ? { contactName: scope.contactName, company: scope.company, dealTitle: scope.dealTitle }
        : undefined,
      clientProfile: scope ? clientProfileSection(scope.contactId, 'full') : undefined,
      attachmentTexts: files.texts.length > 0 ? files.texts : undefined
    })

    const rawHistory: AIMessage[] = conv.messages
      .slice(-MAX_HISTORY_MESSAGES)
      .map((m) => ({ role: m.role, content: m.text }))

    // AUDIT FIX (2026-08-24) — a TOTAL bound on the prompt.
    //
    // Each input was capped individually and nothing capped the sum, so
    // ~595,000 chars (~149,000 tokens) was reachable through the UI against a
    // declared 128,000-token window: a 267,016-char system prompt with six
    // text attachments, plus 40 history turns at 8,000 chars each. Overflow
    // returned a 400, which failure-class.ts calls 'structural', and the walk
    // then sent the SAME oversize prompt to the next model and blacklisted
    // each one in turn — the user seeing only AllModelsExhaustedError, which
    // never mentions size.
    //
    // Note the earlier drop-history rule fired only for images and PDFs, so
    // TEXT attachments — the bulkiest input there is — stacked with full
    // history. This bound covers every source uniformly instead.
    // MERGE (2026-08-25) — ported to main's canonical prompt-budget signature.
    //
    // It takes { systemFixed, trimmable } rather than one opaque `system`,
    // because coaching-chat's trimmable section (the transcript) sits in the
    // MIDDLE of its prompt and can only be addressed before the parts are
    // joined. Rise's trimmable section is the attachment text, appended last,
    // so context.ts hands both halves over directly rather than this code
    // guessing at an offset into a finished string.
    //
    // 'tail' is Rise's direction and it is load-bearing: it keeps the HEAD of
    // the trimmable section, and cutting the head instead would drop
    // SCOPE_RULE — the instruction that stops one client's data being
    // discussed in another client's chat. main's suite already asserts this
    // direction ("trimFrom 'tail' keeps the START — the direction Rise needs
    // for SCOPE_RULE"), written before Rise arrived.
    const budget = fitPromptToBudget(
      {
        systemFixed: context.systemFixed,
        trimmable: context.trimmable,
        history: rawHistory,
        message
      },
      budgetCharsFor(DEFAULT_CONTEXT_WINDOW_TOKENS),
      'tail'
    )
    const history = budget.history
    // The marker is composed by the CALLER now, so a second trim can never
    // leave a fragment of a first one, and the wording lives with the feature.
    const trimmedTail =
      budget.trim.trimmableCharsDropped > 0
        ? budget.trimmable + truncationMarker('some attachment text')
        : budget.trimmable
    const systemPrompt = [context.systemFixed, trimmedTail]
      .filter((s) => s.length > 0)
      .join('\n\n')

    if (!budget.fits) {
      // The fixed floor plus the user's own message already exceed the budget,
      // so nothing this module is allowed to cut can rescue it. Reported
      // rather than hidden behind a result that looks fitted.
      console.warn(
        '[assistant] prompt does not fit even after trimming everything trimmable —',
        'the fixed sections alone exceed the budget:',
        conversationId
      )
    }
    if (budget.historyStartedOnAssistant) {
      // Not the routine odd-drop boundary — this history was ALREADY
      // malformed on arrival, which nothing should be able to produce. The
      // trimmer repairs it either way; this is what stops the repair from
      // hiding it. See BUG-109.
      console.warn(
        '[assistant] conversation history began on an assistant turn before any trimming —',
        'the user/assistant pairing invariant was violated upstream:',
        conversationId
      )
    }
    if (budget.trim.trimmed) {
      console.warn(
        '[assistant] prompt trimmed to fit the context budget:',
        `${budget.trim.historyMessagesDropped} history message(s) dropped, ` +
          `${budget.trim.trimmableCharsDropped} attachment char(s) truncated`
      )
    }

    broadcast('assistant:phase', { conversationId, phase: 'thinking' })
    const stream = streamWithFallback({
      purpose: 'assistant-chat',
      system: systemPrompt,
      messages: [...history, { role: 'user', content: message }],
      maxTokens: MAX_TOKENS,
      signal: turn.controller.signal,
      // M28 Part 3 — native multimodal parts ride on the first user message
      // of the request; providers attach them in their own formats. NOTE:
      // history puts older turns first, so for a conversation with history
      // the attachments bind to message[0]... which is the OLDEST user turn.
      // Providers attach to the first USER message — so when attachments are
      // present we send ONLY the current message (no history) to keep the
      // binding unambiguous. Documented trade-off: an attachment turn is
      // answered on its own merits plus the CONTEXT, without chat history.
      ...(files.images.length > 0 || files.document
        ? {
            messages: [{ role: 'user' as const, content: message }],
            images: files.images.length > 0 ? files.images : undefined,
            document: files.document
          }
        : {})
    })

    let streamError: unknown = null
    try {
      for await (const chunk of stream) {
        turn.accumulated += chunk.delta
        broadcast('assistant:delta', { conversationId, delta: chunk.delta })
      }
    } catch (err) {
      streamError = err
    }
    // Always settle .final — even on the error path — to avoid an unhandled
    // rejection (same rule coaching-chat-ipc.ts documents).
    await stream.final.catch(() => {})

    const stopped = turn.stopRequested
    if (streamError && !(stopped && turn.accumulated)) {
      if (stopped) {
        // Stopped before any token arrived — nothing worth keeping.
        return { ok: false, error: 'cancelled', message: 'Stopped.' }
      }
      const msg = friendlyError(streamError)
      broadcast('assistant:error', { conversationId, message: msg })
      return { ok: false, error: 'ai-failed', message: msg }
    }

    const reply = turn.accumulated
    if (!reply.trim()) {
      // A model can "succeed" with zero tokens; persisting that would write a
      // turn whose empty assistant message sanitize-on-read silently drops.
      const msg = 'The model returned an empty reply. Please try again.'
      broadcast('assistant:error', { conversationId, message: msg })
      return { ok: false, error: 'ai-failed', message: msg }
    }
    const citations = citationsUsedIn(reply, context.citationsByMarker)

    // Save-chips: reuse the M23/M25 extraction on ONLY the user's message.
    // Global surface has no bound contact yet, so kyc/client-scope/call
    // suggestion types self-disable or are filtered — memory (rep/business)
    // is the one chip family that makes sense here in Phase 1.
    // Audit fix V6: a chip that cannot possibly save (Sales Brain off, db
    // unavailable, or this conversation set to "Not learning") must never be
    // OFFERED — a clickable control that silently does nothing forever is
    // the failure mode. Skipping also saves the AI call.
    const suggestions = await (async () => {
      if (!isSalesBrainEnabled() || !getMemoryDb()) return []
      const freshConv = await getConversation(dir(), conversationId)
      if (!freshConv || freshConv.salesBrainExcluded) return []
      return (
        await withTimeout(
          extractContextSuggestions(message, null).catch(() => []),
          SUGGESTION_TIMEOUT_MS,
          []
        )
      ).filter((s) => s.type === 'memory')
    })()

    const taskProposals: PersistedTaskProposal[] = lookups.taskProposals.map((p: TaskProposal) => ({
      ...p,
      status: 'pending'
    }))
    const saved = await appendTurn(
      dir(),
      conversationId,
      {
        text: message,
        suggestions: suggestions.length > 0 ? suggestions : undefined,
        voiceNote,
        attachments: files.metadata.length > 0 ? files.metadata : undefined
      },
      {
        text: reply,
        citations: citations.length > 0 ? citations : undefined,
        taskProposals: taskProposals.length > 0 ? taskProposals : undefined
      }
    )
    // AUDIT FIX (2026-08-24) — the id comes from appendTurn, which minted it.
    // This was `saved.messages[saved.messages.length - 2]`, correct only
    // while the tail is a complete pair; if that ever broke it would silently
    // file a memory extracted from the USER's words under the ASSISTANT's
    // message id. See appendTurn's header and BUG-109.
    const savedUserId = saved?.userMessageId

    // M28 Phase 2 — the conversation feeds the Sales Brain like calls do.
    // Fire-and-forget (the coaching chat's exact precedent); the hook
    // re-reads BOTH permissions fresh (master flag + this conversation's
    // exclusion) at execution time, never from here.
    if (savedUserId) {
      void runMemoryExtractionForAssistantMessage(conversationId, savedUserId, message).catch(
        () => {}
      )
    }

    return {
      ok: true,
      reply,
      citations,
      suggestions,
      stopped: stopped || undefined,
      userMessageId: savedUserId
    }
  } finally {
    inFlight.delete(conversationId)
    // Terminal signal for renderers that mounted mid-stream: THEIR invoke()
    // promise belongs to a dead component instance, so this broadcast is how
    // a recovered view learns the turn settled (it re-reads the conversation;
    // deltas alone can't distinguish "quiet" from "done"). Fired on every
    // outcome — success, stop, cancel, failure — after any persistence.
    broadcast('assistant:turnComplete', { conversationId })
  }
}

export function registerAssistant(): void {
  ipcMain.handle('assistant:listConversations', () => listConversations(dir()))

  ipcMain.handle('assistant:getConversation', (_e, id: unknown) =>
    typeof id === 'string' ? getConversation(dir(), id) : null
  )

  // M28 Part 4 — an optional client scope, validated here (sanitizeScope)
  // before it becomes the conversation's identity.
  ipcMain.handle('assistant:createConversation', (_e, scope: unknown) =>
    createConversation(dir(), undefined, sanitizeScope(scope))
  )

  ipcMain.handle('assistant:renameConversation', (_e, id: unknown, title: unknown) =>
    typeof id === 'string' && typeof title === 'string'
      ? renameConversation(dir(), id, title)
      : null
  )

  ipcMain.handle('assistant:deleteConversation', async (_e, id: unknown) => {
    if (typeof id !== 'string') return false
    // Deleting the conversation also aborts any in-flight turn for it —
    // otherwise the stream would finish into a file that no longer exists.
    const turn = inFlight.get(id)
    if (turn) {
      turn.stopRequested = true
      turn.controller.abort()
    }
    // Best-effort cleanup of the voice notes this conversation references —
    // read before delete, remove after, so a failed delete leaks nothing.
    const conv = await getConversation(dir(), id)
    const deleted = await deleteConversation(dir(), id)
    if (deleted && conv) {
      for (const m of conv.messages) {
        if (m.voiceNote) await deleteVoiceNote(dir(), m.voiceNote.mediaId)
        for (const a of m.attachments ?? []) await deleteAttachment(dir(), a.id)
      }
    }
    return deleted
  })

  ipcMain.handle(
    'assistant:send',
    (
      _e,
      conversationId: unknown,
      message: unknown,
      voiceNote: unknown,
      attachmentIds: unknown
    ) => {
      const vn = (voiceNote && typeof voiceNote === 'object' ? voiceNote : null) as {
        mediaId?: unknown
        durationMs?: unknown
      } | null
      return handleSend(
        String(conversationId),
        String(message),
        vn && typeof vn.mediaId === 'string' && typeof vn.durationMs === 'number'
          ? { mediaId: vn.mediaId, durationMs: vn.durationMs }
          : undefined,
        Array.isArray(attachmentIds)
          ? attachmentIds.filter((x): x is string => typeof x === 'string')
          : []
      )
    }
  )

  // --- M28 Part 3: attachments (local-only until send) ---------------------
  // Validate + cap + extract + store; returns trusted metadata and an honest
  // "what will be sent" preview. Nothing reaches a provider until send().
  ipcMain.handle(
    'assistant:addAttachment',
    async (_e, name: unknown, bytes: unknown, conversationId: unknown) => {
      if (typeof name !== 'string' || !(bytes instanceof ArrayBuffer)) {
        return { ok: false, message: 'That file could not be read.' }
      }
      // AUDIT FIX (2026-08-24) — every attachment gets an owner at creation.
      if (typeof conversationId !== 'string' || !conversationId) {
        return { ok: false, message: 'That file could not be attached to this conversation.' }
      }
      const cap = Math.max(...Object.values(ATTACHMENT_LIMITS))
      if (bytes.byteLength > cap) {
        return { ok: false, message: `That file is larger than the ${Math.round(cap / (1024 * 1024))} MB limit.` }
      }
      return addAttachment(dir(), name, Buffer.from(bytes), conversationId)
    }
  )

  ipcMain.handle('assistant:discardAttachment', async (_e, id: unknown) => {
    if (typeof id === 'string') await deleteAttachment(dir(), id)
    return true
  })

  // --- M28 Phase 3: voice notes (record → transcribe → REVIEW → send) ------
  // Transcribe-and-store in one step; the renderer keeps its local blob, so
  // a failed transcription loses nothing (the user retries or types).
  // Nothing is attached to any message until the user actually sends.
  ipcMain.handle(
    'assistant:transcribeVoiceNote',
    async (
      _e,
      audio: unknown,
      mimeType: unknown,
      durationMs: unknown
    ): Promise<
      | { ok: true; text: string; mediaId: string; durationMs: number }
      | { ok: false; error: string; message: string }
    > => {
      if (!(audio instanceof ArrayBuffer) || audio.byteLength === 0) {
        return { ok: false, error: 'empty', message: 'Nothing was recorded.' }
      }
      if (audio.byteLength > MAX_VOICE_NOTE_BYTES) {
        return { ok: false, error: 'too-large', message: 'That recording is too long.' }
      }
      const mime = mimeType === 'audio/ogg' ? 'audio/ogg' : 'audio/webm'
      const buffer = Buffer.from(audio)
      const result = await transcribeVoiceNote(buffer, mime)
      if (!result.ok || !result.text) {
        return {
          ok: false,
          error: result.error ?? 'api',
          message: result.message ?? 'Transcription failed.'
        }
      }
      const mediaId = await saveVoiceNote(dir(), buffer, mime === 'audio/ogg' ? 'ogg' : 'webm')
      const duration =
        typeof durationMs === 'number' && Number.isFinite(durationMs)
          ? Math.max(0, durationMs)
          : 0
      return { ok: true, text: result.text, mediaId, durationMs: duration }
    }
  )

  // Composer cancel after a successful transcription — the stored audio is
  // orphaned and should not linger.
  ipcMain.handle('assistant:discardVoiceNote', async (_e, mediaId: unknown) => {
    if (typeof mediaId === 'string') await deleteVoiceNote(dir(), mediaId)
    return true
  })

  // Playback: the renderer builds a blob URL from these bytes.
  ipcMain.handle('assistant:getVoiceNote', async (_e, mediaId: unknown) => {
    if (typeof mediaId !== 'string') return null
    const buffer = await readVoiceNote(dir(), mediaId)
    if (!buffer) return null
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  })

  ipcMain.handle('assistant:cancel', (_e, conversationId: unknown) => {
    const turn = typeof conversationId === 'string' ? inFlight.get(conversationId) : undefined
    if (!turn) return false
    turn.stopRequested = true
    turn.controller.abort()
    return true
  })

  ipcMain.handle('assistant:attach', (_e, conversationId: unknown): AssistantAttachSnapshot => {
    const turn = typeof conversationId === 'string' ? inFlight.get(conversationId) : undefined
    return turn
      ? { streaming: true, accumulated: turn.accumulated, pendingUserText: turn.userText }
      : { streaming: false, accumulated: '', pendingUserText: '' }
  })

  ipcMain.handle(
    'assistant:applySuggestion',
    async (
      _e,
      conversationId: unknown,
      messageId: unknown,
      suggestion: CoachChatContextSuggestion
    ): Promise<{ ok: boolean }> => {
      try {
        if (typeof conversationId !== 'string' || typeof messageId !== 'string') return { ok: false }
        if (suggestion?.type !== 'memory') return { ok: false } // Phase 1: memory chips only on this surface
        if (!isSalesBrainEnabled() || !suggestion.memoryScope || !suggestion.memoryCategory) {
          return { ok: false }
        }
        // Foreground click — worth the ensureMemoryDb retry, unlike the
        // background hooks (memory-runtime.ts's own guidance).
        const db = getMemoryDb() ?? (await ensureMemoryDb()).db
        if (!db) return { ok: false }
        await consolidateNewCandidate(db, {
          scope: suggestion.memoryScope as MemoryScope,
          category: suggestion.memoryCategory as MemoryCategory,
          statement: suggestion.text,
          // Same synthetic-callId convention as onboarding ('onboarding:<topic>'):
          // the evidence traces to this conversation + message, not a call.
          evidence: [
            {
              type: 'transcript',
              callId: `assistant:${conversationId}`,
              chatMessageId: messageId,
              quote: suggestion.text
            }
          ],
          confidence: 0.95,
          importance: 6,
          source: 'user_stated'
        })
        await markSuggestionApplied(dir(), conversationId, messageId, suggestion.id)
        return { ok: true }
      } catch {
        return { ok: false }
      }
    }
  )

  // Confirm chip → the task is REALLY created (the only write this surface
  // performs besides memory chips, both user-confirmed). Accept-then-create:
  // acceptTaskProposal atomically claims the proposal under the conversation
  // lock (a double-click can't create twice); a create failure rolls it back.
  ipcMain.handle(
    'assistant:confirmTask',
    async (
      _e,
      conversationId: unknown,
      messageId: unknown,
      proposalId: unknown
    ): Promise<{ ok: boolean }> => {
      if (
        typeof conversationId !== 'string' ||
        typeof messageId !== 'string' ||
        typeof proposalId !== 'string'
      ) {
        return { ok: false }
      }
      const proposal = await acceptTaskProposal(dir(), conversationId, messageId, proposalId)
      if (!proposal) return { ok: false }
      try {
        await createTask(tasksDirPath(), {
          title: proposal.title,
          type: proposal.type,
          priority: proposal.priority,
          source: 'ai'
        })
        scheduleBackup()
        return { ok: true }
      } catch {
        await revertTaskProposal(dir(), conversationId, messageId, proposalId)
        return { ok: false }
      }
    }
  )

  // "Don't learn from this conversation" — mirrors the call-level exclusion
  // exactly (memory-center-ipc.ts's salesBrain:calls:setExcluded): setting it
  // ALSO retroactively deletes every memory this conversation taught, so
  // exclusion leaves zero trace. Turning it back off does not re-extract.
  ipcMain.handle(
    'assistant:setSalesBrainExcluded',
    async (
      _e,
      conversationId: unknown,
      excluded: unknown
    ): Promise<{ ok: boolean; message?: string }> => {
      if (typeof conversationId !== 'string' || typeof excluded !== 'boolean') return { ok: false }
      if (excluded) {
        // Audit fix (honesty): the pill's confirm promises "will be
        // forgotten" — if the memory store can't run the forget, FAIL CLOSED
        // (flag not set, error surfaced) rather than flipping the pill over
        // memories that quietly survive. Sales Brain OFF is fine: nothing
        // was ever stored, and extraction is master-gated anyway.
        const db = getMemoryDb() ?? (await ensureMemoryDb()).db
        if (isSalesBrainEnabled() && !db) {
          return {
            ok: false,
            message:
              'Sales Brain storage is unavailable, so what this conversation taught cannot be forgotten right now. Try again after restarting the app.'
          }
        }
        const conv = await setConversationSalesBrainExcluded(dir(), conversationId, true)
        if (!conv) return { ok: false }
        if (db) {
        // AUDIT FIX (2026-08-24) — evidence-level, not row-level. Deleting
        // every memory this source ever TOUCHED also destroyed what other
        // calls taught, because reinforcement stamps this source's callId
        // onto pre-existing rows. See forgetCallContribution.
          forgetCallContribution(db, `assistant:${conversationId}`)
        }
        return { ok: true }
      }
      const conv = await setConversationSalesBrainExcluded(dir(), conversationId, false)
      return { ok: conv !== null }
    }
  )

  // Citation tap → the evidence behind a memory: statement, status,
  // confidence, and every verbatim quote with its source call id. Read-only.
  ipcMain.handle('assistant:getMemoryEvidence', (_e, memoryId: unknown) => {
    if (typeof memoryId !== 'string' || !isSalesBrainEnabled()) return null
    const db = getMemoryDb()
    if (!db) return null
    const memory = getMemoryById(db, memoryId)
    if (!memory) return null
    return {
      id: memory.id,
      statement: memory.statement,
      status: memory.status,
      confidence: memory.confidence,
      category: memory.category,
      scope: memory.scope,
      evidence: memory.evidence
    }
  })

}
