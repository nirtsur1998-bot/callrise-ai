import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface CallSegment {
  speaker: number
  text: string
}

export interface Summary {
  executive: string
  keyPoints: string[]
  actionItems: string[]
  questions: string[]
  model: string
  createdAt: string
}

export type AttachmentExt = 'pdf' | 'txt' | 'md' | 'docx'

export interface Attachment {
  id: string
  name: string
  ext: AttachmentExt
  sizeBytes: number
  addedAt: string
  summary?: Summary
}

interface CallBase {
  id: string
  title: string
  createdAt: string // ISO timestamp
  durationMs: number
  speakerCount: number
  preview: string
}

/** Lightweight item for the Past Calls list. */
export interface CallSummary extends CallBase {
  hasSummary: boolean
  attachmentCount: number
}

/** The full saved call (what's stored on disk). */
export interface Call extends CallBase {
  segments: CallSegment[]
  summary?: Summary
  attachments?: Attachment[]
}

export interface CallSaveInput {
  startedAt: string
  durationMs: number
  segments: CallSegment[]
}

// Ids are used to build file paths, so they must be tightly constrained
// (no "../", no slashes) to prevent path traversal.
const ID_RE = /^[A-Za-z0-9-]{1,64}$/
const MAX_SEGMENTS = 5000
const MAX_TEXT = 20000
const MAX_LIST_ITEMS = 200
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024 // 20 MB
const ALLOWED_EXT = new Set<AttachmentExt>(['pdf', 'txt', 'md', 'docx'])

export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id)
}

function formatTitle(date: Date): string {
  const when = date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
  return `Call · ${when}`
}

function sanitizeSegments(value: unknown): CallSegment[] {
  if (!Array.isArray(value)) return []
  const out: CallSegment[] = []
  for (const item of value.slice(0, MAX_SEGMENTS)) {
    if (!item || typeof item !== 'object') continue
    const speakerRaw = (item as { speaker?: unknown }).speaker
    const textRaw = (item as { text?: unknown }).text
    const speaker = Number.isFinite(speakerRaw) ? Math.max(0, Math.trunc(speakerRaw as number)) : 0
    const text = typeof textRaw === 'string' ? textRaw.slice(0, MAX_TEXT) : ''
    if (text.trim()) out.push({ speaker, text })
  }
  return out
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value.slice(0, MAX_LIST_ITEMS)) {
    if (typeof item === 'string' && item.trim()) out.push(item.slice(0, MAX_TEXT))
  }
  return out
}

/** Coerce an untrusted object (e.g. an AI response) into a clean Summary. */
export function sanitizeSummary(value: unknown): Summary | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const executive = typeof v.executive === 'string' ? v.executive.slice(0, MAX_TEXT) : ''
  const keyPoints = toStringArray(v.keyPoints)
  if (!executive && keyPoints.length === 0) return null
  return {
    executive,
    keyPoints,
    actionItems: toStringArray(v.actionItems),
    questions: toStringArray(v.questions),
    model: typeof v.model === 'string' ? v.model.slice(0, 64) : 'claude',
    createdAt:
      typeof v.createdAt === 'string' && !Number.isNaN(Date.parse(v.createdAt))
        ? v.createdAt
        : new Date().toISOString()
  }
}

function toSummary(call: Call): CallSummary {
  return {
    id: call.id,
    title: call.title,
    createdAt: call.createdAt,
    durationMs: call.durationMs,
    speakerCount: call.speakerCount,
    preview: call.preview,
    hasSummary: Boolean(call.summary),
    attachmentCount: Array.isArray(call.attachments) ? call.attachments.length : 0
  }
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

function filesDir(dir: string): string {
  return join(dir, 'files')
}

async function writeCall(dir: string, call: Call): Promise<void> {
  await fs.writeFile(join(dir, `${call.id}.json`), JSON.stringify(call, null, 2), 'utf8')
}

export async function saveCall(dir: string, input: CallSaveInput): Promise<CallSummary> {
  await ensureDir(dir)
  const segments = sanitizeSegments(input?.segments)
  const startedAt = typeof input?.startedAt === 'string' ? input.startedAt : ''
  const createdDate =
    startedAt && !Number.isNaN(Date.parse(startedAt)) ? new Date(startedAt) : new Date()
  const durationMs = Number.isFinite(input?.durationMs)
    ? Math.max(0, Math.trunc(input.durationMs))
    : 0
  const id = randomUUID()
  const transcriptText = segments.map((s) => s.text).join(' ')
  const call: Call = {
    id,
    title: formatTitle(createdDate),
    createdAt: createdDate.toISOString(),
    durationMs,
    speakerCount: new Set(segments.map((s) => s.speaker)).size,
    preview: transcriptText.slice(0, 160),
    segments,
    attachments: []
  }
  await writeCall(dir, call)
  return toSummary(call)
}

export async function listCalls(dir: string): Promise<CallSummary[]> {
  await ensureDir(dir)
  let files: string[]
  try {
    files = await fs.readdir(dir)
  } catch {
    return []
  }
  const summaries: CallSummary[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const raw = await fs.readFile(join(dir, file), 'utf8')
      const call = JSON.parse(raw) as Call
      if (call && typeof call.id === 'string') summaries.push(toSummary(call))
    } catch {
      /* skip unreadable / corrupt file */
    }
  }
  summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) // newest first
  return summaries
}

