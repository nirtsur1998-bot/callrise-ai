import type { CoachingReport } from '@renderer/features/coaching/types'

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
  durationMs: number
  speakerCount: number
  preview: string
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
}

export type SummaryResult =
  { ok: true; summary: Summary } | { ok: false; error: 'no-key' | 'failed'; message?: string }
