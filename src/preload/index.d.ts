import { ElectronAPI } from '@electron-toolkit/preload'

export type MicAccessStatus = 'granted' | 'denied' | 'restricted' | 'not-determined'

export interface TranscriptionStateEvent {
  state: 'idle' | 'connecting' | 'listening' | 'reconnecting' | 'error'
  attempt?: number
}

export interface TranscriptWord {
  speaker: number
  text: string
}

export interface TranscriptResultEvent {
  /** The transcribed text for this update. */
  transcript: string
  /** Per-word speaker labels (diarization). */
  words: TranscriptWord[]
  /** True when this segment is finalized (won't be revised). */
  isFinal: boolean
  /** True at the end of an utterance (a natural pause). */
  speechFinal: boolean
  /** Measured real-time lag from speech to this text, in milliseconds. */
  lagMs: number
}

export interface TranscriptionErrorEvent {
  message: string
}

export interface TranscriptionApi {
  ensureMicAccess: () => Promise<{ status: MicAccessStatus }>
  openMicSettings: () => Promise<{ ok: boolean }>
  start: (options: { sampleRate: number }) => Promise<{ ok: boolean; error?: 'no-key' }>
  sendAudio: (chunk: ArrayBuffer) => void
  stop: () => Promise<{ ok: boolean }>
  onState: (cb: (payload: TranscriptionStateEvent) => void) => () => void
  onTranscript: (cb: (payload: TranscriptResultEvent) => void) => () => void
  onError: (cb: (payload: TranscriptionErrorEvent) => void) => () => void
  onUtteranceEnd: (cb: (payload: Record<string, never>) => void) => () => void
  /** Fires after a stopped session's connection has fully closed (flush done). */
  onClosed: (cb: (payload: Record<string, never>) => void) => () => void
}

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
  createdAt: string
  durationMs: number
  speakerCount: number
  preview: string
}

export interface CallSummary extends CallBase {
  hasSummary: boolean
  attachmentCount: number
}

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

export type SummaryResult =
  | { ok: true; summary: Summary }
  | { ok: false; error: 'no-key' | 'failed'; message?: string }

export type AddAttachmentResult =
  | { ok: true; attachment: Attachment }
  | { ok: false; error: 'not-found' | 'unsupported-type' | 'empty' | 'too-large' }

export interface CallsApi {
  list: () => Promise<CallSummary[]>
  get: (id: string) => Promise<Call | null>
  save: (input: CallSaveInput) => Promise<CallSummary>
  delete: (id: string) => Promise<{ ok: boolean }>
  addAttachment: (
    callId: string,
    file: { name: string; ext: string; data: ArrayBuffer }
  ) => Promise<AddAttachmentResult>
  removeAttachment: (callId: string, attachmentId: string) => Promise<{ ok: boolean }>
  summarizeCall: (callId: string) => Promise<SummaryResult>
  summarizeAttachment: (callId: string, attachmentId: string) => Promise<SummaryResult>
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      transcription: TranscriptionApi
      calls: CallsApi
    }
  }
}
