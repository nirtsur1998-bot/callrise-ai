import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeJsonAtomic } from './atomic-write'
import { sanitizeCommitments } from './commitments'

export interface CallSegment {
  speaker: number
  text: string
  /** Which capture channel this came from: 0 = the rep's mic, 1 = the other
   *  party's loopback. Undefined for mono (mic-only) calls and for anything
   *  saved before this existed.
   *
   *  Present because `speaker` ALONE is ambiguous. In mono it is a diarized
   *  guess; in multichannel it is the channel index — so "speaker 0" means two
   *  different people either side of a mid-call switch to buyer capture, and a
   *  saved transcript could not tell you which. Identity is the PAIR. */
  channel?: number
  /** A `[gap: Ns]` marker rather than someone's words — audio that was shed,
   *  discarded to rejoin the live edge, or lost to a suspend. Marked so it is
   *  never counted as a speaker and never attributed to anyone. */
  kind?: 'gap'
}

// --- Speaker identification (M19 Task 2) ------------------------------------

/** Same compound key every consumer uses: `channel` present -> multichannel
 *  (`ch0/spk0`, `ch1/spk1`); absent -> mono/diarized (`mono/spk0`, ...).
 *  MUST stay byte-identical to the renderer's speakerKey() in
 *  src/renderer/src/features/live/segments.ts — main can't import renderer
 *  code, so this is a deliberate duplicate, not an independent design. */
export function speakerIdentityKey(seg: { speaker: number; channel?: number }): string {
  return seg.channel === undefined ? `mono/spk${seg.speaker}` : `ch${seg.channel}/spk${seg.speaker}`
}

export type SpeakerIdentitySource =
  | 'user-profile'
  | 'calendar'
  | 'contact'
  | 'participant-list'
  | 'self-intro'
  | 'voice-profile'
  | 'manual'

export type SpeakerIdentityConfidence = 'high' | 'medium' | 'low'

/** One resolved name for one speakerIdentityKey, for one call. Rename is
 *  ALWAYS a `source: 'manual'` write to this record — never a string
 *  replace inside stored transcript/summary/coaching text, which stays
 *  purely numeric (`speaker`/`repSpeaker`) and resolves a display name only
 *  at render time (see speakerLabel() in the renderer). That's what makes
 *  rename retroactive and cheap: editing this one small record instantly
 *  changes every past AND future render of this call, with zero risk of
 *  missing a surface that baked the old name into generated prose. */
