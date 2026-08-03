import type { CoachingReport } from '@renderer/features/coaching/types'

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
   *  discarded to rejoin the live edge, or lost to a suspend. Rendered as a
   *  divider, never attributed to a speaker. */
  kind?: 'gap'
}

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
}

export interface CallSummary extends CallBase {
  hasSummary: boolean
  attachmentCount: number
  hasCoaching: boolean
  coachScore?: number
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
}

export type SummaryResult =
  { ok: true; summary: Summary } | { ok: false; error: 'no-key' | 'failed'; message?: string }
