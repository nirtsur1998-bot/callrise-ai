import type { CoachingReport } from '@renderer/features/coaching/types'

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

export interface Call extends CallBase {
  segments: CallSegment[]
  summary?: Summary
  attachments?: Attachment[]
  coaching?: CoachingReport
  consent?: ConsentRecord
  bookmarks?: Bookmark[]
}

export type SummaryResult =
  { ok: true; summary: Summary } | { ok: false; error: 'no-key' | 'failed'; message?: string }