export interface SpeakerIdentityRecord {
  name: string
  source: SpeakerIdentitySource
  confidence: SpeakerIdentityConfidence
  /** The contact this identity is linked to, if resolved via (or "remember
   *  this person"-linked to) one. Lets a rename optionally update the
   *  contact's own name too, and lets future calls with the same contact
   *  resolve instantly without re-running the cascade. */
  contactId?: string
  resolvedAt: string
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

// --- Commitments (§4.7 — who promised what) ---------------------------------

export type CommitmentOwner = 'rep' | 'prospect'

export interface Commitment {
  owner: CommitmentOwner
  /** What was promised, in the promiser's own terms. */
  text: string
  /** ISO date, only when a date was actually stated. */
  dueDate?: string
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

/** A moment the rep bookmarked mid-call ("clip this") — a timestamp + the
 *  transcript text at that point, so it's findable later without re-reading
 *  the whole call. */
export interface Bookmark {
  id: string
  /** Milliseconds from the start of the call. */
  atMs: number
  text: string
  createdAt: string
}

interface CallBase {
  id: string
  title: string
  createdAt: string // ISO timestamp
  /** Last modification (save or any edit), ISO timestamp — the ordering key a
   *  future cloud backup uses for "newest wins". Backfilled from createdAt for
   *  calls saved before this field existed. */
  updatedAt: string
  durationMs: number
  speakerCount: number
  preview: string
  /** The contact this call is linked to (manual, or confirmed from a calendar
   *  match) — the CRM foundation's call-history link. */
  contactId?: string
}

/** Lightweight item for the Past Calls list. */
export interface CallSummary extends CallBase {
  hasSummary: boolean
  attachmentCount: number
  hasCoaching: boolean
  coachScore?: number // 0–100 overall, when coached
  /** True once this call has been read for Objection Library mining (auto on
   *  save, or via the manual "scan past calls" trigger) — lets both skip
   *  calls they've already processed. */
  objectionsMined: boolean
}

/** The full saved call (what's stored on disk). */
export interface Call extends CallBase {
  segments: CallSegment[]
  summary?: Summary
  attachments?: Attachment[]
  coaching?: CoachingReport
  /** Who promised what (§4.7) — the last extraction run on this call, if any.
   *  Not synced to cloud backup (see `callBackupPayload`): unlike coaching's
   *  scores/advice, this hasn't been reviewed for what counts as safe to leave
   *  the device, so it stays local-only until that's deliberately decided. */
  commitments?: Commitment[]
  /** Recording-consent record. Always present on calls saved from M11 on. */
  consent?: ConsentRecord
  /** When this call was last read for Objection Library mining, if ever. */
  objectionsMinedAt?: string
  /** Tombstone: a deleted call is kept as a minimal record (transcript dropped)
   *  so the deletion can propagate to a future cloud backup. Hidden everywhere. */
  deleted?: boolean
  bookmarks?: Bookmark[]
  /** When an AI CRM note was auto-drafted from this call, if ever — prevents
   *  double-drafting when both the contact-link and the summary land (in
   *  either order) with Settings → CRM → "Auto-generate notes" on. */
  crmNoteGeneratedAt?: string
  /** M19 Task 2 — resolved speaker names, keyed by speakerIdentityKey().
   *  Absent/missing key = unresolved, falls back to the existing You/Buyer/
   *  Speaker N logic. Never required, never migrated — old calls simply have
   *  no entries here and behave exactly as before this field existed. */
  speakerIdentities?: Record<string, SpeakerIdentityRecord>
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
    const isGap = (item as { kind?: unknown }).kind === 'gap'
    const channelRaw = (item as { channel?: unknown }).channel
    const channel = channelRaw === 0 || channelRaw === 1 ? (channelRaw as 0 | 1) : undefined
    if (!text.trim()) continue
    const seg: CallSegment = isGap ? { speaker, text, kind: 'gap' } : { speaker, text }
    if (channel !== undefined) seg.channel = channel
    out.push(seg)
  }
  return out
}

/**
 * Only the segments that are somebody's words.
 *
 * Gap markers are a transcript-integrity feature, not content: they must be
 * stored and shown, but they are nobody's speech. Anything that counts words,
 * measures talk ratio, identifies a speaker, verifies a quote, or prompts a
 * model has to see through them — otherwise `[gap: 34s]` becomes three words
 * spoken by speaker 0, quietly skewing every derived metric.
 */
export function speechSegments(segments: CallSegment[] | undefined): CallSegment[] {
  return (segments ?? []).filter((s) => s.kind !== 'gap')
}

/** Speakers actually present, ignoring gap markers (which belong to nobody). */
function countSpeakers(segments: CallSegment[]): number {
  return new Set(speechSegments(segments).map((s) => s.speaker)).size
}

const MAX_BOOKMARKS = 500
const MAX_BOOKMARK_TEXT = 2000

function sanitizeBookmarks(value: unknown): Bookmark[] {
  if (!Array.isArray(value)) return []
  const out: Bookmark[] = []
  for (const item of value.slice(0, MAX_BOOKMARKS)) {
    if (!item || typeof item !== 'object') continue
    const v = item as Record<string, unknown>
    const id = isSafeId(v.id) ? v.id : randomUUID()
    const atMs = Number.isFinite(v.atMs) ? Math.max(0, Math.trunc(v.atMs as number)) : 0
    const text = typeof v.text === 'string' ? v.text.slice(0, MAX_BOOKMARK_TEXT) : ''
    const createdAt = isoOrUndefined(v.createdAt) ?? new Date().toISOString()
    if (text.trim()) out.push({ id, atMs, text, createdAt })
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
    updatedAt: isoOrUndefined(call.updatedAt) ?? call.createdAt, // backfill for old calls
    durationMs: call.durationMs,
    speakerCount: call.speakerCount,
    preview: call.preview,
    contactId: isSafeId(call.contactId) ? call.contactId : undefined,
    hasSummary: Boolean(call.summary),
    attachmentCount: Array.isArray(call.attachments) ? call.attachments.length : 0,
    hasCoaching: Boolean(call.coaching),
    coachScore:
      typeof call.coaching?.overallScore === 'number' ? call.coaching.overallScore : undefined,
    objectionsMined: typeof call.objectionsMinedAt === 'string'
  }
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

function filesDir(dir: string): string {
  return join(dir, 'files')
}

/** Where a given attachment's blob lives on disk — exported for the (opt-in)
 *  attachment-sync path in backup.ts, which needs the local path to upload
 *  from and to write a downloaded blob back to. */
export function attachmentBlobPath(dir: string, attachmentId: string, ext: string): string {
  return join(filesDir(dir), `${attachmentId}.${ext}`)
}

async function writeCall(dir: string, call: Call): Promise<void> {
  await writeJsonAtomic(join(dir, `${call.id}.json`), call)
}

// Multichannel: the other party's turns ride on channel 1, a hardware/
// loopback fact fixed at capture time — never a guess. Mono has no such fixed
// mapping; see isOtherPartyKey/isOtherPartySegment below.
const BUYER_SPEAKER = 1

/** A speakerIdentityKey's trailing `spk{N}` number, or null if it doesn't
 *  parse (defensive — a malformed/hand-edited key should never crash this). */
function speakerNumberFromKey(key: string): number | null {
  const m = /spk(\d+)$/.exec(key)
  return m ? Number(m[1]) : null
}

/**
 * True when `n` is the OTHER party's speaker number and must be stripped
 * absent consent. Multichannel is a fixed hardware fact (channel 1 is always
 * the buyer). Mono has no such fixed mapping — `speaker` is a diarized guess
 * (see CallSegment.channel's own doc comment), and which number is the rep
 * is only known once coaching sets repSpeaker (it can legitimately resolve to
 * either 0 or 1). Until then, conservatively assume rep === 0 (the common
 * case) so an unconsented second voice is never wrongly kept just because
 * coaching hasn't finished yet — "no consent = no capture" errs toward
 * stripping too much, never too little.
 */
function isOtherPartySpeaker(n: number, multichannel: boolean, repSpeaker: number | null): boolean {
  return multichannel ? n === BUYER_SPEAKER : n !== (repSpeaker ?? 0)
}

/**
 * Recording-consent RETENTION guard (M12 Step 6, extended M19 Task 2). Buyer
 * capture only ever runs after consent (status becomes 'consented'); if
 * recording the other party isn't (still) permitted (recordOtherParty !==
 * true — e.g. "turn recording off", a mid-call decline, or a file tampered
 * to drop the flag), the other party's captured turns are removed — AND, as
 * of M19, their resolved NAME too (speakerIdentities). A revoked call with
 * its transcript stripped but the buyer's real name still attached would
 * violate the exact invariant this function exists to enforce: a name is
 * personal data same as the words themselves. Runs on save AND read AND
 * list, so a revoked/hand-edited call can never surface either.
 *
 * A call can mix mono and channel-tagged segments (the mid-call "enable buyer
 * capture" switch) — each key/segment is judged by ITS OWN regime, via the
 * `mono/` key prefix or CallSegment.channel's presence, never by a single
 * call-wide flag (that sticky-flag mistake is exactly what resolve-for-call.ts's
 * own regime detection was separately fixed to avoid).
 */
function applyConsentRetention(call: Call): void {
  const c = call.consent
  // Keyed purely on the sanitized recordOtherParty flag, NOT on status: a call
  // can go consented → revoked/declined within one session AFTER buyer turns
  // were captured, so the current status must never short-circuit the strip.
  if (!c || c.recordOtherParty === true) return
  const repSpeaker = call.coaching?.metrics.repSpeaker ?? null

  if (call.speakerIdentities) {
    const keys = Object.keys(call.speakerIdentities)
    const keptKeys = keys.filter((k) => {
      const n = speakerNumberFromKey(k)
      if (n === null) return true // malformed key — nothing to strip, keep as-is
      return !isOtherPartySpeaker(n, !k.startsWith('mono/'), repSpeaker)
    })
    if (keptKeys.length !== keys.length) {
      const next: Record<string, SpeakerIdentityRecord> = {}
      for (const k of keptKeys) next[k] = call.speakerIdentities[k]
      call.speakerIdentities = next
    }
  }

  if (!Array.isArray(call.segments)) return
  // A gap marker is not the buyer's speech — it belongs to nobody, so it
  // survives the strip regardless of the speaker id it happens to carry.
  const kept = call.segments.filter(
    (s) => s.kind === 'gap' || !isOtherPartySpeaker(s.speaker, s.channel !== undefined, repSpeaker)
  )
  if (kept.length === call.segments.length) return
  call.segments = kept
  call.preview = speechSegments(kept)
    .map((s) => s.text)
    .join(' ')
    .slice(0, 160)
  call.speakerCount = countSpeakers(kept)
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
  const transcriptText = speechSegments(segments)
    .map((s) => s.text)
    .join(' ')
  const call: Call = {
    id,
    title: formatTitle(createdDate),
    createdAt: createdDate.toISOString(),
    updatedAt: createdDate.toISOString(), // equals createdAt at birth; bumped on edits
    durationMs,
    speakerCount: countSpeakers(segments),
    preview: transcriptText.slice(0, 160),
    segments,
    attachments: [],
    // Every call carries a consent record; the sanitizer enforces the invariant.
    consent: sanitizeConsent(input?.consent)
  }
  // Drop the other party's turns if recording them isn't (still) consented.
  applyConsentRetention(call)
  await writeCall(dir, call)
  return toSummary(call)
}

export async function listCalls(
  dir: string,
  opts?: { includeDeleted?: boolean }
): Promise<CallSummary[]> {
  await ensureDir(dir)
  let files: string[]
  try {
    files = await fs.readdir(dir)
  } catch {
    return []
  }
  // Reads run concurrently — one file's disk I/O never waits on another's, and
  // order doesn't matter here since the result is sorted below regardless.
  const results = await Promise.all(
    files
      .filter((file) => file.endsWith('.json'))
      .map(async (file): Promise<CallSummary | null> => {
        try {
          const raw = await fs.readFile(join(dir, file), 'utf8')
          const call = JSON.parse(raw) as Call
          // Tombstones stay hidden from the app; the backup reads them via includeDeleted.
          if (call && typeof call.id === 'string' && (opts?.includeDeleted || !call.deleted)) {
            // Normalize consent + strip unconsented buyer turns so the list preview
            // and speaker count never surface the other party's words either.
            call.consent = sanitizeConsent(call.consent)
            applyConsentRetention(call)
            return toSummary(call)
          }
          return null
        } catch {
          return null // skip unreadable / corrupt file
        }
      })
  )
  const summaries = results.filter((s): s is CallSummary => s !== null)
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
    if (call.deleted === true) return null // a tombstone reads as "gone"
    // Backfill updatedAt for calls saved before the field existed, so it's never
    // missing downstream (a future backup keys "newest wins" off it).
    call.updatedAt = isoOrUndefined(call.updatedAt) ?? call.createdAt
    // Normalize consent on READ too, so the invariant holds even for old or
    // hand-edited files: a tampered `recordOtherParty: true` can't survive this.
    call.consent = sanitizeConsent(call.consent)
    // ...and drop the other party's turns if recording them isn't consented.
    applyConsentRetention(call)
    return call
  } catch {
    return null
  }
}

export async function deleteCall(dir: string, id: string): Promise<{ ok: boolean }> {
  // Same read-tombstone-write shape as the mutators below (getCall -> build a
  // new record -> writeCall), so it races with them the same way; serialize
  // it through the same per-call lock.
  return withCallLock(id, async () => {
    const call = await getCall(dir, id)
    if (!call) return { ok: false } // missing or already a tombstone
    // Best-effort remove the attachment blobs (local-only, never backed up — free
    // the disk; the call is gone from the UI regardless).
    for (const att of call.attachments ?? []) {
      await fs.unlink(join(filesDir(dir), `${att.id}.${att.ext}`)).catch(() => {})
    }
    // Tombstone instead of erase: keep an id + timestamp so the deletion can
    // propagate to a future cloud backup, but DROP the transcript, coaching, and
    // attachment metadata (privacy — a deleted call must not retain buyer words —
    // and space). The record reads as "gone" everywhere (getCall/listCalls).
    const tombstone: Call = {
      id: call.id,
      title: call.title,
      createdAt: call.createdAt,
      updatedAt: new Date().toISOString(),
      durationMs: call.durationMs,
      speakerCount: 0,
      preview: '',
      segments: [],
      attachments: [],
      consent: call.consent,
      deleted: true
    }
    try {
      await writeCall(dir, tombstone)
    } catch {
      return { ok: false }
    }
    return { ok: true }
  })
}

// --- Cloud backup (M16): privacy-stripped payload + id-preserving restore -----

/**
 * Strip a call down to ONLY what may leave the device for the cloud mirror:
 * metadata + the AI summary + coaching SCORES/ADVICE. It NEVER includes:
 *   - `segments` — THE TRANSCRIPT (verbatim rep + buyer words) → forced to []
 *   - `preview` — transcript-derived text → forced to ''
 *   - coaching `evidence` — verbatim buyer/rep quotes → the whole evidence object
 *     is dropped from strength / every dimension / every improvement
 *   - attachment file contents and their AI summaries → only name/size metadata
 * Pure + unit-provable; this function is the privacy guarantee for the push.
 */
export function callBackupPayload(call: Call): Record<string, unknown> {
  const c = call.coaching
  const coaching = c
    ? {
        overallScore: c.overallScore,
        dealContext: c.dealContext,
        // Quote-free: keep the score/comment, DROP the verbatim `evidence`.
        strength: { text: c.strength.text },
        dimensions: c.dimensions.map((d) => ({ key: d.key, score: d.score, comment: d.comment })),
        improvements: c.improvements.map((i) => ({
          kind: i.kind,
          title: i.title,
          detail: i.detail
        })),
        nextAction: c.nextAction,
        metrics: c.metrics,
        model: c.model,
        createdAt: c.createdAt
      }
    : undefined
  return {
    id: call.id,
    title: call.title,
    createdAt: call.createdAt,
    updatedAt: call.updatedAt,
    durationMs: call.durationMs,
    speakerCount: call.speakerCount,
    preview: '', // transcript-derived — never leaves the device
    segments: [], // THE TRANSCRIPT — never leaves the device
    summary: call.summary, // AI paraphrase; synced per the privacy decision
    coaching,
    // CRM link + mined marker are plain metadata; without them a pull that
    // finds a newer cloud row would silently erase the call→contact link and
    // re-mine the call (duplicate objection suggestions). `null` (vs absent)
    // means "explicitly unlinked", so old rows without the field can't wipe
    // a local link.
    contactId: call.contactId ?? null,
    // Resolved/renamed speaker names — plain metadata like contactId, not
    // transcript content, so it's safe in the default (non-transcript) sync
    // scope too. Caller (listCallsForBackup) already ran applyConsentRetention
    // on this call, so a buyer's name here is only ever present when consent
    // actually permits it — same guarantee `segments`/`preview` rely on
    // upstream rather than re-filtering redundantly here.
    speakerIdentities: call.speakerIdentities ?? {},
    objectionsMinedAt: call.objectionsMinedAt,
    // Attachment metadata only (name/size) so the list shows; NOT file contents
    // (local-only) nor the AI summary of the attached document.
    attachments: (call.attachments ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      ext: a.ext,
      sizeBytes: a.sizeBytes,
      addedAt: a.addedAt
    })),
    consent: call.consent,
    ...(call.deleted ? { deleted: true } : {})
  }
}