export async function getCall(dir: string, id: string): Promise<Call | null> {
  if (!isSafeId(id)) return null
  try {
    const raw = await fs.readFile(join(dir, `${id}.json`), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    // Guard the shape so a malformed file can't be corrupted by read-modify-write.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (typeof (parsed as { id?: unknown }).id !== 'string') return null
    return parsed as Call
  } catch {
    return null
  }
}

export async function deleteCall(dir: string, id: string): Promise<{ ok: boolean }> {
  if (!isSafeId(id)) return { ok: false }
  const call = await getCall(dir, id)
  // Remove the call record first, so a later failure leaves a re-deletable state.
  try {
    await fs.unlink(join(dir, `${id}.json`))
  } catch {
    return { ok: false }
  }
  // The call is gone — best-effort clean up its attachment files.
  for (const att of call?.attachments ?? []) {
    await fs.unlink(join(filesDir(dir), `${att.id}.${att.ext}`)).catch(() => {})
  }
  return { ok: true }
}

// --- AI summaries -----------------------------------------------------------

export async function setCallSummary(
  dir: string,
  callId: string,
  summary: Summary
): Promise<Call | null> {
  const call = await getCall(dir, callId)
  if (!call) return null
  const clean = sanitizeSummary(summary)
  if (!clean) return null // nothing usable to save — signal failure to the caller
  call.summary = clean
  await writeCall(dir, call)
  return call
}

export async function setAttachmentSummary(
  dir: string,
  callId: string,
  attachmentId: string,
  summary: Summary
): Promise<Call | null> {
  if (!isSafeId(attachmentId)) return null
  const call = await getCall(dir, callId)
  if (!call) return null
  const att = (call.attachments ?? []).find((a) => a.id === attachmentId)
  if (!att) return null
  const clean = sanitizeSummary(summary)
  if (!clean) return null // nothing usable to save — signal failure to the caller
  att.summary = clean
  await writeCall(dir, call)
  return call
}

// --- Attachments ------------------------------------------------------------

export interface AddAttachmentInput {
  name: unknown
  ext: unknown
  bytes: Uint8Array
}

export type AddAttachmentResult =
  | { ok: true; attachment: Attachment }
  | { ok: false; error: 'not-found' | 'unsupported-type' | 'empty' | 'too-large' }

export async function addAttachment(
  dir: string,
  callId: string,
  input: AddAttachmentInput
): Promise<AddAttachmentResult> {
  const call = await getCall(dir, callId)
  if (!call) return { ok: false, error: 'not-found' }

  const ext = typeof input?.ext === 'string' ? input.ext.toLowerCase().replace(/^\./, '') : ''
  if (!ALLOWED_EXT.has(ext as AttachmentExt)) return { ok: false, error: 'unsupported-type' }

  const bytes = input?.bytes
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return { ok: false, error: 'empty' }
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) return { ok: false, error: 'too-large' }

  const id = randomUUID()
  await ensureDir(filesDir(dir))
  await fs.writeFile(join(filesDir(dir), `${id}.${ext}`), Buffer.from(bytes))

  const rawName = typeof input?.name === 'string' ? input.name : `file.${ext}`
  const attachment: Attachment = {
    id,
    name: rawName.replace(/[\r\n]/g, ' ').slice(0, 200),
    ext: ext as AttachmentExt,
    sizeBytes: bytes.byteLength,
    addedAt: new Date().toISOString()
  }
  call.attachments = Array.isArray(call.attachments) ? call.attachments : []
  call.attachments.push(attachment)
  try {
    await writeCall(dir, call)
  } catch (err) {
    // Don't orphan the file we just wrote if recording its metadata failed.
    await fs.unlink(join(filesDir(dir), `${id}.${ext}`)).catch(() => {})
    throw err
  }
  return { ok: true, attachment }
}

export async function removeAttachment(
  dir: string,
  callId: string,
  attachmentId: string
): Promise<{ ok: boolean }> {
  if (!isSafeId(attachmentId)) return { ok: false }
  const call = await getCall(dir, callId)
  if (!call) return { ok: false }
  const att = (call.attachments ?? []).find((a) => a.id === attachmentId)
  if (att) {
    try {
      await fs.unlink(join(filesDir(dir), `${att.id}.${att.ext}`))
    } catch {
      /* ignore missing file */
    }
  }
  call.attachments = (call.attachments ?? []).filter((a) => a.id !== attachmentId)
  try {
    await writeCall(dir, call)
  } catch {
    return { ok: false }
  }
  return { ok: true }
}

/** Read an attachment's bytes (for summarization). */
export async function readAttachment(
  dir: string,
  callId: string,
  attachmentId: string
): Promise<{ bytes: Buffer; ext: AttachmentExt; name: string } | null> {
  if (!isSafeId(attachmentId)) return null
  const call = await getCall(dir, callId)
  if (!call) return null
  const att = (call.attachments ?? []).find((a) => a.id === attachmentId)
  if (!att) return null
  try {
    const bytes = await fs.readFile(join(filesDir(dir), `${att.id}.${att.ext}`))
    return { bytes, ext: att.ext, name: att.name }
  } catch {
    return null
  }
}
