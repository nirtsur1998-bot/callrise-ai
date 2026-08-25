import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeJsonAtomic } from './atomic-write'
import { sanitizeCommitments } from './commitments'

/** 'unknown' is a first-class answer — see the renderer's SpeakerRole. */
export type SpeakerRole = 'rep' | 'other' | 'unknown'

export interface CallSegment {
  speaker: number
  text: string
  /** Speaker-label namespace this `speaker` belongs to. Deepgram restarts
   *  diarization on every reconnect, so the same number across two epochs is
   *  usually two different people. Absent on calls saved before M21. */
  epoch?: number
  /** Who said this, decided when the turn was recorded and never revised.
   *  Absent on calls saved before M21. */
  role?: SpeakerRole
  /** Lowest word confidence Deepgram reported for this turn, when available. */
  confidence?: number
  /** True when Deepgram returned NO speaker label for these words, so
   *  `speaker` is a fabricated 0 rather than a real diarization answer.
   *  `role` is 'unknown' for two very different reasons — "the rep is not
   *  identified yet" (back-fillable, the number is real) and this one (never
   *  back-fillable, the number means nothing). Without the distinction, naming
   *  the rep would assert every label-less turn as the rep, since 0 is usually
   *  the rep's own number. */
  unlabelled?: boolean
  /** Which capture channel this came from: 0 = the rep's mic, 1 = the other
   *  party's loopback. Undefined for mono (mic-only) calls and for anything
   *  saved before this existed.
   *
   *  Present because `speaker` ALONE is ambiguous. In mono it is a diarized
   *  guess; in multichannel it is the channel index — so "speaker 0" means two
   *  different people either side of a mid-call switch to buyer capture, and a
   *  saved transcript could not tell you which. Identity is the PAIR.
   *
   *  This is also the sole signal `applyConsentRetention` trusts to strip a
   *  segment: `channel` is a hardware fact (a genuine second audio path), never
   *  a diarization guess, so it is the only thing precise enough to say "this
   *  really is the other party" per segment — including correctly on a call
   *  that switches from mic-only to buyer capture mid-call, where earlier and
   *  later segments are in different regimes within the same array. */
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
  /** M23 — benchmark-engine inputs (src/main/coaching/benchmarks.ts). All
   *  optional: absent on calls scored before M23 or with Coach 2.0 off, and
   *  computed from segment ORDER, not wall-clock time — saved transcripts
   *  carry no per-segment timestamp, so "early/late in the call" is a
   *  transcript-position proxy, never a literal minute mark. */
  questionSpread?: number | null // 0–1, how evenly the rep's questions land across the call's thirds
  buyerQuestionCount?: number
  buyerLongestMonologueWords?: number
  pricingMentions?: number // buyer-side pricing-keyword hits
  pricingMentionsLatePct?: number | null // share of those hits in the back half of the transcript
  nextStepsLocked?: boolean // a concrete next step + date was agreed
}

export interface CoachDealContext {
  type: 'transactional' | 'complex' | 'unknown'
  summary: string
  lens: string
}

// --- M23 Coach 2.0: call type, methodology, skill graph ---------------------
// Everything in this section is OPTIONAL on CoachingReport/CallBase and
// additive-only. A call coached before M23 (or with Settings → Coach 2.0
// off) simply has these fields absent — sanitizeCoaching() below never makes
// their presence a requirement, unlike the six-dimension rubric's exact-count
// gate, so no historical scorecard is ever invalidated by this feature.

export type CallType = 'cold-call' | 'discovery' | 'demo' | 'closing' | 'other'

export type SalesMethodology = 'spin' | 'meddic' | 'meddpicc' | 'challenger' | 'sandler' | 'blended'

export const SALES_METHODOLOGIES: SalesMethodology[] = [
  'blended',
  'spin',
  'meddic',
  'meddpicc',
  'challenger',
  'sandler'
]

export type SkillKey =
  | 'discovery'
  | 'listening'
  | 'objectionHandling'
  | 'valueArticulation'
  | 'pricing'
  | 'momentum'
  | 'rapport'
  | 'methodology'

export const SKILL_KEYS: SkillKey[] = [
  'discovery',
  'listening',
  'objectionHandling',
  'valueArticulation',
  'pricing',
  'momentum',
  'rapport',
  'methodology'
]

/** 0–100 per skill, same call-to-call scale as overallScore. */
export type SkillScoreSet = Record<SkillKey, number>

/** How well the call adhered to the rep's chosen sales methodology — scored
 *  1–5 like the six core dimensions, but kept OUTSIDE the `dimensions` array
 *  (and outside DIMENSION_KEYS) so it can never affect the exact-count
 *  validation gate that treats a wrong dimension count as a corrupt report. */
export interface MethodologyAssessment {
  methodology: SalesMethodology
  score: number // 1–5
  comment: string
  evidence?: CoachEvidence
}

/** What the Focus Skill loop was asking the rep to practice going INTO this
 *  call — captured by calls.ts right before coaching runs (reading the
 *  Focus Skill state left over from the PREVIOUS call), so the report can
 *  lead with "how did you do on the thing you were asked to practice",
 *  exactly A4's requirement. Deliberately NOT the same as the focus that
 *  gets selected AFTER this call (which is for the call after this one). */
export interface FocusSkillAtCoaching {
  skill: SkillKey
  microBehavior: string
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
  /** M23 — present only when Settings → Coach 2.0 was on at coaching time. */
  callType?: CallType
  skills?: SkillScoreSet
  methodologyAdherence?: MethodologyAssessment
  focusSkillAtCoaching?: FocusSkillAtCoaching
}

// --- M23 Workstream B: coaching chat (advisor + practice mode) --------------

export type CoachChatRole = 'user' | 'assistant'
export type CoachChatMode = 'advisor' | 'practice'

/** One turn in the coaching-chat thread for this call. Persisted only once a
 *  turn is COMPLETE (user message + the assistant's full final reply) — the
 *  in-progress stream lives in renderer state until then, so an interrupted
 *  stream never leaves a half-written turn on disk. */