/**
 * FULL payload — used ONLY when the user has explicitly opted into syncing
 * call recordings & transcripts (Settings → Privacy & data's sync-scope
 * toggle, off by default). Same shape as callBackupPayload but restores the
 * transcript and the coaching evidence quotes it strips. Attachment file
 * BYTES still never travel in this JSON payload — those go through Storage
 * separately, gated by their own toggle.
 */
export function callFullBackupPayload(call: Call): Record<string, unknown> {
  return {
    ...callBackupPayload(call),
    preview: call.preview,
    segments: call.segments,
    coaching: call.coaching,
    // Bookmarks are transcript excerpts, same sensitivity as segments — only
    // included under this same opt-in transcripts scope, never the default.
    bookmarks: call.bookmarks
  }
}

/** All calls for the backup push — full records INCLUDING tombstones (so
 *  deletions propagate). Consent is normalized + unconsented buyer turns
 *  stripped on read (defense in depth); the payload builder then removes ALL
 *  segments regardless, so no transcript can ever reach the row. */
export async function listCallsForBackup(dir: string): Promise<Call[]> {
  await ensureDir(dir)
  let files: string[]
  try {
    files = await fs.readdir(dir)
  } catch {
    return []
  }
  const calls: Call[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(await fs.readFile(join(dir, file), 'utf8')) as Call
      if (!parsed || typeof parsed.id !== 'string') continue
      parsed.updatedAt = isoOrUndefined(parsed.updatedAt) ?? parsed.createdAt
      parsed.consent = sanitizeConsent(parsed.consent)
      applyConsentRetention(parsed)
      calls.push(parsed)
    } catch {
      /* skip unreadable / corrupt file */
    }
  }
  return calls
}

