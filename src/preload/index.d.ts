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
  start: (options: {
    sampleRate: number
    multichannel?: boolean
  }) => Promise<{ ok: boolean; error?: 'no-key' }>
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
  /** Last modification (save or edit); backup "newest wins" key. */
  updatedAt: string
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

export interface CallSaveInput {
  startedAt: string
  durationMs: number
  segments: CallSegment[]
  consent?: ConsentRecord
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
  /** Last modification (create or edit); backup "newest wins" key. */
  updatedAt: string
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

export type EventSyncState = 'local-only' | 'synced' | 'dirty' | 'deleted' | 'error'

export interface EventSync {
  state: EventSyncState
  lastPushedAt?: string
  lastError?: string
}

export interface CalendarEvent {
  id: string
  title: string
  start: string
  end: string
  allDay: boolean
  notes?: string
  source: 'local' | 'google' | 'outlook'
  provider?: string
  externalId?: string
  /** Deep-link back to the source (e.g. "Open in Google Calendar"). */
  htmlLink?: string
  /** Google-only: true when the event's calendar allows writes (owner/writer). */
  writable?: boolean
  /** Google's `updated` at last sync — the echo-loop watermark (M14). */
  googleUpdatedAt?: string
  /** Google mirror lifecycle for local events (M14 two-way sync). */
  sync?: EventSync
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

/** Editing/deleting a Google event carries its link so the change targets the
 *  same Google event (and the pulled copy dedups). */
export interface AdoptEventInput extends EventCreateInput {
  provider?: string
  externalId?: string
  googleUpdatedAt?: string
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
  /** Adopt a Google event as a local, editable event linked back to Google. */
  adopt: (input: AdoptEventInput) => Promise<CalendarEvent>
  /** Delete a Google-originated event from the app (and from Google). */
  deleteExternal: (link: AdoptEventInput) => Promise<{ ok: boolean }>
  /** Retry any pending Google pushes/deletes (offline backlog). */
  reconcile: () => Promise<void>
  /** Fires when a background Google sync changes events on disk. */
  onChanged: (cb: () => void) => () => void
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

export interface LoopbackApi {
  /** Arm exactly one system-audio capture grant (synchronous; call right before
   *  getDisplayMedia, only after consent is recorded). */
  arm: () => void
  /** Clear a pending arm (e.g. if capture was cancelled). */
  disarm: () => void
  /** Open the macOS Screen & System Audio Recording settings pane. */
  openScreenSettings: () => Promise<{ ok: boolean }>
}

export interface GoogleCalendarSummary {
  id: string
  summary: string
  primary: boolean
}

export interface GoogleApi {
  /** connected = a stored token exists; configured = client id/secret present;
   *  mode = whether two-way sync (write) is enabled. */
  getStatus: () => Promise<{
    connected: boolean
    configured: boolean
    mode: 'readonly' | 'readwrite'
  }>
  /** Runs the read-only browser OAuth flow; resolves when the user finishes. */
  connect: () => Promise<{ ok: true } | { ok: false; error: string }>
  /** Runs the two-way (write) OAuth flow, requesting the calendar.events scope. */
  connectWrite: () => Promise<{ ok: true } | { ok: false; error: string }>
  disconnect: () => Promise<{ ok: boolean }>
  /** Read-only proof call: lists the user's calendars. */
  listCalendars: () => Promise<
    { ok: true; calendars: GoogleCalendarSummary[] } | { ok: false; error: string }
  >
  /** Pull recent + upcoming events from Google into the local read-only cache. */
  pullEvents: () => Promise<{ ok: true; events: CalendarEvent[] } | { ok: false; error: string }>
  /** The last-pulled events from the local cache (instant, no network). */
  cachedEvents: () => Promise<CalendarEvent[]>
}

export type BackupPushResult =
  | { ok: true; pushed: { tasks: number; events: number; calls: number } }
  | { ok: false; error: string }

export type BackupRestoreResult =
  | { ok: true; imported: { tasks: number; events: number; calls: number } }
  | { ok: false; error: string }

export interface BackupStatus {
  lastPushAt?: string
  lastSyncAt?: string
  // Tracked separately so a successful push can't silently clear a genuine
  // pull (restore) failure, or vice versa.
  lastPushError?: string
  lastPushErrorAt?: string
  lastPullError?: string
  lastPullErrorAt?: string
}

export interface BackupApi {
  /** Force a backup now (the "Back up now" button). */
  pushNow: () => Promise<BackupPushResult>
  /** Full sync: restore (pull + reconcile) then push. */
  syncNow: () => Promise<{ pull: BackupRestoreResult; push: BackupPushResult }>
  /** Last-backed-up time / last error, for the trust UI. */
  getStatus: () => Promise<BackupStatus>
  /** Fires when a restore changed tasks/calls on disk (screens should re-read). */
  onChanged: (cb: () => void) => () => void
}

export interface VirtualMicStatus {
  /** The Core Audio driver is installed (the "Sales OS Microphone" device exists). */
  driverInstalled: boolean
  /** A michelper binary was found and can be launched. */
  helperAvailable: boolean
  /** The denoiser helper is currently running. */
  helperRunning: boolean
  /** The helper reported its denoiser actually loaded (vs raw passthrough). */
  denoiseActive: boolean
  /** Resolved helper binary path, or null if not found (diagnostics). */
  helperPath: string | null
}

export interface VirtualMicApi {
  /** Current driver/helper/denoise status. */
  getStatus: () => Promise<VirtualMicStatus>
  /** Start the denoiser helper. */
  start: () => Promise<{ ok: boolean; error?: string }>
  /** Stop the denoiser helper. */
  stop: () => Promise<{ ok: boolean }>
  /** Fires when the helper's running/denoise state changes. */
  onChanged: (cb: (status: VirtualMicStatus) => void) => () => void
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
      loopback: LoopbackApi
      google: GoogleApi
      backup: BackupApi
      virtualmic: VirtualMicApi
    }
  }
}
