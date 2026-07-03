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

// --- Coaching report (stored on the call, like a summary) -------------------

export type CoachDimensionKey =
  'discovery' | 'engagement' | 'objection' | 'value' | 'nextStep' | 'control'

/** A verbatim transcript span backing a score or note. */
export interface CoachEvidence {
  quote: string
  speaker: number
  /** True only when the quote was found in the transcript (anti-hallucination). */
  verified: boolean
}

export interface CoachDimension {
  key: CoachDimensionKey
  score: number // 1–5
  comment: string
  evidence?: CoachEvidence
}

export interface CoachImprovement {
  kind: 'mechanical' | 'strategic'
  title: string
  detail: string
  evidence?: CoachEvidence
}

/** Deterministic, locally-computed metrics shown beside the AI scores. */
export interface CoachMetrics {
  repSpeaker: number | null
  singleSpeaker: boolean
  talkRatio: number | null // 0–1, rep words ÷ total
  repWords: number
  totalWords: number
  longestMonologueWords: number
  longestMonologueMinutes: number | null
  questionCount: number
  wordsPerMinute: number | null
  turns: number
}

export interface CoachDealContext {
  type: 'transactional' | 'complex' | 'unknown'
  summary: string
  lens: string
}

export interface CoachingReport {
  overallScore: number // 0–100 (computed from the dimension scores)
  dealContext: CoachDealContext
  strength: { text: string; evidence?: CoachEvidence }
  dimensions: CoachDimension[]
  improvements: CoachImprovement[]
  nextAction: string
  metrics: CoachMetrics
  model: string
  createdAt: string
}

// --- Recording consent (stored on the call, like a summary) -----------------

export type ConsentStatus = 'not-asked' | 'disclosed' | 'consented' | 'declined'
export type ConsentJurisdiction = 'one-party' | 'two-party'
export type ConsentMethod = 'verbal-on-call' | 'pre-agreed' | 'written'

export interface ConsentRecord {
  status: ConsentStatus
  jurisdiction: ConsentJurisdiction
  /** How consent was obtained — only meaningful once `status` is 'consented'. */
  method?: ConsentMethod
  /**
   * Whether this call may record the OTHER party. HARD INVARIANT: only ever
   * true when `status === 'consented'`. This is the flag M12's buyer-audio
   * capture will gate on — "no consent = no capture". It is recomputed from
   * `status` in `sanitizeConsent` (never trusted from input) on every save AND
   * every read, so a hand-edited or malformed file can't grant capture.
   */
  recordOtherParty: boolean
  /** When the other party was informed (the disclosure was read). */
  disclosedAt?: string
  /** When they said yes / no. */
  decidedAt?: string
}

const CONSENT_STATUSES = new Set<ConsentStatus>(['not-asked', 'disclosed', 'consented', 'declined'])
const CONSENT_JURISDICTIONS = new Set<ConsentJurisdiction>(['one-party', 'two-party'])
const CONSENT_METHODS = new Set<ConsentMethod>(['verbal-on-call', 'pre-agreed', 'written'])

function isoOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : undefined
}

/** The safe default consent for any call (two-party = always prompt for consent). */
export function defaultConsent(): ConsentRecord {
  return { status: 'not-asked', jurisdiction: 'two-party', recordOtherParty: false }
}

/**
 * Coerce untrusted input (a renderer payload OR a parsed-from-disk record) into
 * a clean ConsentRecord, filling safe defaults for anything missing/malformed.
 *
 * THE INVARIANT: `recordOtherParty` is derived as
 *   status === 'consented' && input.recordOtherParty === true
 * so the ONLY way a saved call can permit recording the other party is to carry
 * an explicit 'consented' status. A hand-edited `recordOtherParty: true` paired
 * with any other status collapses to false here — on both save and read.
 */
export function sanitizeConsent(value: unknown): ConsentRecord {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>

  const status: ConsentStatus = CONSENT_STATUSES.has(v.status as ConsentStatus)
    ? (v.status as ConsentStatus)
    : 'not-asked'
  const jurisdiction: ConsentJurisdiction = CONSENT_JURISDICTIONS.has(
    v.jurisdiction as ConsentJurisdiction
  )
    ? (v.jurisdiction as ConsentJurisdiction)
    : 'two-party'
  const method = CONSENT_METHODS.has(v.method as ConsentMethod)
    ? (v.method as ConsentMethod)
    : undefined

  return {
    status,
    jurisdiction,
    method,
    // The hard invariant — computed from status, never trusted from input.
    recordOtherParty: status === 'consented' && v.recordOtherParty === true,
    disclosedAt: isoOrUndefined(v.disclosedAt),
    decidedAt: isoOrUndefined(v.decidedAt)
  }
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
  hasCoaching: boolean
  coachScore?: number // 0–100 overall, when coached
}