function sanitizeBackupAttachment(value: unknown): Attachment | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (!isSafeId(v.id)) return null
  const ext = typeof v.ext === 'string' ? v.ext.toLowerCase() : ''
  if (!ALLOWED_EXT.has(ext as AttachmentExt)) return null
  return {
    id: v.id,
    name: typeof v.name === 'string' ? v.name.replace(/[\r\n]/g, ' ').slice(0, 200) : `file.${ext}`,
    ext: ext as AttachmentExt,
    sizeBytes: Number.isFinite(v.sizeBytes) ? Math.max(0, Math.trunc(v.sizeBytes as number)) : 0,
    addedAt: isoOrUndefined(v.addedAt) ?? new Date().toISOString()
    // no `summary` — the AI summary of the attached doc never leaves the device
  }
}

/**
 * ID-PRESERVING restore importer for calls. Keeps the cloud id (idempotent
 * re-pulls) and re-runs every sub-sanitizer (a tampered cloud payload can't
 * plant an unsafe id/path or malformed data).
 *
 * UNLIKE tasks/events, the call cloud payload is a deliberately LOSSY
 * projection — it never carries the transcript, preview, or attachment AI
 * summaries (the privacy guarantee). So this importer MERGES onto the current
 * on-disk record instead of replacing it: those local-only fields are always
 * preserved from THIS machine's copy, never taken from (or blanked by) the
 * cloud row. Blindly replacing the whole record — as a full-mirror importer
 * would — silently and permanently erases the transcript and attachment
 * summaries on this machine the next time a merely-unrelated cloud edit (e.g.
 * a coaching update pushed from another device) is newer than this call's
 * local `updatedAt`, since the cloud never had that data to restore.
 *
 * A cloud TOMBSTONE (`deleted: true`) is the one case that must NOT preserve
 * local data — it becomes a real local tombstone (no transcript, no
 * attachments), matching what a local `deleteCall` produces.
 *
 * `onlyIfNewer` skips the import unless the incoming version is strictly newer
 * than what's on disk, so a mid-restore local edit/delete is never clobbered
 * by stale cloud data.
 */
/** Defensive validation of an incoming (untrusted, cloud-origin) speakerIdentities
 *  map — same validation setSpeakerIdentity applies to a single write, just
 *  looped over a whole object instead of trusting the payload's shape. */
function sanitizeIncomingSpeakerIdentities(value: unknown): Record<string, SpeakerIdentityRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, SpeakerIdentityRecord> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!SPEAKER_KEY_RE.test(key)) continue
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const name = typeof r.name === 'string' ? r.name.trim().slice(0, MAX_SPEAKER_NAME) : ''
    if (!name) continue
    const source = SOURCES.includes(r.source as SpeakerIdentitySource)
      ? (r.source as SpeakerIdentitySource)
      : 'manual'
    const confidence = CONFIDENCES.includes(r.confidence as SpeakerIdentityConfidence)
      ? (r.confidence as SpeakerIdentityConfidence)
      : 'high'
    const contactId = isSafeId(r.contactId) ? r.contactId : undefined
    const resolvedAt = isoOrUndefined(r.resolvedAt) ?? new Date(0).toISOString()
    out[key] = { name, source, confidence, contactId, resolvedAt }
  }
  return out
}

/** Reconciles local vs. cloud speakerIdentities key-by-key rather than one
 *  side blanket-winning (the "local copy always wins when it exists" rule
 *  segments/bookmarks use above is wrong here, since a REMOTE rename made on
 *  a different device is real, wanted data, not stale backlog): a MANUAL
 *  rename on either side is never silently overwritten — mirrors
 *  setSpeakerIdentity's own skipIfManual guarantee — and otherwise whichever
 *  entry resolved more recently wins. */
