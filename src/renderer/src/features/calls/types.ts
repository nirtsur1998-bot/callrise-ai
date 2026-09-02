import type {
  CallType,
  CoachChatMessage,
  CoachingReport,
  SkillScoreSet
} from '@renderer/features/coaching/types'
import type { DealIntelligenceRecord } from '../../../../preload/index.d'

export interface CallSegment {
  speaker: number
  text: string
  /** Which speaker-label namespace `speaker` belongs to. Deepgram restarts
   *  diarization on every reconnect, and channel labels mean something
   *  different from diarization labels, so the same number in two epochs is
   *  usually two different people. Runs never merge across an epoch.
   *  Absent on calls saved before M21. */
  epoch?: number
  /** WHO said this, decided when the turn was recorded and never revised.
   *  Previously the UI compared `speaker` against a mutable whole-call
   *  `repSpeaker` at render time, so the moment that value changed, every
   *  already-recorded turn in the call silently relabelled. Absent on calls
   *  saved before M21 (they fall back to the old comparison). */
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
   *  saved before this existed. A hardware fact, never a diarization guess —
   *  the only signal the consent-retention strip trusts (see calls-fs.ts). */
  channel?: number
  /** A `[gap: Ns]` marker rather than someone's words — audio that was shed,
   *  discarded to rejoin the live edge, or lost to a suspend. Rendered as a
   *  divider, never attributed to a speaker. */
  kind?: 'gap'
}

/** 'unknown' is a first-class answer: before the rep is identified, after a
 *  speaker-label reassignment, or when Deepgram didn't label the words at all.
 *  The UI says so rather than asserting a name it can't stand behind. */
export type SpeakerRole = 'rep' | 'other' | 'unknown'

export interface Summary {
  executive: string
  keyPoints: string[]
  actionItems: string[]
  questions: string[]
  model: string
  createdAt: string
}

export type CommitmentOwner = 'rep' | 'prospect'

export interface Commitment {
  owner: CommitmentOwner
  /** What was promised, in the promiser's own terms. */
  text: string
  /** ISO date, only when a date was actually stated. */
  dueDate?: string
}

export type ConsentStatus = 'not-asked' | 'disclosed' | 'consented' | 'declined'
export type ConsentJurisdiction = 'one-party' | 'two-party'
export type ConsentMethod = 'verbal-on-call' | 'pre-agreed' | 'written'

export interface ConsentRecord {
  status: ConsentStatus
  jurisdiction: ConsentJurisdiction
  method?: ConsentMethod
  /** Only ever true when status === 'consented' (enforced in the main process). */
  recordOtherParty: boolean
  disclosedAt?: string
  decidedAt?: string
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
  createdAt: string
  updatedAt: string
  durationMs: number
  speakerCount: number
  preview: string
  /** The contact this call is linked to, if any. */
  contactId?: string
  /** M32 Stage 2 — the DEAL this call belongs to. Explicit, never inferred:
   *  `contactId` above is optional and ambiguous (one contact, two deals), so
   *  it cannot stand in for this. Only linked calls count toward outcome
   *  tracking. A THIRD independent declaration of the same field (main's
   *  calls-fs.ts and preload/index.d.ts are the others) — the renderer cannot
   *  import from main. Unlike a union, a missing FIELD fails on first use, so
   *  the typecheck is the guard here rather than a text-lockstep test; it is
   *  what caught this copy being absent. */
  dealId?: string
  /** M23 — sticky call-type classification, auto-detected then overridable. */
  callType?: CallType
}

export interface CallSummary extends CallBase {
  hasSummary: boolean
  attachmentCount: number
  hasCoaching: boolean
  coachScore?: number
  skills?: SkillScoreSet
}

// --- M19 Task 2: resolved speaker identities --------------------------------
// Kept as a local type (not imported from features/coaching/meta.ts, which
// re-declares the identical shape) so this foundational, widely-imported
// file doesn't couple to the coaching feature.
export type SpeakerIdentitySource =
  | 'user-profile'
  | 'calendar'
  | 'contact'
  | 'participant-list'
  | 'self-intro'
  | 'voice-profile'
  | 'manual'
export type SpeakerIdentityConfidence = 'high' | 'medium' | 'low'
/** Keyed by speakerKey() — see live/segments.ts. */
export interface SpeakerIdentity {
  name: string
  source: SpeakerIdentitySource
  confidence: SpeakerIdentityConfidence
  contactId?: string
  resolvedAt: string
}

export interface Call extends CallBase {
  segments: CallSegment[]
  summary?: Summary
  attachments?: Attachment[]
  coaching?: CoachingReport
  commitments?: Commitment[]
  consent?: ConsentRecord
  bookmarks?: Bookmark[]
  speakerIdentities?: Record<string, SpeakerIdentity>
  /** M24 §8 — the post-call Radar Report source data (nudge history + health
   *  score curve). Absent on any call recorded before this shipped, and on
   *  every call where Live Deal Intelligence was off. */
  dealIntelligence?: DealIntelligenceRecord
  /** M23 Workstream B — the coaching-chat thread for this call. */
  coachChat?: CoachChatMessage[]
  /** M23 Workstream B — free-text notes saved from the chat's "Save to call notes" chip. */
  notes?: string
}

export type SummaryResult =
  { ok: true; summary: Summary } | { ok: false; error: 'no-key' | 'failed'; message?: string }

/** BUG-172 — did this call PROMISE to record the other party and then not do
 *  it? True only when the app committed (`consent.recordOtherParty === true`)
 *  and NO segment carries a channel at all, which is the signature of the
 *  loopback never attaching: the socket ran mono, so neither side got a
 *  channel assignment.
 *
 *  Deliberately NOT "channel 1 has no segments" — a buyer who simply said
 *  little produces that too, and telling a rep their recording failed when it
 *  did not is its own harm. An entirely channel-less transcript cannot be
 *  explained by a quiet buyer.
 *
 *  DERIVED AT READ TIME, never stored: it is a fact about the recording, so
 *  every call already on disk gets the marker with no migration. Thirteen
 *  calls on the founder's machine qualified, the oldest from 2026-07-27 — six
 *  weeks of transcripts that read as though the buyer barely spoke.
 *
 *  Lives here, in the renderer, because the banner is its only consumer. A
 *  second copy in main would be a second source of truth for a rule about
 *  someone's recording. */
export function otherPartyPromisedButMissing(call: {
  consent?: { recordOtherParty?: boolean } | null
  segments?: { channel?: number; kind?: string }[]
}): boolean {
  if (call.consent?.recordOtherParty !== true) return false
  const speech = (call.segments ?? []).filter((s) => s.kind !== 'gap')
  if (speech.length === 0) return false
  return !speech.some((s) => s.channel === 0 || s.channel === 1)
}