/** The full saved call (what's stored on disk). */
export interface Call extends CallBase {
  segments: CallSegment[]
  summary?: Summary
  attachments?: Attachment[]
  coaching?: CoachingReport
  /** Recording-consent record. Always present on calls saved from M11 on. */
  consent?: ConsentRecord
}

export interface CallSaveInput {
  startedAt: string
  durationMs: number
  segments: CallSegment[]
  /** Optional consent captured during the live session; defaulted if absent. */
  consent?: ConsentRecord
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
    attachmentCount: Array.isArray(call.attachments) ? call.attachments.length : 0,
    hasCoaching: Boolean(call.coaching),
    coachScore:
      typeof call.coaching?.overallScore === 'number' ? call.coaching.overallScore : undefined
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
    attachments: [],
    // Every call carries a consent record; the sanitizer enforces the invariant.
    consent: sanitizeConsent(input?.consent)
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
    const call = parsed as Call
    // Normalize consent on READ too, so the invariant holds even for old or
    // hand-edited files: a tampered `recordOtherParty: true` can't survive this.
    call.consent = sanitizeConsent(call.consent)
    return call
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

// --- Coaching ---------------------------------------------------------------

const DIMENSION_KEYS = new Set<CoachDimensionKey>([
  'discovery',
  'engagement',
  'objection',
  'value',
  'nextStep',
  'control'
])

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.max(min, Math.min(max, n))
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function sanitizeEvidence(value: unknown): CoachEvidence | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const quote = str(v.quote, 500).trim()
  if (!quote) return undefined
  return { quote, speaker: clampInt(v.speaker, 0, 1000, 0), verified: v.verified === true }
}

/** Coerce an untrusted object (an AI-built report) into a clean CoachingReport. */
export function sanitizeCoaching(value: unknown): CoachingReport | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>

  const dimensions: CoachDimension[] = []
  for (const d of Array.isArray(v.dimensions) ? v.dimensions : []) {
    if (!d || typeof d !== 'object') continue
    const dd = d as Record<string, unknown>
    if (typeof dd.key !== 'string' || !DIMENSION_KEYS.has(dd.key as CoachDimensionKey)) continue
    dimensions.push({
      key: dd.key as CoachDimensionKey,
      score: clampInt(dd.score, 1, 5, 3),
      comment: str(dd.comment, 1000),
      evidence: sanitizeEvidence(dd.evidence)
    })
  }
  if (dimensions.length === 0) return null // nothing usable to save

  const improvements: CoachImprovement[] = []
  for (const i of (Array.isArray(v.improvements) ? v.improvements : []).slice(0, 5)) {
    if (!i || typeof i !== 'object') continue
    const ii = i as Record<string, unknown>
    improvements.push({
      kind: ii.kind === 'strategic' ? 'strategic' : 'mechanical',
      title: str(ii.title, 300),
      detail: str(ii.detail, 1500),
      evidence: sanitizeEvidence(ii.evidence)
    })
  }

  const dc = (v.dealContext ?? {}) as Record<string, unknown>
  const strength = (v.strength ?? {}) as Record<string, unknown>
  const m = (v.metrics ?? {}) as Record<string, unknown>

  return {
    overallScore: clampInt(v.overallScore, 0, 100, 0),
    dealContext: {
      type: dc.type === 'transactional' || dc.type === 'complex' ? dc.type : 'unknown',
      summary: str(dc.summary, 500),
      lens: str(dc.lens, 200)
    },
    strength: { text: str(strength.text, 600), evidence: sanitizeEvidence(strength.evidence) },
    dimensions,
    improvements,
    nextAction: str(v.nextAction, 500),
    metrics: {
      repSpeaker: numOrNull(m.repSpeaker) === null ? null : clampInt(m.repSpeaker, 0, 1000, 0),
      singleSpeaker: m.singleSpeaker === true,
      talkRatio: numOrNull(m.talkRatio),
      repWords: clampInt(m.repWords, 0, 10_000_000, 0),
      totalWords: clampInt(m.totalWords, 0, 10_000_000, 0),
      longestMonologueWords: clampInt(m.longestMonologueWords, 0, 10_000_000, 0),
      longestMonologueMinutes: numOrNull(m.longestMonologueMinutes),
      questionCount: clampInt(m.questionCount, 0, 1_000_000, 0),
      wordsPerMinute: numOrNull(m.wordsPerMinute),
      turns: clampInt(m.turns, 0, 1_000_000, 0)
    },
    model: str(v.model, 64) || 'claude',
    createdAt:
      typeof v.createdAt === 'string' && !Number.isNaN(Date.parse(v.createdAt))
        ? v.createdAt
        : new Date().toISOString()
  }
}

export async function setCallCoaching(
  dir: string,
  callId: string,
  report: CoachingReport
): Promise<Call | null> {
  const call = await getCall(dir, callId)
  if (!call) return null
  const clean = sanitizeCoaching(report)
  if (!clean) return null // nothing usable to save — signal failure to the caller
  call.coaching = clean
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