function mergeSpeakerIdentities(
  local: Record<string, SpeakerIdentityRecord> | undefined,
  cloud: Record<string, SpeakerIdentityRecord>
): Record<string, SpeakerIdentityRecord> | undefined {
  const keys = new Set([...Object.keys(local ?? {}), ...Object.keys(cloud)])
  if (keys.size === 0) return undefined
  const merged: Record<string, SpeakerIdentityRecord> = {}
  for (const key of keys) {
    const l = local?.[key]
    const cRec = cloud[key]
    if (l && !cRec) merged[key] = l
    else if (cRec && !l) merged[key] = cRec
    else if (l && cRec) {
      if (l.source === 'manual' && cRec.source !== 'manual') merged[key] = l
      else if (cRec.source === 'manual' && l.source !== 'manual') merged[key] = cRec
      else merged[key] = Date.parse(cRec.resolvedAt) > Date.parse(l.resolvedAt) ? cRec : l
    }
  }
  return merged
}

export async function importCall(
  dir: string,
  payload: unknown,
  opts?: { onlyIfNewer?: boolean }
): Promise<Call | null> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const v = payload as Record<string, unknown>
  if (!isSafeId(v.id)) return null
  const id = v.id // narrowed to string by isSafeId; captured so it survives the closure below

  // Same read-merge-write shape as the mutators below; serialize per call id so
  // a restore pass can't race a concurrent setCallSummary/addAttachment/etc.
  // (or another restore) for the same call.
  return withCallLock(id, async () => {
    const createdAt = isoOrUndefined(v.createdAt) ?? new Date().toISOString()
    const updatedAt = isoOrUndefined(v.updatedAt) ?? createdAt

    // Always read the current on-disk record (raw — a tombstone included) so a
    // genuine import can MERGE onto it rather than replace it wholesale.
    let current: Call | null = null
    try {
      const parsed = JSON.parse(await fs.readFile(join(dir, `${id}.json`), 'utf8')) as Call
      if (parsed && typeof parsed.id === 'string') current = parsed
    } catch {
      /* no current record — this is a genuinely new call being restored */
    }

    if (opts?.onlyIfNewer && current) {
      const curU = isoOrUndefined(current.updatedAt) ?? current.createdAt
      if (Date.parse(curU) >= Date.parse(updatedAt)) return null // local is same-or-newer
    }

    const deleted = v.deleted === true
    const title = typeof v.title === 'string' && v.title.trim() ? v.title.slice(0, 300) : 'Call'

    // A cloud tombstone becomes a REAL local tombstone (no transcript/
    // attachments) — never resurrect local data into a "deleted" record.
    let attachments: Attachment[] = []
    if (!deleted) {
      const incoming: Attachment[] = Array.isArray(v.attachments)
        ? v.attachments
            .slice(0, MAX_LIST_ITEMS)
            .map(sanitizeBackupAttachment)
            .filter((a): a is Attachment => a !== null)
        : []
      // Merge: an attachment's `summary` (an AI document summary — costs a
      // Claude API call, and never leaves the device) is preserved from the
      // matching LOCAL attachment id; the cloud's metadata otherwise wins.
      const currentAttById = new Map((current?.attachments ?? []).map((a) => [a.id, a]))
      attachments = incoming.map((a) => {
        const localMatch = currentAttById.get(a.id)
        return localMatch?.summary ? { ...a, summary: localMatch.summary } : a
      })
    }

    // The transcript: the local copy is always authoritative when it exists.
    // A cloud row only supplies segments when the user opted into transcript
    // sync (callFullBackupPayload) AND this machine has none — the restore-on-
    // a-new-Mac case. The quote-free default payload sends [] and never wins.
    const cloudSegments =
      !deleted && !current?.segments?.length && Array.isArray(v.segments) && v.segments.length
        ? sanitizeSegments(v.segments)
        : []
    const segments = deleted ? [] : current?.segments?.length ? current.segments : cloudSegments

    // Bookmarks are transcript excerpts — same "local copy always wins when
    // it exists" rule as segments above, since they only ever leave the
    // device under the same opt-in transcripts scope.
    const cloudBookmarks =
      !deleted && !current?.bookmarks?.length && Array.isArray(v.bookmarks)
        ? sanitizeBookmarks(v.bookmarks)
        : []
    const bookmarks = deleted ? [] : current?.bookmarks?.length ? current.bookmarks : cloudBookmarks

    const preview = deleted
      ? ''
      : current?.segments?.length || !cloudSegments.length
        ? (current?.preview ?? '')
        : cloudSegments
            .map((s) => s.text)
            .join(' ')
            .slice(0, 160)

    // CRM link: a string links, an explicit null unlinks, an ABSENT field
    // (row pushed before the app carried it) preserves the local link.
    const contactId = deleted
      ? undefined
      : isSafeId(v.contactId)
        ? v.contactId
        : v.contactId === null
          ? undefined
          : current?.contactId

    let coaching = deleted ? undefined : (sanitizeCoaching(v.coaching, segments) ?? undefined)
    // Same report as the local one (identical creation stamp)? Keep the LOCAL
    // copy — it still has the evidence quotes the quote-free cloud projection
    // strips, and re-importing must not erase them.
    if (coaching && current?.coaching && current.coaching.createdAt === coaching.createdAt) {
      coaching = current.coaching
    }

    // Resolved speaker names (M19 Task 2) — reconciled, not simply carried
    // forward or replaced (see mergeSpeakerIdentities' own doc comment).
    const speakerIdentities = deleted
      ? undefined
      : mergeSpeakerIdentities(current?.speakerIdentities, sanitizeIncomingSpeakerIdentities(v.speakerIdentities))

    const call: Call = {
      id,
      title,
      createdAt,
      updatedAt,
      durationMs: Number.isFinite(v.durationMs)
        ? Math.max(0, Math.trunc(v.durationMs as number))
        : 0,
      speakerCount: deleted
        ? 0
        : Number.isFinite(v.speakerCount)
          ? Math.max(0, Math.trunc(v.speakerCount as number))
          : 0,
      preview,
      segments,
      summary: deleted ? undefined : (sanitizeSummary(v.summary) ?? undefined),
      coaching,
      attachments,
      consent: sanitizeConsent(v.consent),
      ...(contactId ? { contactId } : {}),
      ...(!deleted && (isoOrUndefined(v.objectionsMinedAt) ?? current?.objectionsMinedAt)
        ? { objectionsMinedAt: isoOrUndefined(v.objectionsMinedAt) ?? current?.objectionsMinedAt }
        : {}),
      // Never synced (see callBackupPayload) — preserved only across a
      // same-device restore-merge onto an existing local record, so a
      // restore can't re-trigger a duplicate AI CRM note.
      ...(!deleted && current?.crmNoteGeneratedAt
        ? { crmNoteGeneratedAt: current.crmNoteGeneratedAt }
        : {}),
      ...(!deleted && bookmarks.length ? { bookmarks } : {}),
      ...(speakerIdentities && Object.keys(speakerIdentities).length ? { speakerIdentities } : {}),
      ...(deleted ? { deleted: true } : {})
    }
    // Mirror every other persister (saveCall/getCall/listCalls): strip buyer
    // turns the merged consent no longer permits before the record hits disk.
    applyConsentRetention(call)
    await ensureDir(dir)
    try {
      await writeCall(dir, call)
    } catch {
      return null
    }
    return call
  })
}