export interface CoachChatMessage {
  id: string
  role: CoachChatRole
  text: string
  createdAt: string
  /** Which mode this turn happened in — lets the UI render practice-mode
   *  turns distinctly (and excludes them from becoming "evidence" the way
   *  the end-of-practice feedback pass reads them). Advisor when absent
   *  (pre-practice-mode messages, or default). */
  mode?: CoachChatMode
}

/** A context fact the chat detected in the user's last message and proposed
 *  saving — never applied until the rep taps the chip (see coaching-chat.ts).
 *  Not persisted on the message itself; suggestions are a live-only signal
 *  attached to the IPC response for the turn that produced them. */
export interface CoachChatContextSuggestion {
  id: string
  type: 'kyc' | 'next-steps' | 'call-notes' | 'memory'
  /** Contact field name, only when type === 'kyc' (see KYC_UPDATABLE_FIELDS
   *  in coaching-chat.ts for the allowed set). */
  field?: string
  text: string
  confidence: 'high' | 'medium'
  /** M25 Phase 4 — only present when type === 'memory': which Sales Brain
   *  scope/category this fact belongs to (extends the M23 KYC-chip pattern
   *  to rep/business scopes, per spec section 3's "Save to Sales Brain"
   *  chip). `scope` is the resolved scope string ('rep' | 'business' |
   *  'client:<id>'), not re-derived client-side. */
  memoryScope?: string
  memoryCategory?: string
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

// --- Deal Intelligence (M24 §8 — the post-call "Radar Report") --------------
// Everything the Live Deal Intelligence engine surfaced during the call,
// captured once at save time (see setCallDealIntelligence below) so the
// CallDetail screen can show a timeline/health-curve/hit-miss review after
// the fact — the engine itself is call-scoped, in-memory only, and gone the
// moment the live screen unmounts otherwise.

export type DealNudgeType = 'risk' | 'opportunity' | 'tactical'

export interface DealNudgeRecord {
  id: string
  type: DealNudgeType
  subtype: string
  confidence: number
  evidenceQuote: string
  evidenceRole: 'rep' | 'other'
  suggestedCue: string
  /** Elapsed ms since the call started — same clock the live engine used. */
  atMs: number
  /** Set once the rep rates it; absent means never rated, not "rated neutral". */
  feedback?: 'helpful' | 'not-helpful'
}

export interface DealHealthScorePoint {
  score: number
  trajectory: 'up' | 'flat' | 'down'
  atMs: number
}

export interface DealIntelligenceRecord {
  nudges: DealNudgeRecord[]
  healthScoreHistory: DealHealthScorePoint[]
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
  /** M23 — cold-call/discovery/demo/closing, for call-type-aware benchmarks.
   *  Auto-detected from the title the first time the call is coached, then
   *  sticky: re-coaching never overwrites a value already set here, so a
   *  rep's manual override (calls:setCallType) always wins going forward. */
  callType?: CallType
  /** M25 Phase 5 — spec section 4's "Don't learn from this call" toggle.
   *  When true, memory-hooks.ts's extraction skips this call entirely, and
   *  turning it on retroactively deletes any memories already extracted
   *  from it (memory-center-ipc.ts's setExcluded handler) — this is
   *  intentionally a hard opt-out, not a soft one. Absent/false on every
   *  call by default, including every call saved before this existed. */
  salesBrainExcluded?: boolean
}

/** Lightweight item for the Past Calls list. */
export interface CallSummary extends CallBase {
  hasSummary: boolean
  attachmentCount: number
  hasCoaching: boolean
  coachScore?: number // 0–100 overall, when coached
  /** M23 — the 8 Skill Graph scores, when coached with Coach 2.0 on. Carried
   *  on the lightweight summary (like coachScore) so the Progress dashboard
   *  can roll up trend lines from listCalls() alone, without re-reading
   *  every full call record from disk. */
  skills?: SkillScoreSet
  /** M25 Phase 3 — raw talk-ratio/question-count metrics, carried on the
   *  summary for the exact same reason `skills` is: memory/personal-
   *  benchmarks.ts needs a rep's own history across many calls to compute
   *  personalized norms, and doing that from listCalls() alone (instead of
   *  reading every full Call record from disk) is the difference between a
   *  cheap directory scan and an expensive one on every single coaching run. */
  talkRatio?: number | null
  questionCount?: number
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
  /** M24 §8 — the post-call "Radar Report" source data (nudge timeline +
   *  health-score curve). Same local-only treatment as commitments above and
   *  for the same reason: buyer-derived AI output not yet reviewed for what's
   *  safe to leave the device (see callBackupPayload — deliberately absent
   *  from that allowlist). */
  dealIntelligence?: DealIntelligenceRecord
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
  /** M23 Workstream B — the coaching-chat thread for this call (advisor Q&A
   *  + practice-mode turns interleaved, distinguished by each message's
   *  `mode`). Complete turns only — see CoachChatMessage's doc comment. */
  coachChat?: CoachChatMessage[]
  /** M23 Workstream B — free-text notes saved from the coaching chat's
   *  "Save to call notes" chip. Appended to, never silently overwritten;
   *  local-only for now (not in callBackupPayload's allowlist), same
   *  treatment as commitments/dealIntelligence above. */
  notes?: string
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
    if (!text.trim()) continue
    // Attribution decided when the turn was recorded — preserved verbatim so
    // nothing downstream has to re-derive (and possibly contradict) it.
    const epochRaw = (item as { epoch?: unknown }).epoch
    const roleRaw = (item as { role?: unknown }).role
    const confRaw = (item as { confidence?: unknown }).confidence
    const unlabelledRaw = (item as { unlabelled?: unknown }).unlabelled
    const isGap = (item as { kind?: unknown }).kind === 'gap'
    const channelRaw = (item as { channel?: unknown }).channel
    const channel = channelRaw === 0 || channelRaw === 1 ? (channelRaw as 0 | 1) : undefined
    out.push({
      speaker,
      text,
      ...(Number.isFinite(epochRaw) ? { epoch: Math.trunc(epochRaw as number) } : {}),
      ...(roleRaw === 'rep' || roleRaw === 'other' || roleRaw === 'unknown'
        ? { role: roleRaw }
        : {}),
      ...(typeof confRaw === 'number' && Number.isFinite(confRaw)
        ? { confidence: Math.min(1, Math.max(0, confRaw)) }
        : {}),
      ...(unlabelledRaw === true ? { unlabelled: true as const } : {}),
      ...(channel !== undefined ? { channel } : {}),
      ...(isGap ? { kind: 'gap' as const } : {})
    })
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

// M27 E2 — exported so live-transcript-ipc.ts's crash-recovery idempotency
// check can build a CallSummary for an already-recovered call without
// re-deriving this mapping.
export function toSummary(call: Call): CallSummary {
  return {
    id: call.id,
    title: call.title,
    createdAt: call.createdAt,
    updatedAt: isoOrUndefined(call.updatedAt) ?? call.createdAt, // backfill for old calls
    durationMs: call.durationMs,
    speakerCount: call.speakerCount,
    preview: call.preview,
    contactId: isSafeId(call.contactId) ? call.contactId : undefined,
    callType: call.callType,
    hasSummary: Boolean(call.summary),
    attachmentCount: Array.isArray(call.attachments) ? call.attachments.length : 0,
    hasCoaching: Boolean(call.coaching),
    coachScore:
      typeof call.coaching?.overallScore === 'number' ? call.coaching.overallScore : undefined,
    skills: call.coaching?.skills,
    talkRatio: call.coaching?.metrics.talkRatio,
    questionCount: call.coaching?.metrics.questionCount,
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
  // BUG-119 — THE GUARD RUNS HERE, at the single write chokepoint, not at each
  // writer's own discretion.
  //
  // Every instance of this bug family has been a WRITER that forgot the guard,
  // never a guard that got the answer wrong: BUG-014, BUG-028 (addBookmark),
  // BUG-115 (setCallDealIntelligence), and — found by BUG-119's own test suite
  // asserting on the FILE rather than on getCall's return value —
  // setCallCommitments, appendCommitment and appendCoachChatTurn, all three of
  // which wrote the other party's words to disk unguarded. The read path
  // filtered them back out, so nothing was visibly wrong; the raw JSON kept
  // them.
  //
  // Twenty-five call sites reach this function. Asking each to remember is the
  // same hand-maintained correspondence the classification exists to abolish,
  // so it is applied once, here, where it cannot be forgotten. Idempotent: the
  // strippers are filters, and re-running them on already-clean data is a
  // no-op. A tombstone carries no consent record, so the guard returns
  // immediately for it.
  applyConsentRetention(call)
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
 * absent consent.
 *
 * Multichannel (`channel` present on the segment) is a fixed HARDWARE fact —
 * channel 1 really is a second, genuine audio path (the buyer's loopback) —
 * so it is the only signal this function trusts to strip anything.
 *
 * Mono (`channel` undefined) is never stripped, deliberately. `speaker` there
 * is only a diarization GUESS, and the guess is unreliable specifically when
 * it matters most: a transcriber mishearing pitch/pause changes as a second
 * voice happens on ordinary single-person calls, not only on calls with a
 * real second party. An earlier version of this function treated "not
 * provably the rep" as reason enough to strip even on mono (erring toward
 * privacy), which reliably destroyed the rep's own words on ordinary mic-only
 * calls whenever the diarizer mis-split them (BUG-002) — there is no real
 * "other party" on a mic-only call to protect in the first place, so nothing
 * about consent should ever touch its transcript. Revisit only alongside a
 * genuine second-voice detector, not a bare speaker-number comparison.
 */
// Exported so call-journal.ts's consent-redaction pass can apply the exact
// same "is this the buyer's turn" rule to raw journal words, rather than
// re-deriving a channel/speaker predicate that could quietly drift from this
// one over time.
export function isOtherPartySpeaker(n: number, channel: number | undefined): boolean {
  return channel !== undefined && n === BUYER_SPEAKER
}

/**
 * Does this call's coaching thread get dropped for lack of recording consent?
 *
 * THE ONE DEFINITION of that condition on the main side, exported so the guard
 * and any caller answer it identically rather than each writing `!== true`.
 *
 * The `consent != null` half is the part that is easy to get wrong and
 * expensive when you do: applyConsentRetention early-returns when there is NO
 * consent record at all, so a legacy call without one is never stripped.
 * `recordOtherParty !== true` alone is TRUE for such a call, and a UI built on
 * it would tell the rep their coaching history had been discarded when nothing
 * had been touched.
 *
 * The renderer cannot import this: src/main is outside its tsconfig scope, a
 * boundary this codebase already meets in three places (calendarMatch.ts,
 * DetectionOverlay.tsx, holdsUnreviewedOutput.ts), each resolved by
 * duplication plus a "keep in sync" comment -- which is principle 8's own tell
 * for a correspondence that will drift. Since the duplicate cannot be removed
 * here, it is instead PINNED: consent-ui-predicate-parity.test.ts reads both
 * sources and fails if the two conditions stop matching. Forgetting goes from
 * silent to red.
 */
export function coachingHistoryDropped(call: Pick<Call, 'consent'>): boolean {
  return call.consent != null && call.consent.recordOtherParty !== true
}

/**
 * WHOSE CONTENT EACH FIELD OF A CALL CARRIES.
 *
 * One classification. Both privacy guards consult it; neither keeps a list of
 * its own. They then take DIFFERENT actions from the same answer, because they
 * guard different boundaries — see each guard's docblock.
 *
 * WHY BY OWNER RATHER THAN BY "STRIP OR KEEP". The obvious design is a closed
 * literal of what is safe to keep, dropping everything else. It destroys data:
 * `notes` is free text the REP typed, and `commitments` includes the rep's own
 * promises. Dropping unlisted fields would delete the rep's work because the
 * buyer declined recording — data loss wearing a privacy justification. So a
 * field is classified by whose content it carries, and the action follows.
 */
export type CallFieldClass =
  /** Verbatim or near-verbatim words of the other party. */
  | 'BUYER_SPEECH'
  /** Who the other party is, rather than what they said. A name is personal
   *  data exactly as much as the words are. */
  | 'BUYER_IDENTITY'
  /** The rep's own words and actions. Survives consent loss — it was never the
   *  other party's to withhold. */
  | 'REP_CONTENT'
  /** Model output computed over a transcript.
   *
   *  THE LOAD-BEARING RULE, and it is currently true only by accident: a
   *  DERIVED field is safe to keep ONLY IF it is produced downstream of a
   *  `getCall()` read. getCall runs applyConsentRetention BEFORE returning, so
   *  a generator reading through it can never see the buyer's turns on an
   *  unconsented call — its output cannot contain their words.
   *
   *  Anything written from a renderer-supplied blob, or from a direct file
   *  read, bypasses that and CAN carry speech captured before a mid-call
   *  revoke. That is exactly why `dealIntelligence` was BUG-115 and `coaching`
   *  was not: same class, different provenance. If you add a DERIVED field,
   *  check its provenance before giving it no stripper. */
  | 'DERIVED'
  /** Content of an uploaded file and any AI summary of it. Neither party's
   *  speech — third-party content with its own rules. It is its own class
   *  precisely because forcing it into buyer-or-not is what let it slip both
   *  guards' lists. */
  | 'DOCUMENT'
  /** Timestamps, ids, flags. No content of anyone's. */
  | 'METADATA'

interface CallFieldRule {
  readonly cls: CallFieldClass
  /** How to remove the other party's contribution from this field when consent
   *  is absent. OMITTED means there is nothing to remove — not that the field
   *  was forgotten. Every omission below is accompanied by the reason. */
  readonly stripOtherParty?: (call: Call) => void
}

/**
 * EXHAUSTIVE over `Required<Call>`. Adding a field to the Call record without
 * classifying it here is a COMPILE ERROR, not a runtime leak. That is the
 * entire point: BUG-014, BUG-028 and BUG-115 were three separate discoveries
 * that a hand-maintained allowlist had fallen behind a growing type.
 */
export const CALL_FIELD_RULES: { [K in keyof Required<Call>]: CallFieldRule } = {
  // ---- CallBase ----------------------------------------------------------
  id: { cls: 'METADATA' },
  title: { cls: 'DERIVED' }, // set by the rep or derived post-save; never from a live blob
  createdAt: { cls: 'METADATA' },
  updatedAt: { cls: 'METADATA' },
  durationMs: { cls: 'METADATA' },
  contactId: { cls: 'METADATA' },
  callType: { cls: 'METADATA' },
  salesBrainExcluded: { cls: 'METADATA' },

  // preview and speakerCount are both computed FROM segments, so `segments`
  // rewrites all three together below. Giving them their own strippers would
  // either double-handle or reintroduce an ordering dependency between rules.
  preview: { cls: 'BUYER_SPEECH' },
  speakerCount: { cls: 'METADATA' },

  // ---- Call --------------------------------------------------------------
  segments: {
    cls: 'BUYER_SPEECH',
    stripOtherParty: (call) => {
      if (!Array.isArray(call.segments)) return
      // A gap marker is not the buyer's speech — it belongs to nobody, so it
      // survives the strip regardless of the speaker id it happens to carry.
      const kept = call.segments.filter(
        (seg) => seg.kind === 'gap' || !isOtherPartySpeaker(seg.speaker, seg.channel)
      )
      if (kept.length === call.segments.length) return
      call.segments = kept
      call.preview = speechSegments(kept)
        .map((seg) => seg.text)
        .join(' ')
        .slice(0, 160)
      call.speakerCount = countSpeakers(kept)
    }
  },

  speakerIdentities: {
    cls: 'BUYER_IDENTITY',
    stripOtherParty: (call) => {
      if (!call.speakerIdentities) return
      const keys = Object.keys(call.speakerIdentities)
      const keptKeys = keys.filter((k) => {
        const n = speakerNumberFromKey(k)
        if (n === null) return true // malformed key — nothing to strip, keep as-is
        // In multichannel, speaker IS the channel (speakerIdentityKey's own
        // format: `ch{channel}/spk{speaker}` with the two always equal) — so
        // the parsed number doubles as the channel value. `mono/` keys have none.
        return !isOtherPartySpeaker(n, k.startsWith('mono/') ? undefined : n)
      })
      if (keptKeys.length === keys.length) return
      const next: Record<string, SpeakerIdentityRecord> = {}
      for (const k of keptKeys) next[k] = call.speakerIdentities[k]
      call.speakerIdentities = next
    }
  },

  bookmarks: {
    cls: 'BUYER_SPEECH',
    // Flattened, unattributed text — captureClip snapshots the last few turns
    // on screen with no per-speaker filtering, and nothing on the Bookmark
    // shape (id/atMs/text/createdAt) could drive a surgical strip. NO SAFE
    // PARTIAL EXISTS, so the whole field goes. Losing a rep-only bookmark is
    // an acceptable cost; keeping the buyer's verbatim words is not.
    stripOtherParty: (call) => {
      if (call.bookmarks && call.bookmarks.length > 0) call.bookmarks = []
    }
  },

  dealIntelligence: {
    cls: 'DERIVED',
    // BUG-115. Assembled LIVE in the renderer and handed to
    // setCallDealIntelligence, so it does NOT come downstream of a getCall()
    // read — the DERIVED escape clause does not apply and it needs a stripper.
    // Each nudge carries an evidenceQuote the model was told to reproduce
    // "word for word", with evidenceRole marking whose words. The whole nudge
    // goes rather than blanking the quote: sanitizeDealNudgeRecord treats a
    // falsy quote as malformed and drops the record anyway.
    // healthScoreHistory is numbers, not words, and stays.
    stripOtherParty: (call) => {
      const di = call.dealIntelligence
      if (!di || !Array.isArray(di.nudges)) return
      const keptNudges = di.nudges.filter((n) => n.evidenceRole !== 'other')
      if (keptNudges.length !== di.nudges.length) di.nudges = keptNudges
    }
  },

  commitments: {
    cls: 'DERIVED',
    // Owner-split. `owner: 'rep'` is the rep's own promise and survives.
    // `owner: 'prospect'` is a record of what the BUYER said, in the buyer's
    // own terms (the field's own doc: "in the promiser's own terms") — which
    // is precisely the thing consent was declined for. Founder's decision,
    // 2026-08-25: strip them, and accept losing the feature on those calls,
    // because the alternative is keeping the buyer's promises after they
    // refused to be recorded.
    stripOtherParty: (call) => {
      if (!Array.isArray(call.commitments)) return
      const kept = call.commitments.filter((m) => m.owner !== 'prospect')
      if (kept.length !== call.commitments.length) call.commitments = kept
    }
  },

  coachChat: {
    cls: 'DERIVED',
    // THE WHOLE THREAD GOES, not the buyer-quoting turns. Founder's decision,
    // 2026-08-25, and the reasoning is stronger than per-turn stripping: "A
    // coaching thread with the assistant's turns removed is worse than no
    // thread: it reads as a conversation and misrepresents what was said, and
    // the rep can't tell which turns are missing."
    //
    // A gapped thread is a FABRICATION — it presents as a complete exchange
    // while being an edited one, with nothing marking the edit. Absence is
    // honest; redaction that looks complete is not. The UI must say why the
    // thread is absent so this reads as policy rather than data loss.
    stripOtherParty: (call) => {
      if (call.coachChat && call.coachChat.length > 0) call.coachChat = []
    }
  },

  summary: { cls: 'DERIVED' }, // produced downstream of getCall() — see CallFieldClass
  coaching: { cls: 'DERIVED' }, // produced downstream of getCall() — verified, BUG-119 §2
  attachments: { cls: 'DOCUMENT' }, // never syncs; local retention is a separate question
  consent: { cls: 'METADATA' }, // the flag itself, not content
  objectionsMinedAt: { cls: 'METADATA' },
  crmNoteGeneratedAt: { cls: 'METADATA' },
  deleted: { cls: 'METADATA' },
  notes: { cls: 'REP_CONTENT' } // the rep typed it; the buyer has no claim on it
}

/**
 * WHAT MUST NOT PERSIST LOCALLY WHEN THE OTHER PARTY DID NOT CONSENT.
 *
 * That sentence is the whole scope, and it is deliberately narrow. This guard
 * is NOT "the privacy guarantee" — there is a second one, `callBackupPayload`,
 * which answers a different question at a different boundary ("what may EVER
 * leave this device", and it applies to consented calls too). Neither is a
 * superset of the other and neither should be folded into the other.
 *
 * BUG-119, species 42: both functions previously described themselves as "the
 * privacy guarantee". A careful read of the pair concluded they were one
 * guarantee that had drifted, and produced an instruction to unify them —
 * which would have been a real regression dressed as a cleanup. A definite
 * article is a claim of uniqueness that nothing enforces. Both docblocks now
 * name their BOUNDARY and their QUESTION instead of their rank.
 *
 * Buyer capture only ever runs after consent (status becomes 'consented'); if
 * recording the other party isn't (still) permitted (recordOtherParty !== true
 * — "turn recording off", a mid-call decline, or a file tampered to drop the
 * flag) the other party's contribution is removed. Runs on save AND read AND
 * list, so a revoked or hand-edited call can never surface it.
 *
 * HOW IT DECIDES: it does not carry its own list. Every decision comes from
 * CALL_FIELD_RULES below, which is exhaustive over `Required<Call>` — so a new
 * field on the record cannot be added without classifying it, and an
 * unclassified field is a COMPILE ERROR rather than a silent leak. That is the
 * fix for the shape that produced BUG-014, BUG-028 and BUG-115: three separate
 * discoveries that an allowlist had fallen behind a growing type.
 */
function applyConsentRetention(call: Call): void {
  // Keyed purely on the sanitized recordOtherParty flag, NOT on status: a call
  // can go consented → revoked/declined within one session AFTER buyer turns
  // were captured, so the current status must never short-circuit the strip.
  // Same predicate the UI asks, so the two can never answer differently.
  if (!coachingHistoryDropped(call)) return

  // Each rule strips its own field independently. There is no shared control
  // flow between them BY DESIGN: the previous version returned early from the
  // whole function when `segments` was absent or unchanged, which meant a
  // strip placed after that point silently no-opped on exactly the calls that
  // needed it most (a revoked call on its SECOND read has already had its
  // transcript removed). Independent strippers make that hazard structurally
  // impossible rather than warning about it in a comment.
  for (const rule of Object.values(CALL_FIELD_RULES)) {
    rule.stripOtherParty?.(call)
  }
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
 * WHAT MAY NEVER LEAVE THIS DEVICE. That is this function's whole question,
 * and it is NOT the same question applyConsentRetention answers.
 *
 * BUG-119, species 42: both functions used to describe themselves as "the
 * privacy guarantee". They are two guards at two boundaries. This one asks
 * what may leave the device and applies to EVERY call, consented or not --
 * `segments` is forced to [] even when the buyer explicitly agreed to be
 * recorded. applyConsentRetention asks what may persist LOCALLY when the
 * other party did NOT consent, and does nothing at all when they did.
 * Neither is a superset of the other; neither should be folded into the
 * other. A reader who took both definite articles at face value concluded
 * they had drifted and proposed unifying them, which would have been a real
 * regression dressed as a cleanup.
 *
 * Both guards read the SAME classification (CALL_FIELD_RULES) for whose
 * content a field carries, and take different ACTIONS from that one answer.
 *
 * Pure + unit-provable.
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
 * summaries -- see callBackupPayload, which decides what may never leave the
 * device. (BUG-119/species 42: this said "the privacy guarantee", a THIRD
 * site inheriting a definite article that was already ambiguous between two
 * different guards. Named by its function now.) So this importer MERGES onto the current
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
      // Bugfix (found while wiring M23's own local-only fields below): these
      // were missing from this reconstruction entirely, so a cloud restore
      // merging onto an existing local record silently wiped them even
      // though they're local-only and the cloud row never carries them —
      // same "preserved only across a same-device restore-merge" rule as
      // crmNoteGeneratedAt above, just never actually applied to these four.
      ...(!deleted && current?.callType ? { callType: current.callType } : {}),
      // Presence (`!== undefined`), not a `.length` truthy check — an empty
      // array means "the AI extraction ran and found zero," which is a
      // real, distinct state from "never ran" (undefined). A `.length`
      // check collapses both to falsy and silently loses an honest
      // zero-commitments result on every restore-merge.
      ...(!deleted && current?.commitments !== undefined ? { commitments: current.commitments } : {}),
      ...(!deleted && current?.dealIntelligence ? { dealIntelligence: current.dealIntelligence } : {}),
      ...(!deleted && current?.coachChat !== undefined ? { coachChat: current.coachChat } : {}),
      ...(!deleted && current?.notes ? { notes: current.notes } : {}),
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

const CALL_TYPES = new Set<CallType>(['cold-call', 'discovery', 'demo', 'closing', 'other'])

/** M23 — the rep's manual call-type override (Workstream A1). Same shape as
 *  setCallContact: null clears back to auto-detection, an unrecognized value
 *  is a no-op. A manual write here is what makes a call-type "sticky" —
 *  coach.ts only ever auto-fills this field when it's still unset. */
export async function setCallCallType(
  dir: string,
  callId: string,
  callType: unknown
): Promise<Call | null> {
  return withCallLock(callId, async () => {
    const call = await getCall(dir, callId)
    if (!call) return null
    if (callType === null) {
      delete call.callType
    } else if (typeof callType === 'string' && CALL_TYPES.has(callType as CallType)) {
      call.callType = callType as CallType
    } else {
      return call
    }
    call.updatedAt = new Date().toISOString()
    await writeCall(dir, call)
    return call
  })
}

/** M25 Phase 5 — spec section 4's "Don't learn from this call" toggle. The
 *  actual deletion of any already-extracted memories (when turning this ON
 *  retroactively) is the caller's job (memory-center-ipc.ts) — this
 *  function only owns the Call record's own field, matching this file's
 *  own boundary (calls-fs.ts never imports the memory module). */
export async function setCallSalesBrainExcluded(
  dir: string,
  callId: string,
  excluded: boolean
): Promise<Call | null> {
  return withCallLock(callId, async () => {
    const call = await getCall(dir, callId)
    if (!call) return null
    if (excluded) call.salesBrainExcluded = true
    else delete call.salesBrainExcluded
    call.updatedAt = new Date().toISOString()
    await writeCall(dir, call)
    return call
  })
}

/** Auto-fill a call's type from detection ONLY if nothing is set yet — never
 *  overwrites a value the rep (or a prior auto-fill) already put there. Used
 *  right after coaching so the detected type "sticks" for benchmark reuse
 *  without a second write path that could race a manual override. */
export async function setCallTypeIfUnset(
  dir: string,
  callId: string,
  callType: CallType
): Promise<void> {
  await withCallLock(callId, async () => {
    const call = await getCall(dir, callId)
    if (!call || call.callType) return
    call.callType = callType
    call.updatedAt = new Date().toISOString()
    await writeCall(dir, call)
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
    /** Stronger, superset guard for a LOW-priority resolution source (e.g.
     *  M23 Workstream D's post-hoc self-intro scan): skip if ANY name is
     *  already resolved for this key, regardless of source — never
     *  downgrade an existing 'contact'/'calendar' (higher-confidence) entry
     *  to a 'self-intro' one. Checked atomically here for the same TOCTOU
     *  reason as skipIfManual above: a caller that read "nothing resolved
     *  yet" before starting a slow AI call can no longer trust that
     *  snapshot by the time the AI call returns — the background naming
     *  cascade (resolve-for-call.ts) runs independently and may have
     *  resolved a higher-confidence entry in the meantime. */
    skipIfAlreadyResolved?: boolean
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
    if (opts?.skipIfAlreadyResolved && call.speakerIdentities?.[key]?.name) {
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
    // BUG-028: re-apply retention on this exact write, not just on the next
    // read. getCall() above already stripped the call as of its own read,
    // but a bookmark captured live (before a mid-call consent revoke) can
    // still contain the other party's verbatim words with nothing on the
    // Bookmark shape to strip surgically — same reasoning applyConsentRetention's
    // own bookmark handling documents. Without this, the write below would
    // persist it to the raw on-disk file even though every app-level read
    // already filters it back out.
    applyConsentRetention(call)
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
  // M22 bug hunt: coach.ts's own report-generation path only ever keeps
  // evidence once verified — an unverified quote never enters a freshly
  // generated report in the first place. This persistence-time sanitizer
  // (the re-check a saved/imported/hand-edited file goes through) used to
  // keep the quote anyway with verified:false, which is the one shape that
  // was never supposed to be reachable: a non-rep or unmatched quote sitting
  // in a coaching report as "evidence". No live call site plants one today
  // (confirmed: setCallCoaching's only caller passes an already-verified-only
  // report, and importCall's coaching payload never carries evidence at all),
  // but a hand-edited or future-format local file re-imported through this
  // same function is exactly the case this sanitizer exists to defend
  // against — so drop it here too, matching coach.ts, instead of leaving a
  // gap that's only closed by every current caller happening to avoid it.
  if (!verified) return undefined
  return {
    quote,
    speaker: match ? match.speaker : claimedSpeaker,
    verified
  }
}

function sanitizeReportCallType(value: unknown): CallType | undefined {
  return typeof value === 'string' && CALL_TYPES.has(value as CallType)
    ? (value as CallType)
    : undefined
}

/** Only accepted whole — a set missing any of the 8 keys is treated as
 *  absent rather than rendered as a partial/misleading skill graph. */
function sanitizeSkillScores(value: unknown): SkillScoreSet | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const out: Partial<SkillScoreSet> = {}
  for (const key of SKILL_KEYS) {
    const n = v[key]
    if (typeof n !== 'number' || !Number.isFinite(n)) return undefined
    out[key] = Math.max(0, Math.min(100, Math.round(n)))
  }
  return out as SkillScoreSet
}

function sanitizeFocusSkillAtCoaching(value: unknown): FocusSkillAtCoaching | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  if (typeof v.skill !== 'string' || !(SKILL_KEYS as string[]).includes(v.skill)) return undefined
  if (typeof v.microBehavior !== 'string' || !v.microBehavior.trim()) return undefined
  return { skill: v.skill as SkillKey, microBehavior: v.microBehavior.slice(0, 500) }
}

function sanitizeMethodologyAssessment(
  value: unknown,
  turns: VerifyTurn[],
  repSpeaker: number | null
): MethodologyAssessment | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  if (
    typeof v.methodology !== 'string' ||
    !SALES_METHODOLOGIES.includes(v.methodology as SalesMethodology)
  ) {
    return undefined
  }
  return {
    methodology: v.methodology as SalesMethodology,
    score: clampInt(v.score, 1, 5, 3),
    comment: str(v.comment, 1000),
    evidence: sanitizeEvidence(v.evidence, turns, repSpeaker)
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
      turns: clampInt(m.turns, 0, 1_000_000, 0),
      // M23 — genuinely OPTIONAL, unlike the ten fields above: only include a
      // key when the source actually had it, so a pre-M23 (or Coach-2.0-off)
      // report's metrics object round-trips with exactly its original 10
      // keys instead of growing 6 fabricated defaults on every save.
      ...('questionSpread' in m ? { questionSpread: numOrNull(m.questionSpread) } : {}),
      ...('buyerQuestionCount' in m
        ? { buyerQuestionCount: clampInt(m.buyerQuestionCount, 0, 1_000_000, 0) }
        : {}),
      ...('buyerLongestMonologueWords' in m
        ? { buyerLongestMonologueWords: clampInt(m.buyerLongestMonologueWords, 0, 10_000_000, 0) }
        : {}),
      ...('pricingMentions' in m
        ? { pricingMentions: clampInt(m.pricingMentions, 0, 1_000_000, 0) }
        : {}),
      ...('pricingMentionsLatePct' in m
        ? { pricingMentionsLatePct: numOrNull(m.pricingMentionsLatePct) }
        : {}),
      ...('nextStepsLocked' in m ? { nextStepsLocked: m.nextStepsLocked === true } : {})
    },
    model: str(v.model, 64) || 'claude',
    createdAt:
      typeof v.createdAt === 'string' && !Number.isNaN(Date.parse(v.createdAt))
        ? v.createdAt
        : new Date().toISOString(),
    callType: sanitizeReportCallType(v.callType),
    skills: sanitizeSkillScores(v.skills),
    methodologyAdherence: sanitizeMethodologyAssessment(v.methodologyAdherence, turns, repSpeaker),
    focusSkillAtCoaching: sanitizeFocusSkillAtCoaching(v.focusSkillAtCoaching)
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

/** Appends ONE commitment to whatever is on disk right now, read-modify-write
 *  inside the same call's lock — unlike setCallCommitments() (which overwrites
 *  wholesale and is meant for the bulk AI-extraction path), this is safe to
 *  call from concurrent single-item flows like coaching chat's "add next
 *  step" suggestion chips without a lost-update race between them. */
export async function appendCommitment(
  dir: string,
  callId: string,
  commitment: Commitment
): Promise<Call | null> {
  return withCallLock(callId, async () => {
    const call = await getCall(dir, callId)
    if (!call) return null
    call.commitments = sanitizeCommitments([...(call.commitments ?? []), commitment])
    call.updatedAt = new Date().toISOString()
    await writeCall(dir, call)
    return call
  })
}

// --- M23 Workstream B: coaching chat -----------------------------------------

const MAX_CHAT_MESSAGES = 300
// Headroom above the model's own maxTokens:2048 reply budget (roughly ~8-10k
// chars worst case) so a long assistant reply is never silently truncated at
// a boundary that doesn't match what the model was actually asked to produce.
const MAX_CHAT_TEXT = 16_000

/** What appendCoachChatTurn hands back: the saved call, plus the ids it just
 *  MINTED for the two messages.
 *
 *  BUG-110 (hardening) — the ids exist so no caller has to work out which
 *  stored message was which by POSITION. coaching-chat-ipc.ts used to reach
 *  back `coachChat[length - 2]` to find the rep's message of the turn it had
 *  just saved, which is correct only while the tail is a complete
 *  user+assistant pair. Nothing enforces that (see prompt-budget.ts's guard
 *  for the four other consumers relying on the same unenforced invariant),
 *  and unlike those, this one does not fail loudly: `length - 2` landing on
 *  the ASSISTANT message files a memory extracted from the rep's words under
 *  the coach's id — no error, no rejection, just wrong provenance in Sales
 *  Brain data, which is the one area where the consent posture assumes
 *  provenance is exact. Returning the minted ids removes the inference
 *  rather than making it more careful. */
export interface CoachChatTurnResult {
  call: Call
  userMessageId: string
  assistantMessageId: string
}

/** Appends ONE complete turn (user message + the assistant's full final
 *  reply) to this call's chat thread — never a partial/mid-stream message,
 *  see CoachChatMessage's doc comment. Oldest messages drop past
 *  MAX_CHAT_MESSAGES rather than growing the file unbounded. */
export async function appendCoachChatTurn(
  dir: string,
  callId: string,
  userMessage: { text: string; mode?: CoachChatMode },
  assistantMessage: { text: string; mode?: CoachChatMode }
): Promise<CoachChatTurnResult | null> {
  return withCallLock(callId, async () => {
    const call = await getCall(dir, callId)
    if (!call) return null
    const now = new Date().toISOString()
    const userEntry: CoachChatMessage = {
      id: randomUUID(),
      role: 'user',
      text: userMessage.text.trim().slice(0, MAX_CHAT_TEXT),
      createdAt: now,
      mode: userMessage.mode
    }
    const assistantEntry: CoachChatMessage = {
      id: randomUUID(),
      role: 'assistant',
      text: assistantMessage.text.trim().slice(0, MAX_CHAT_TEXT),
      createdAt: now,
      mode: assistantMessage.mode
    }
    const turn: CoachChatMessage[] = [userEntry, assistantEntry]
    // The new turn is appended at the END, and slice(-N) keeps the LAST N, so
    // the two messages just minted are always among the survivors — the ids
    // returned below can never refer to something this write dropped.
    call.coachChat = [...(call.coachChat ?? []), ...turn].slice(-MAX_CHAT_MESSAGES)
    call.updatedAt = now
    await writeCall(dir, call)
    return { call, userMessageId: userEntry.id, assistantMessageId: assistantEntry.id }
  })
}

const MAX_NOTES_CHARS = 20_000

/** Appends to this call's free-text notes (from the chat's "Save to call
 *  notes" chip) — never overwrites what's already there. */
export async function appendCallNotes(
  dir: string,
  callId: string,
  text: string
): Promise<Call | null> {
  const clean = typeof text === 'string' ? text.trim() : ''
  if (!clean) return getCall(dir, callId)
  return withCallLock(callId, async () => {
    const call = await getCall(dir, callId)
    if (!call) return null
    const existing = call.notes ?? ''
    call.notes = (existing ? `${existing}\n\n${clean}` : clean).slice(-MAX_NOTES_CHARS)
    call.updatedAt = new Date().toISOString()
    await writeCall(dir, call)
    return call
  })
}

const DEAL_NUDGE_TYPES = new Set<DealNudgeType>(['risk', 'opportunity', 'tactical'])
const DEAL_TRAJECTORIES = new Set<DealHealthScorePoint['trajectory']>(['up', 'flat', 'down'])
/** Defensive cap on how many entries a single call's Radar Report can carry —
 *  the Nudge Engine's own cooldown/cap already keeps nudges rare in practice
 *  (see nudgeEngine.ts), so a call anywhere near this is a sign something
 *  upstream misbehaved, not a real, honestly-long call. */
const MAX_RADAR_REPORT_ENTRIES = 200

function sanitizeDealNudgeRecord(value: unknown): DealNudgeRecord | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const id = typeof v.id === 'string' && v.id ? v.id : null
  const type =
    typeof v.type === 'string' && DEAL_NUDGE_TYPES.has(v.type as DealNudgeType)
      ? (v.type as DealNudgeType)
      : null
  const subtype = typeof v.subtype === 'string' ? v.subtype.trim().slice(0, 60) : ''
  const confidence =
    typeof v.confidence === 'number' && Number.isFinite(v.confidence)
      ? Math.max(0, Math.min(1, v.confidence))
      : 0
  const evidenceQuote = typeof v.evidenceQuote === 'string' ? v.evidenceQuote.trim().slice(0, 400) : ''
  const evidenceRole = v.evidenceRole === 'rep' || v.evidenceRole === 'other' ? v.evidenceRole : null
  const suggestedCue = typeof v.suggestedCue === 'string' ? v.suggestedCue.trim().slice(0, 150) : ''
  const atMs = typeof v.atMs === 'number' && Number.isFinite(v.atMs) ? Math.max(0, Math.round(v.atMs)) : 0
  const feedback = v.feedback === 'helpful' || v.feedback === 'not-helpful' ? v.feedback : undefined
  if (!id || !type || !subtype || !evidenceQuote || !evidenceRole || !suggestedCue) return null
  return { id, type, subtype, confidence, evidenceQuote, evidenceRole, suggestedCue, atMs, feedback }
}

function sanitizeHealthScorePoint(value: unknown): DealHealthScorePoint | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const score =
    typeof v.score === 'number' && Number.isFinite(v.score)
      ? Math.max(0, Math.min(100, Math.round(v.score)))
      : null
  const trajectory =
    typeof v.trajectory === 'string' && DEAL_TRAJECTORIES.has(v.trajectory as DealHealthScorePoint['trajectory'])
      ? (v.trajectory as DealHealthScorePoint['trajectory'])
      : null
  const atMs = typeof v.atMs === 'number' && Number.isFinite(v.atMs) ? Math.max(0, Math.round(v.atMs)) : 0
  if (score === null || !trajectory) return null
  return { score, trajectory, atMs }
}

/** Same defense-in-depth every other AI-derived field on a call gets —
 *  whatever reaches disk is validated here, not just trusted because it came
 *  from the live engine moments earlier (that engine already sanitized its
 *  own inputs, but this is the boundary that actually matters: disk). */
export function sanitizeDealIntelligenceRecord(value: unknown): DealIntelligenceRecord {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const nudges = Array.isArray(v.nudges)
    ? v.nudges
        .map(sanitizeDealNudgeRecord)
        .filter((n): n is DealNudgeRecord => n !== null)
        .slice(0, MAX_RADAR_REPORT_ENTRIES)
    : []
  const healthScoreHistory = Array.isArray(v.healthScoreHistory)
    ? v.healthScoreHistory
        .map(sanitizeHealthScorePoint)
        .filter((h): h is DealHealthScorePoint => h !== null)
        .slice(0, MAX_RADAR_REPORT_ENTRIES)
    : []
  return { nudges, healthScoreHistory }
}

export async function setCallDealIntelligence(
  dir: string,
  callId: string,
  record: unknown
): Promise<Call | null> {
  return withCallLock(callId, async () => {
    const call = await getCall(dir, callId)
    if (!call) return null
    call.dealIntelligence = sanitizeDealIntelligenceRecord(record)
    call.updatedAt = new Date().toISOString()
    // BUG-115, same shape as BUG-028's fix in addBookmark: re-apply retention on
    // THIS write, not just on the next read. getCall() above stripped the call
    // as of its own read, but `record` is a renderer-supplied blob assembled
    // live — during buyer capture, before a mid-call revoke — so it can carry
    // the other party's verbatim words into a call whose transcript is already
    // clean. Without this the raw file on disk keeps them even though every
    // app-level read filters them back out.
    applyConsentRetention(call)
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
