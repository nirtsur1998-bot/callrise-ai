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
  /** Async, non-blocking: a short next-question suggestion for live cues. */
  suggestQuestion: (text: string) => Promise<{ ok: true; question: string } | { ok: false }>
  /** Manual mid-call help: sends the running transcript + the rep's question. */
  askCoach: (
    transcript: string,
    question: string
  ) => Promise<{ ok: true; headline: string; tips: string[] } | { ok: false; message?: string }>
  /** Conversation-aware live cue from a speaker-labeled transcript window. */
  liveCue: (
    transcript: string,
    repSpeaker: number | null
  ) => Promise<
    | {
        ok: true
        repSpeaker: number | null
        cue: 'objection' | 'discovery' | 'next-question' | 'buying-signal' | 'none'
        text: string
      }
    | { ok: false }
  >
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

export type CoachDimensionKey =
  'discovery' | 'engagement' | 'objection' | 'value' | 'nextStep' | 'control'

export interface CoachEvidence {
  quote: string
  speaker: number
  verified: boolean
}

export interface CoachDimension {
  key: CoachDimensionKey
  score: number
  comment: string
  evidence?: CoachEvidence
}

export interface CoachImprovement {
  kind: 'mechanical' | 'strategic'
  title: string
  detail: string
  evidence?: CoachEvidence
}

export interface CoachMetrics {
  repSpeaker: number | null
  singleSpeaker: boolean
  talkRatio: number | null
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
  overallScore: number
  dealContext: CoachDealContext
  strength: { text: string; evidence?: CoachEvidence }
  dimensions: CoachDimension[]
  improvements: CoachImprovement[]
  nextAction: string
  metrics: CoachMetrics
  model: string
  createdAt: string
}

export type CoachResult =
  { ok: true; report: CoachingReport } | { ok: false; error: 'no-key' | 'failed'; message?: string }

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
}

export interface CallSaveInput {
  startedAt: string
  durationMs: number
  segments: CallSegment[]
}

export type SummaryResult =
  { ok: true; summary: Summary } | { ok: false; error: 'no-key' | 'failed'; message?: string }

export type AddAttachmentResult =
  | { ok: true; attachment: Attachment }
  | { ok: false; error: 'not-found' | 'unsupported-type' | 'empty' | 'too-large' }

export type TaskType = 'follow-up' | 'email' | 'meeting' | 'research' | 'general'
export type TaskPriority = 'low' | 'medium' | 'high'
export type TaskStatus = 'open' | 'done'
export type TaskSource = 'ai' | 'manual'

export interface Task {
  id: string
  title: string
  type: TaskType
  priority: TaskPriority
  status: TaskStatus
  dueAt?: string
  clientName?: string
  note?: string
  callId?: string
  callTitle?: string
  source: TaskSource
  createdAt: string
  completedAt?: string
}

/** A task Claude proposes from a call (not yet saved). */
export interface ProposedTask {
  title: string
  type: TaskType
  priority: TaskPriority
  dueAt?: string
  clientName?: string
  note?: string
}

export interface TaskCreateInput {
  title: string
  type: TaskType
  priority: TaskPriority
  status?: TaskStatus
  dueAt?: string | null
  clientName?: string | null
  note?: string | null
  callId?: string
  callTitle?: string
  source?: TaskSource
}

export interface TaskUpdateInput {
  title?: string
  type?: TaskType
  priority?: TaskPriority
  status?: TaskStatus
  dueAt?: string | null
  clientName?: string | null
  note?: string | null
}

export type GenerateTasksResult =
  { ok: true; tasks: ProposedTask[] } | { ok: false; error: 'no-key' | 'failed'; message?: string }

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
  coachCall: (callId: string) => Promise<CoachResult>
}

export interface TasksApi {
  list: () => Promise<Task[]>
  create: (input: TaskCreateInput) => Promise<Task>
  update: (id: string, patch: TaskUpdateInput) => Promise<Task | null>
  delete: (id: string) => Promise<{ ok: boolean }>
  generateFromCall: (callId: string) => Promise<GenerateTasksResult>
}

export interface CalendarEvent {
  id: string
  title: string
  start: string
  end: string
  allDay: boolean
  notes?: string
  source: 'local'
  provider?: string
  externalId?: string
  createdAt: string
  updatedAt: string
}

export interface EventCreateInput {
  title: string
  start: string
  end: string
  allDay?: boolean
  notes?: string | null
}

export interface EventUpdateInput {
  title?: string
  start?: string
  end?: string
  allDay?: boolean
  notes?: string | null
}

export interface EventsApi {
  list: () => Promise<CalendarEvent[]>
  create: (input: EventCreateInput) => Promise<CalendarEvent>
  update: (id: string, patch: EventUpdateInput) => Promise<CalendarEvent | null>
  delete: (id: string) => Promise<{ ok: boolean }>
}

export interface AuthUser {
  id: string
  email: string
  name?: string
}

export interface AuthStatus {
  configured: boolean
  user: AuthUser | null
}

export type AuthErrorCode =
  | 'not-configured'
  | 'invalid-credentials'
  | 'email-not-confirmed'
  | 'email-taken'
  | 'invalid-code'
  | 'weak-password'
  | 'invalid-email'
  | 'email-send-failed'
  | 'rate-limited'
  | 'network'
  | 'server'
  | 'failed'

type AuthFail = { ok: false; error: AuthErrorCode; message: string }

export type SignUpResult = { ok: true; status: 'confirm' | 'signed-in' } | AuthFail
export type VerifyResult = { ok: true; user: AuthUser } | AuthFail
export type SignInResult = { ok: true; user: AuthUser } | AuthFail
export type SimpleAuthResult = { ok: true } | AuthFail

export interface AuthApi {
  getStatus: () => Promise<AuthStatus>
  signUp: (email: string, password: string, name?: string) => Promise<SignUpResult>
  verifyOtp: (email: string, token: string) => Promise<VerifyResult>
  signIn: (email: string, password: string) => Promise<SignInResult>
  resendCode: (email: string) => Promise<SimpleAuthResult>
  signOut: () => Promise<SimpleAuthResult>
  onChange: (cb: (user: AuthUser | null) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      transcription: TranscriptionApi
      calls: CallsApi
      tasks: TasksApi
      events: EventsApi
      auth: AuthApi
    }
  }
}