/**
 * Bump every non-deleted call's `updatedAt` so the next backup push REPLACES
 * each cloud row (the server trigger only accepts strictly-newer rows). Used
 * when the transcript-sync toggle turns OFF: the previously-uploaded rows
 * carry the full transcript, and only a newer quote-free row can evict them.
 */
export async function touchAllCallsForRepush(dir: string): Promise<number> {
  const calls = await listCallsForBackup(dir)
  let touched = 0
  for (const c of calls) {
    if (c.deleted) continue // tombstone rows are already content-free
    await withCallLock(c.id, async () => {
      try {
        const raw = JSON.parse(await fs.readFile(join(dir, `${c.id}.json`), 'utf8')) as Call
        if (!raw || typeof raw.id !== 'string') return
        raw.updatedAt = new Date().toISOString()
        await writeCall(dir, raw)
        touched++
      } catch {
        /* skip unreadable file */
      }
    })
  }
  return touched
}

// --- Per-call write serialization --------------------------------------------

// Every mutator below is a getCall → mutate → writeCall sequence; two of them
// running concurrently for the SAME call (e.g. Summarize + Coach clicked
// back-to-back) would silently clobber each other's write. withCallLock chains
// work per callId so same-call mutations run one at a time, while different
// calls stay fully concurrent.
const callLocks = new Map<string, Promise<unknown>>()

async function withCallLock<T>(callId: string, fn: () => Promise<T>): Promise<T> {
  const prev = callLocks.get(callId) ?? Promise.resolve()
  // Chain after the previous task for this id; a prior failure must not block
  // the queue, and each caller sees only its own result/error.
  const next = prev.catch(() => {}).then(fn)
  const settled = next.catch(() => {}) // settled = "done, success or failure"
  callLocks.set(callId, settled)
  settled.then(() => {
    // Clean up only if no newer work chained onto this entry in the meantime.
    if (callLocks.get(callId) === settled) callLocks.delete(callId)
  })
  return next
}

// --- AI summaries -----------------------------------------------------------

export async function setCallSummary(
  dir: string,
  callId: string,
  summary: Summary
): Promise<Call | null> {
  return withCallLock(callId, async () => {
    const call = await getCall(dir, callId)
    if (!call) return null
    const clean = sanitizeSummary(summary)
    if (!clean) return null // nothing usable to save — signal failure to the caller
    call.summary = clean
    call.updatedAt = new Date().toISOString()
    await writeCall(dir, call)
    return call
  })
}

/** Set a call's title (manual rename, or the AI Note Taker auto-title feature). */
export async function setCallTitle(
  dir: string,
  callId: string,
  title: unknown
): Promise<Call | null> {
  return withCallLock(callId, async () => {
    const call = await getCall(dir, callId)
    if (!call) return null
    const trimmed = typeof title === 'string' ? title.trim().slice(0, 300) : ''
    if (!trimmed) return call // never blank out the title
    call.title = trimmed
    call.updatedAt = new Date().toISOString()
    await writeCall(dir, call)
    return call
  })
}

/** Link (or clear, with `null`) the contact this call belongs to. */
export async function setCallContact(
  dir: string,
  callId: string,
  contactId: unknown
): Promise<Call | null> {
  return withCallLock(callId, async () => {
    const call = await getCall(dir, callId)
    if (!call) return null
    if (contactId === null) {
      delete call.contactId
    } else if (isSafeId(contactId)) {
      call.contactId = contactId
    } else {
      return call // not a recognizable id and not an explicit clear — leave as-is
    }
    call.updatedAt = new Date().toISOString()
    await writeCall(dir, call)
    return call
  })
}

const MAX_SPEAKER_NAME = 200
const SPEAKER_KEY_RE = /^(mono|ch[01])\/spk\d+$/
const SOURCES: SpeakerIdentitySource[] = [
  'user-profile',
  'calendar',
  'contact',
  'participant-list',
  'self-intro',
  'voice-profile',
  'manual'
]
const CONFIDENCES: SpeakerIdentityConfidence[] = ['high', 'medium', 'low']

/**
 * Set (or clear, with `name: null`) the resolved name for one speaker key on
 * one call — the single write path for BOTH the auto-resolution cascade
 * (source !== 'manual') and a user's inline rename (source: 'manual').
 * A manual rename always overwrites a lower-confidence auto-resolution; an
 * auto-resolution call is expected to check the existing entry itself before
 * calling this (the cascade should never clobber a rep's manual rename).
 */
export async function setSpeakerIdentity(
  dir: string,
  callId: string,
  key: unknown,
  patch: {
    name: unknown
    source: unknown
    confidence: unknown
    contactId?: unknown
  },
  opts?: {
    /** The auto-resolution cascade's guard against clobbering a rename —
     *  checked HERE, atomically with the write inside this function's own
     *  withCallLock section, never by a caller pre-reading the call and
     *  deciding from a snapshot that can go stale during its own async work
     *  (calendar/contact lookups) before the write actually lands. A caller
     *  that took a snapshot and checked `existing?.source === 'manual'`
     *  itself was the exact TOCTOU this parameter exists to close. */
    skipIfManual?: boolean
  }
): Promise<Call | null> {
  if (typeof key !== 'string' || !SPEAKER_KEY_RE.test(key)) return null
  return withCallLock(callId, async () => {
    const call = await getCall(dir, callId)
    if (!call) return null

    // Re-checked against the CURRENT on-disk state, inside the same lock
    // section as the write below — not a value the caller read earlier.
    if (opts?.skipIfManual && call.speakerIdentities?.[key]?.source === 'manual') {
      return call
    }

    if (patch.name === null) {
      if (call.speakerIdentities) delete call.speakerIdentities[key]
      call.updatedAt = new Date().toISOString()
      await writeCall(dir, call)
      return call
    }

    const name = typeof patch.name === 'string' ? patch.name.trim().slice(0, MAX_SPEAKER_NAME) : ''
    if (!name) return call // nothing usable — leave existing entry (if any) untouched
    const source = SOURCES.includes(patch.source as SpeakerIdentitySource)
      ? (patch.source as SpeakerIdentitySource)
      : 'manual'
    const confidence = CONFIDENCES.includes(patch.confidence as SpeakerIdentityConfidence)
      ? (patch.confidence as SpeakerIdentityConfidence)
      : 'high' // a manual rename IS the ground truth
    const contactId = isSafeId(patch.contactId) ? patch.contactId : undefined

    call.speakerIdentities = {
      ...call.speakerIdentities,
      [key]: { name, source, confidence, contactId, resolvedAt: new Date().toISOString() }
    }
    call.updatedAt = new Date().toISOString()
    await writeCall(dir, call)
    return call
  })
}

/** Bookmark a moment mid-call ("clip this") — clamps `atMs` into the call's
 *  actual duration and caps the transcript snippet length defensively. */
export async function addBookmark(
  dir: string,
  callId: string,
  atMs: unknown,
  text: unknown
): Promise<Call | null> {
  return withCallLock(callId, async () => {
    const call = await getCall(dir, callId)
    if (!call) return null
    const cleanText = typeof text === 'string' ? text.trim().slice(0, 2000) : ''
    if (!cleanText) return call // nothing to bookmark
    const cleanAtMs =
      typeof atMs === 'number' && Number.isFinite(atMs)
        ? Math.max(0, Math.min(atMs, call.durationMs))
        : 0
    const bookmark: Bookmark = {
      id: randomUUID(),
      atMs: cleanAtMs,
      text: cleanText,
      createdAt: new Date().toISOString()
    }
    call.bookmarks = [...(call.bookmarks ?? []), bookmark]
    call.updatedAt = new Date().toISOString()
    await writeCall(dir, call)
    return call
  })
}

/** Remove one bookmark by id — the "undo" for an accidental clip. */
export async function removeBookmark(
  dir: string,
  callId: string,
  bookmarkId: string
): Promise<Call | null> {
  return withCallLock(callId, async () => {
    const call = await getCall(dir, callId)
    if (!call) return null
    call.bookmarks = (call.bookmarks ?? []).filter((b) => b.id !== bookmarkId)
    call.updatedAt = new Date().toISOString()
    await writeCall(dir, call)
    return call
  })
}

export async function setAttachmentSummary(
  dir: string,
  callId: string,
  attachmentId: string,
  summary: Summary
): Promise<Call | null> {
  if (!isSafeId(attachmentId)) return null
  return withCallLock(callId, async () => {
    const call = await getCall(dir, callId)
    if (!call) return null
    const att = (call.attachments ?? []).find((a) => a.id === attachmentId)
    if (!att) return null
    const clean = sanitizeSummary(summary)
    if (!clean) return null // nothing usable to save — signal failure to the caller
    att.summary = clean
    call.updatedAt = new Date().toISOString()
    await writeCall(dir, call)
    return call
  })
}

/** Mark a call as read for Objection Library mining (auto-mine on save, or
 *  the manual "scan past calls" trigger) — so a future scan can skip it. */
export async function setCallObjectionsMined(dir: string, callId: string): Promise<Call | null> {
  return withCallLock(callId, async () => {
    const call = await getCall(dir, callId)
    if (!call) return null
    call.objectionsMinedAt = new Date().toISOString()
    await writeCall(dir, call)
    return call
  })
}

/** Mark a call as having auto-drafted its one-time AI CRM note. */
export async function setCallCrmNoteGenerated(dir: string, callId: string): Promise<Call | null> {
  return withCallLock(callId, async () => {
    const call = await getCall(dir, callId)
    if (!call) return null
    call.crmNoteGeneratedAt = new Date().toISOString()
    await writeCall(dir, call)
    return call
  })
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

/** Lowercase + collapse whitespace, for tolerant quote-in-transcript matching. */
function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

const FREE_TEXT_OVERLAP_WORDS = 8

/** Builds a scrubber that truncates any free-text field at the point it starts
 *  quoting the transcript verbatim (an 8+ consecutive word overlap) — defense
 *  in depth on the persistence/restore path, mirroring coach.ts's scrubber for
 *  freshly-generated reports. Only the dedicated evidence quote fields may
 *  carry exact transcript wording. */
function makeFreeTextScrubber(transcript: string): (text: string) => string {
  return (text) => {
    if (!text) return text
    const words = text.split(/\s+/).filter((w) => w.length > 0)
    for (let i = 0; i + FREE_TEXT_OVERLAP_WORDS <= words.length; i++) {
      const window = normalizeForMatch(words.slice(i, i + FREE_TEXT_OVERLAP_WORDS).join(' '))
      if (window && transcript.includes(window)) {
        const kept = words.slice(0, i).join(' ')
        return kept ? `${kept} […]` : '[Removed: this text quoted the transcript verbatim.]'
      }
    }
    return text
  }
}

interface VerifyTurn {
  speaker: number
  text: string // normalized
}

/** Merge consecutive same-speaker segments into turns (same shape as
 *  coach.ts's makeVerifier), so quote verification below checks a single
 *  speaker's continuous utterance rather than a flattened whole-transcript
 *  string — a quote stitched from the tail of one turn plus the head of
 *  another (regardless of speaker) can no longer verify. */
function buildVerifyTurns(segments: CallSegment[]): VerifyTurn[] {
  const turns: { speaker: number; text: string }[] = []
  for (const s of Array.isArray(segments) ? segments : []) {
    if (!s || typeof s.text !== 'string') continue
    const last = turns[turns.length - 1]
    if (last && last.speaker === s.speaker) last.text += ` ${s.text}`
    else turns.push({ speaker: s.speaker, text: s.text })
  }
  return turns.map((t) => ({ speaker: t.speaker, text: normalizeForMatch(t.text) }))
}

function sanitizeEvidence(
  value: unknown,
  turns: VerifyTurn[],
  repSpeaker: number | null
): CoachEvidence | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const quote = str(v.quote, 500).trim()
  if (!quote) return undefined
  const claimedSpeaker = clampInt(v.speaker, 0, 1000, 0)
  const nq = normalizeForMatch(quote)
  // `verified` is RE-DERIVED from the call's actual transcript, never trusted
  // from the stored/cloud flag — and only true when a SINGLE turn spoken by
  // the claimed speaker contains the quote (never a flattened whole-
  // transcript string), so a restored/cloud payload can't claim a stitched
  // or misattributed quote is verified. `speaker` comes from the matched
  // turn's actual speaker, not the unchecked claim, so a misattribution
  // can't survive even if the text happens to match some other speaker. It
  // must ALSO be the rep being coached — matching the transcript alone never
  // confirms the buyer's own line isn't being shown as the rep's evidence.
  const match = turns.find((t) => t.speaker === claimedSpeaker && t.text.includes(nq))
  const verified = !!match && repSpeaker !== null && claimedSpeaker === repSpeaker
  return {
    quote,
    speaker: match ? match.speaker : claimedSpeaker,
    verified
  }
}

/** Coerce an untrusted object (an AI-built report) into a clean CoachingReport.
 *  `segments` is the call's transcript, used to recompute every evidence
 *  quote's `verified` flag rather than trusting the input. */
export function sanitizeCoaching(value: unknown, segments: CallSegment[]): CoachingReport | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>

  const transcript = normalizeForMatch(
    (Array.isArray(segments) ? segments : [])
      .map((s) => (s && typeof s.text === 'string' ? s.text : ''))
      .join(' ')
  )
  const turns = buildVerifyTurns(segments)

  const scrub = makeFreeTextScrubber(transcript)

  // Parsed early — evidence can only be verified when it's the REP's own
  // words, so every sanitizeEvidence call below needs this first.
  const m = (v.metrics ?? {}) as Record<string, unknown>
  const repSpeaker = numOrNull(m.repSpeaker) === null ? null : clampInt(m.repSpeaker, 0, 1000, 0)

  const dimensions: CoachDimension[] = []
  const seenKeys = new Set<CoachDimensionKey>()
  for (const d of Array.isArray(v.dimensions) ? v.dimensions : []) {
    if (!d || typeof d !== 'object') continue
    const dd = d as Record<string, unknown>
    if (typeof dd.key !== 'string' || !DIMENSION_KEYS.has(dd.key as CoachDimensionKey)) continue
    const key = dd.key as CoachDimensionKey
    if (seenKeys.has(key)) continue // keep the first occurrence of each dimension
    seenKeys.add(key)
    dimensions.push({
      key,
      score: clampInt(dd.score, 1, 5, 3),
      comment: scrub(str(dd.comment, 1000)),
      evidence: sanitizeEvidence(dd.evidence, turns, repSpeaker)
    })
  }
  // A partial rubric (hand-edited or legacy file) must not pass as a complete report.
  if (dimensions.length !== DIMENSION_KEYS.size) return null

  const improvements: CoachImprovement[] = []
  for (const i of (Array.isArray(v.improvements) ? v.improvements : []).slice(0, 5)) {
    if (!i || typeof i !== 'object') continue
    const ii = i as Record<string, unknown>
    improvements.push({
      kind: ii.kind === 'strategic' ? 'strategic' : 'mechanical',
      title: scrub(str(ii.title, 300)),
      detail: scrub(str(ii.detail, 1500)),
      evidence: sanitizeEvidence(ii.evidence, turns, repSpeaker)
    })
  }

  const dc = (v.dealContext ?? {}) as Record<string, unknown>
  const strength = (v.strength ?? {}) as Record<string, unknown>

  return {
    overallScore: clampInt(v.overallScore, 0, 100, 0),
    dealContext: {
      type: dc.type === 'transactional' || dc.type === 'complex' ? dc.type : 'unknown',
      summary: scrub(str(dc.summary, 500)),
      lens: scrub(str(dc.lens, 200))
    },
    strength: {
      text: scrub(str(strength.text, 600)),
      evidence: sanitizeEvidence(strength.evidence, turns, repSpeaker)
    },
    dimensions,
    improvements,
    nextAction: scrub(str(v.nextAction, 500)),
    metrics: {
      repSpeaker,
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
  return withCallLock(callId, async () => {
    const call = await getCall(dir, callId)
    if (!call) return null
    const clean = sanitizeCoaching(report, speechSegments(call.segments))
    if (!clean) return null // nothing usable to save — signal failure to the caller
    call.coaching = clean
    call.updatedAt = new Date().toISOString()
    await writeCall(dir, call)
    return call
  })
}

export async function setCallCommitments(
  dir: string,
  callId: string,
  commitments: Commitment[]
): Promise<Call | null> {
  return withCallLock(callId, async () => {
    const call = await getCall(dir, callId)
    if (!call) return null
    // Re-sanitized here too (not just at generation time in commitments.ts) —
    // the same defense-in-depth every other AI-derived field on a call gets:
    // whatever reaches disk was validated at the point of writing it, not just
    // trusted because it came from the extraction call moments earlier.
    call.commitments = sanitizeCommitments(commitments)
    call.updatedAt = new Date().toISOString()
    await writeCall(dir, call)
    return call
  })
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
  return withCallLock(callId, async () => {
    const call = await getCall(dir, callId)
    if (!call) return { ok: false, error: 'not-found' }

    const ext = typeof input?.ext === 'string' ? input.ext.toLowerCase().replace(/^\./, '') : ''
    if (!ALLOWED_EXT.has(ext as AttachmentExt)) return { ok: false, error: 'unsupported-type' }

    const bytes = input?.bytes
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0)
      return { ok: false, error: 'empty' }
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
    call.updatedAt = new Date().toISOString()
    try {
      await writeCall(dir, call)
    } catch (err) {
      // Don't orphan the file we just wrote if recording its metadata failed.
      await fs.unlink(join(filesDir(dir), `${id}.${ext}`)).catch(() => {})
      throw err
    }
    return { ok: true, attachment }
  })
}

export async function removeAttachment(
  dir: string,
  callId: string,
  attachmentId: string
): Promise<{ ok: boolean }> {
  if (!isSafeId(attachmentId)) return { ok: false }
  return withCallLock(callId, async () => {
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
    call.updatedAt = new Date().toISOString()
    try {
      await writeCall(dir, call)
    } catch {
      return { ok: false }
    }
    return { ok: true }
  })
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
