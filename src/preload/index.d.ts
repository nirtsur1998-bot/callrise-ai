import { ElectronAPI } from '@electron-toolkit/preload'
import type { DetectedCall, DetectorEvent, DetectorState } from '../main/detection/types'

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
    /** Only restart if the current main-process session has this id (guards
     *  against a stale restart from an older call clobbering a newer one). */
    expectedSessionId?: number
  }) => Promise<{ ok: boolean; error?: 'no-key' | 'stale'; sessionId?: number }>
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
  /** The contact this call is linked to (manual, or confirmed from a calendar
   *  match) — the CRM foundation's call-history link. */
  contactId?: string
}

export interface CallSummary extends CallBase {
  hasSummary: boolean
  attachmentCount: number
  hasCoaching: boolean
  coachScore?: number
  /** True once this call has been read for Objection Library mining. */
  objectionsMined: boolean
}

export interface Call extends CallBase {
  segments: CallSegment[]
  summary?: Summary
  attachments?: Attachment[]
  coaching?: CoachingReport
  consent?: ConsentRecord
  objectionsMinedAt?: string
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
  /** The contact this task is tied to, if any — powers the follow-up dashboard. */
  contactId?: string
  /** The specific deal this task is tied to, if any. */
  dealId?: string
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
  contactId?: string
  dealId?: string
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

// --- Objection Library (mining step) ----------------------------------------

export type MinedObjectionType = 'price' | 'timing' | 'competitor' | 'approval' | 'trust' | 'other'

/** One mined objection→response pair. A SUGGESTION for human review, not a
 *  fact — recoveredWell/judgmentNote are the model's best read of the
 *  surrounding conversation. */
export interface MinedObjectionCandidate {
  type: MinedObjectionType
  objectionQuote: string
  objectionSpeaker: number
  objectionVerified: boolean
  responseQuote: string
  responseSpeaker: number
  responseVerified: boolean
  recoveredWell: boolean
  judgmentNote: string
}

export type ObjectionMiningResult =
  | { ok: true; candidates: MinedObjectionCandidate[] }
  | { ok: false; error: 'no-key' | 'disabled' | 'failed'; message?: string }

// --- Objection Library (review queue, step 3) -------------------------------

/** A mined candidate staged for human review — not yet a real script. */
export interface ObjectionQueueItem {
  id: string
  type: MinedObjectionType
  objectionQuote: string
  objectionSpeaker: number
  responseQuote: string
  responseSpeaker: number
  recoveredWell: boolean
  judgmentNote: string
  callId: string
  callTitle: string
  createdAt: string
}

export interface ObjectionApproveEdits {
  trigger?: string
  response?: string
}

export type ObjectionApproveResult = { ok: true; entry: KnowledgeEntry } | { ok: false }

export interface ObjectionQueueApi {
  list: () => Promise<ObjectionQueueItem[]>
  /** Approve as-is (omit edits) or edit-then-approve (edits override the
   *  mined quotes) — the only path that creates a real objection script. */
  approve: (id: string, edits?: ObjectionApproveEdits) => Promise<ObjectionApproveResult>
  reject: (id: string) => Promise<{ ok: boolean }>
}

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
  /** Objection Library: mine a single call for raw candidates, for the rep to
   *  judge quality — gated on the settings toggle. */
  mineObjectionsTest: (callId: string) => Promise<ObjectionMiningResult>
  /** Send mined candidates into the review queue (still gated on the toggle). */
  enqueueObjections: (
    callId: string,
    candidates: MinedObjectionCandidate[]
  ) => Promise<{ ok: boolean; added: number }>
  /** How many past calls have a transcript but haven't been mined yet — shown
   *  before the user confirms the manual "scan past calls" batch run. */
  objectionScanEstimate: () => Promise<{ eligibleCount: number }>
  /** Mine every not-yet-mined call with a transcript, one at a time. Gated on
   *  the toggle; only ever run when the user explicitly clicks the button. */
  scanPastCallsForObjections: () => Promise<{
    ok: boolean
    scanned: number
    candidatesAdded: number
    /** Calls that errored (rate limit, network) — still eligible for a retry. */
    failed: number
    /** Set when the scan stopped early: the toggle was turned off mid-scan,
     *  or repeated API errors made continuing pointless. */
    stopped?: 'disabled' | 'errors'
  }>
  /** AI Note Taker's auto-title feature: generate + save a title in one step. */
  generateTitle: (callId: string) => Promise<{ ok: true; title: string } | { ok: false }>
  /** Link (contactId) or clear (null) the contact this call belongs to. */
  setContact: (callId: string, contactId: string | null) => Promise<Call | null>
  /** Bookmark a moment mid-call ("clip this") — atMs from call start, plus the
   *  transcript text at that point. */
  addBookmark: (callId: string, atMs: number, text: string) => Promise<Call | null>
  removeBookmark: (callId: string, bookmarkId: string) => Promise<Call | null>
  /** Renders the call's coaching report as a PDF and prompts the user to save
   *  it. Returns the saved path on success, or 'canceled'/'no-report'/'failed'. */
  exportCoachingPdf: (
    callId: string
  ) => Promise<{ ok: true; path: string } | { ok: false; error: string }>
}

export interface TasksApi {
  list: () => Promise<Task[]>
  create: (input: TaskCreateInput) => Promise<Task>
  update: (id: string, patch: TaskUpdateInput) => Promise<Task | null>
  delete: (id: string) => Promise<{ ok: boolean }>
  generateFromCall: (callId: string) => Promise<GenerateTasksResult>
}

/** A comment left on a contact — either the rep's own note, or an AI-drafted
 *  one from a linked call (opt-in, Settings → CRM → "Auto-generate notes"). */
export interface ContactComment {
  id: string
  text: string
  createdAt: string
  source: 'user' | 'ai'
}

export interface Contact {
  id: string
  name: string
  /** Free-text company name — not a separate entity yet (a later CRM phase). */
  company?: string
  /** The rep's own customer/account number for this person (free text). */
  cid?: string
  /** When this person became a customer (date-only ISO string, yyyy-mm-dd). */
  registeredAt?: string
  /** ISO 3166-1 alpha-2 country of the client, e.g. "US". */
  country?: string
  email?: string
  /** ISO 3166-1 alpha-2 country the phone number's dial code belongs to. */
  phoneCountry?: string
  /** National number only (no dial code — that's phoneCountry). */
  phone?: string
  notes?: string
  createdAt: string
  /** Last modification (create or edit); a future backup's "newest wins" key. */
  updatedAt: string
  comments?: ContactComment[]
}

export interface ContactCreateInput {
  name: string
  company?: string | null
  cid?: string | null
  registeredAt?: string | null
  country?: string | null
  email?: string | null
  phoneCountry?: string | null
  phone?: string | null
  notes?: string | null
}

export interface ContactUpdateInput {
  name?: string
  company?: string | null
  cid?: string | null
  registeredAt?: string | null
  country?: string | null
  email?: string | null
  phoneCountry?: string | null
  phone?: string | null
  notes?: string | null
}

export interface ContactsApi {
  list: () => Promise<Contact[]>
  create: (input: ContactCreateInput) => Promise<Contact | null>
  update: (id: string, patch: ContactUpdateInput) => Promise<Contact | null>
  /** `reason: 'has-deals'` = blocked because deals still reference this
   *  contact (delete or re-assign them first — mirrors stage removal). */
  delete: (id: string) => Promise<{ ok: boolean; reason?: 'has-deals' }>
  addComment: (id: string, text: string) => Promise<Contact | null>
  removeComment: (id: string, commentId: string) => Promise<Contact | null>
}

export type DealStageKind = 'open' | 'won' | 'lost'

export interface DealStage {
  id: string
  label: string
  kind: DealStageKind
}

export type SetDealStagesResult =
  { ok: true; stages: DealStage[] } | { ok: false; error: 'empty' | 'stage-in-use' }

export type DealRiskLevel = 'low' | 'medium' | 'high'

export interface DealRiskReason {
  text: string
  /** Which linked call this reason is based on, if any. */
  callId?: string
  callTitle?: string
}

export interface DealRiskAssessment {
  level: DealRiskLevel
  summary: string
  reasons: DealRiskReason[]
  suggestedAction: string
  model: string
  createdAt: string
}

export type AssessDealRiskResult =
  | { ok: true; assessment: DealRiskAssessment }
  | { ok: false; error: 'no-key' | 'failed'; message?: string }

export interface Deal {
  id: string
  title: string
  contactId: string
  stageId: string
  value?: number
  expectedCloseDate?: string
  notes?: string
  createdAt: string
  updatedAt: string
  /** Phase 5 Step 1 — the last AI risk assessment run on this deal, if any.
   *  Manually triggered, cached until re-run. */
  riskAssessment?: DealRiskAssessment
}

export interface DealCreateInput {
  title: string
  contactId: string
  stageId?: string
  value?: number | null
  expectedCloseDate?: string | null
  notes?: string | null
}

export interface DealUpdateInput {
  title?: string
  contactId?: string
  stageId?: string
  value?: number | null
  expectedCloseDate?: string | null
  notes?: string | null
}

export interface DealsApi {
  list: () => Promise<Deal[]>
  create: (input: DealCreateInput) => Promise<Deal | null>
  update: (id: string, patch: DealUpdateInput) => Promise<Deal | null>
  delete: (id: string) => Promise<{ ok: boolean }>
  /** Manual, per-deal AI risk assessment (Phase 5 Step 1) — never automatic. */
  assessRisk: (id: string) => Promise<AssessDealRiskResult>
}

export interface DealStagesApi {
  get: () => Promise<DealStage[]>
  set: (stages: DealStage[]) => Promise<SetDealStagesResult>
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
  /** Google/Outlook-only: true when the event's calendar allows writes. */
  writable?: boolean
  /** Google/Outlook-only: other invitees (the connected account itself is
   *  excluded when the provider can tell) — the CRM's calendar-match signal
   *  for suggesting who a call was with. */
  attendees?: { email: string; name?: string }[]
  /** The linked provider's own "last updated" at last sync — the echo-loop
   *  watermark (M14). */
  remoteUpdatedAt?: string
  /** Google/Outlook mirror lifecycle for local events (M14 two-way sync). */
  sync?: EventSync
  /** The contact/deal this event is with, if linked from the New/Edit Event
   *  dialog — app-local metadata only, never pushed to Google/Outlook. Powers
   *  the follow-up dashboard's "next scheduled meeting" line. */
  contactId?: string
  dealId?: string
  createdAt: string
  updatedAt: string
}

export interface EventCreateInput {
  title: string
  start: string
  end: string
  allDay?: boolean
  notes?: string | null
  contactId?: string | null
  dealId?: string | null
}

/** Editing/deleting a Google/Outlook event carries its link so the change
 *  targets the same remote event (and the pulled copy dedups). */
export interface AdoptEventInput extends EventCreateInput {
  provider?: string
  externalId?: string
  remoteUpdatedAt?: string
}

export interface EventUpdateInput {
  title?: string
  start?: string
  end?: string
  allDay?: boolean
  notes?: string | null
  contactId?: string | null
  dealId?: string | null
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
  updateName: (name: string) => Promise<SimpleAuthResult>
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

export interface OutlookCalendarSummary {
  id: string
  summary: string
  primary: boolean
}

/** Same shape as GoogleApi, aimed at Microsoft Graph instead. */
export interface OutlookApi {
  getStatus: () => Promise<{
    connected: boolean
    configured: boolean
    mode: 'readonly' | 'readwrite'
  }>
  connect: () => Promise<{ ok: true } | { ok: false; error: string }>
  connectWrite: () => Promise<{ ok: true } | { ok: false; error: string }>
  disconnect: () => Promise<{ ok: boolean }>
  listCalendars: () => Promise<
    { ok: true; calendars: OutlookCalendarSummary[] } | { ok: false; error: string }
  >
  pullEvents: () => Promise<{ ok: true; events: CalendarEvent[] } | { ok: false; error: string }>
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
  /** `<id>.conflict` files across the stores — the losing sides of two-device
   *  concurrent edits, kept beside the store so nothing is silently lost. */
  conflictCount: number
}

export interface BackupApi {
  /** Force a backup now (the "Back up now" button). */
  pushNow: () => Promise<BackupPushResult>
  /** Full sync: restore (pull + reconcile) then push. */
  syncNow: () => Promise<{ pull: BackupRestoreResult; push: BackupPushResult }>
  /** Last-backed-up time / last error, for the trust UI. */
  getStatus: () => Promise<BackupStatus>
  /** Reveal the first `<id>.conflict` file in Finder (they're plain JSON —
   *  the kept "losing" copy of a two-device concurrent edit). */
  revealConflicts: () => Promise<{ ok: boolean }>
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

export type AiKeyName = 'DEEPGRAM_API_KEY' | 'ANTHROPIC_API_KEY'

export interface AiKeyStatus {
  /** True once real API calls will succeed for this key — a Settings-saved
   *  key, or a developer .env value, either way. */
  configured: boolean
  /** Masked preview ("sk-ant-…UD2I") for display only — never the raw key. */
  hint: string | null
}

export interface AiKeysApi {
  getStatus: () => Promise<Record<AiKeyName, AiKeyStatus>>
  /** Saved key takes effect after the app is restarted. */
  save: (name: AiKeyName, value: string) => Promise<{ ok: boolean; error?: string }>
  clear: (name: AiKeyName) => Promise<{ ok: boolean; error?: string }>
}

export interface VirtualMicApi {
  /** Current driver/helper/denoise status. */
  getStatus: () => Promise<VirtualMicStatus>
  /** Start the denoiser helper. */
  start: () => Promise<{ ok: boolean; error?: string }>
  /** Stop the denoiser helper. */
  stop: () => Promise<{ ok: boolean }>
  /** One-click install of the HAL driver (still shows the OS's own admin
   *  password prompt — that part can't be automated away). */
  installDriver: () => Promise<{ ok: boolean; error?: string }>
  /** Fires when the helper's running/denoise state changes. */
  onChanged: (cb: (status: VirtualMicStatus) => void) => () => void
}

export type KnowledgeCategory = 'objection' | 'product' | 'playbook'

interface KnowledgeEntryBase {
  id: string
  category: KnowledgeCategory
  createdAt: string
  /** Last modification (create or edit); a future backup's "newest wins" key. */
  updatedAt: string
}

/** Objection-handling script: what the buyer says, and how I respond. */
export interface ObjectionEntry extends KnowledgeEntryBase {
  category: 'objection'
  trigger: string
  response: string
}

/** A free-text section: product info or a playbook section. */
export interface TextEntry extends KnowledgeEntryBase {
  category: 'product' | 'playbook'
  title: string
  body: string
}

export type KnowledgeEntry = ObjectionEntry | TextEntry

export interface KnowledgeCreateInput {
  category: KnowledgeCategory
  trigger?: string
  response?: string
  title?: string
  body?: string
}

export interface KnowledgeUpdateInput {
  trigger?: string
  response?: string
  title?: string
  body?: string
}

export type KnowledgeSizeLevel = 'ok' | 'large' | 'over'

export interface KnowledgeContextPreview {
  text: string
  charCount: number
  estimatedTokens: number
  level: KnowledgeSizeLevel
}

export interface KnowledgeApi {
  list: () => Promise<KnowledgeEntry[]>
  create: (input: KnowledgeCreateInput) => Promise<KnowledgeEntry | null>
  update: (id: string, patch: KnowledgeUpdateInput) => Promise<KnowledgeEntry | null>
  delete: (id: string) => Promise<{ ok: boolean }>
  /** The exact text block Claude would be given as context, plus a size estimate. */
  preview: () => Promise<KnowledgeContextPreview>
}

export type Pronoun = 'he' | 'she' | 'they' | ''

export interface PersonalizationSettings {
  name: string
  role: string
  pronoun: Pronoun
  about: string
}

export type SummaryLanguage =
  | 'auto'
  | 'english'
  | 'spanish'
  | 'french'
  | 'german'
  | 'portuguese'
  | 'italian'
  | 'dutch'
  | 'polish'
  | 'turkish'
  | 'russian'
  | 'arabic'
  | 'hindi'
  | 'chinese'
  | 'japanese'
  | 'korean'
  | 'vietnamese'
  | 'indonesian'

/** Which optional categories back up to the cloud, on top of the always-on
 *  Tasks/Calendar events/Call metadata. All default OFF — opt-in only. */
export interface BackupSyncScope {
  /** Buyer transcripts + coaching evidence quotes (normally stripped before backup). */
  transcripts: boolean
  /** Attached document blobs (Supabase Storage), not just their metadata. */
  attachments: boolean
  knowledgeBase: boolean
  settingsPersonalization: boolean
  contacts: boolean
}

/** Objection Library mining master switch. OFF by default — the only gate
 *  for whether any call transcript is ever read for objection mining. */
export interface ObjectionMiningSettings {
  enabled: boolean
}

export type MatchSensitivity = 'tight' | 'normal' | 'loose'

export interface CrmSettings {
  /** Master kill switch for the calendar-match suggestion banner. */
  calendarMatchEnabled: boolean
  /** How wide the time window is when matching a call to a calendar event. */
  matchSensitivity: MatchSensitivity
  /** Opt-in: auto-link when there's exactly one unambiguous match to an
   *  EXISTING contact. Never auto-creates a contact. */
  autoLinkUnambiguous: boolean
  /** ISO 3166-1 alpha-2, or '' for none — pre-fills new contacts' country. */
  defaultCountry: string
  autoNumberCid: boolean
  cidPrefix: string
  /** The next sequential number to assign (incremented on each auto-assign). */
  cidNextNumber: number
  /** Master kill switch for "needs follow-up" flagging on deals. */
  staleFollowUpEnabled: boolean
  /** A deal is flagged once its contact's last call is older than this many
   *  days (or there's never been a call at all). */
  staleAfterDays: number
  /** Opt-in: when a call gets linked to a contact (and has a transcript),
   *  send it to Claude for a short CRM note appended to that contact. */
  autoGenerateNotes: boolean
}

export type CapturePolicyValue = 'full' | 'mic-only' | 'ask'
export type AppOverride = 'full' | 'mic-only' | 'ask' | 'never'

/** Maps 1:1 onto main/detection/policy.ts's CapturePolicySettings. */
export interface CapturePolicySettings {
  autoCapturePolicy: CapturePolicyValue
  appOverrides: Record<string, AppOverride>
}

/** Ambient call detection (M15). `enabled` is the ff_ambient_detection feature flag — OFF by default. */
export interface DetectionSettings {
  enabled: boolean
  capturePolicy: CapturePolicySettings
}

export interface AppSettings {
  /** Master switch: OFF removes all buyer/other-party recording capability.
   *  Can only remove capability, never grant it — per-call consent still
   *  fully governs actual recording. Defaults to true. */
  allowOtherPartyRecording: boolean
  /** Who the rep is — fed into summary/coaching prompts. Empty by default. */
  personalization: PersonalizationSettings
  /** Language for AI summaries. 'auto' = same language as the source content. */
  summaryLanguage: SummaryLanguage
  /** Optional cloud-backup categories (Privacy & data), all off by default. */
  syncScope: BackupSyncScope
  /** "Newest wins" cursor for when this whole object is synced to the cloud. */
  settingsUpdatedAt: string
  /** Non-secret marker: has Google Calendar been connected on any device for
   *  this account? Never the OAuth token itself. */
  googleCalendarConnected: boolean
  /** Same non-secret marker as googleCalendarConnected, for Outlook Calendar. */
  outlookCalendarConnected: boolean
  /** CRM Phase 1 — calendar-match sensitivity/kill-switch, default country,
   *  and auto-numbered customer IDs. */
  crm: CrmSettings
  /** Objection Library mining master switch. Defaults OFF. */
  objectionMining: ObjectionMiningSettings
  /** Ambient call detection (M15). Defaults OFF. */
  detection: DetectionSettings
}

export interface AppSettingsPatch {
  allowOtherPartyRecording?: boolean
  /** Partial — only the keys present are changed; others are left as-is. */
  personalization?: Partial<PersonalizationSettings>
  summaryLanguage?: SummaryLanguage
  /** Partial — only the keys present are changed; others are left as-is. */
  syncScope?: Partial<BackupSyncScope>
  googleCalendarConnected?: boolean
  outlookCalendarConnected?: boolean
  /** Partial — only the keys present are changed; others are left as-is. */
  crm?: Partial<CrmSettings>
  /** Partial — only the keys present are changed; others are left as-is. */
  objectionMining?: Partial<ObjectionMiningSettings>
  /** Partial — only the keys present are changed; others are left as-is.
   *  `capturePolicy.appOverrides`, if present, REPLACES the whole map (not a per-key merge) - always send the full merged object. */
  detection?: { enabled?: boolean; capturePolicy?: Partial<CapturePolicySettings> }
}

export interface AppSettingsApi {
  get: () => Promise<AppSettings>
  update: (patch: AppSettingsPatch) => Promise<AppSettings>
  /** The exact text block Claude would be given about the rep. */
  previewPersonalization: () => Promise<{ text: string; charCount: number }>
}

/** OS-level "launch at login" — no separate storage, the OS is the source of truth. */
export interface AppControlApi {
  getLaunchAtLogin: () => Promise<boolean>
  setLaunchAtLogin: (value: boolean) => Promise<boolean>
  /** The frontmost app's name right now, or null if detection is unavailable
   *  (permission not granted, unsupported platform, or a detection failure —
   *  always fail-open, never block auto-start on this being null). */
  getActiveApp: () => Promise<string | null>
  /** The app the rep was using BEFORE switching into this one (sampled while
   *  our window is unfocused) — the value the auto-start exclusion check
   *  needs, since the frontmost app at check time is always this app itself.
   *  Null until anything was observed; same fail-open rule as getActiveApp. */
  getLastExternalApp: () => Promise<string | null>
  /** Fires when the frontmost app (while our window is blurred) matches a
   *  known calling app (WhatsApp, Zoom, Teams, MicroSIP, …) — a best-effort
   *  heuristic, not a guarantee a call is actually happening. Payload is the
   *  detected app's display name. Returns an unsubscribe function. */
  onCallDetected: (cb: (appName: string) => void) => () => void
  /** True for an installed/packaged build, false when running from source
   *  via `npm run dev` — lets the renderer show the right "how to fix this"
   *  instructions (relaunch the app vs. restart the dev server). */
  isPackaged: () => Promise<boolean>
}

/**
 * Ambient call detection (M15). Feature-flagged off by default
 * (app-settings.ts's `detection.enabled`) - with it off, every event here
 * simply never fires and every command is a safe no-op.
 */
export interface DetectionApi {
  getState: () => Promise<DetectorState | undefined>
  /** Ack a `onStartCapture` command once the renderer has actually started recording. */
  captureStarted: (payload: { callId: string; sessionId: string }) => Promise<void>
  /** Tell main the renderer couldn't start recording (mic busy, permission denied, …). */
  captureFailed: (payload: { callId: string }) => Promise<void>
  /** Response to an 'ask' policy's detection toast. */
  respondToDetection: (decision: 'accept' | 'decline') => Promise<void>
  /** Response to the second-call switch prompt. */
  respondToSwitch: (decision: 'switch' | 'keep') => Promise<void>
  pause: () => Promise<void>
  resume: () => Promise<void>
  /** Manually stop the current capture (reason: 'user-stopped'). */
  stop: () => Promise<void>
  /** Pause detection for N minutes, then resume automatically. */
  snooze: (minutes: number) => Promise<void>
  onStateChanged: (cb: (payload: { state: DetectorState }) => void) => () => void
  onEvent: (cb: (event: DetectorEvent) => void) => () => void
  /** 'ask' policy: show a detection toast for this call. */
  onCallDetected: (cb: (call: DetectedCall) => void) => () => void
  onSwitchOffered: (
    cb: (payload: { current: DetectedCall; pending: DetectedCall }) => void
  ) => () => void
  /** Main has decided to start capturing this call - the renderer must actually begin recording and ack via captureStarted/captureFailed. */
  onStartCapture: (
    cb: (payload: { call: DetectedCall; mode: 'full' | 'mic-only' }) => void
  ) => () => void
  /** Known conferencing apps (id + display name only) for the per-app override editor. */
  getKnownApps: () => Promise<{ appId: string; displayName: string }[]>
  /** Overlay banner's "Open CallRise AI" button - brings the main window to front. */
  openMainWindow: () => Promise<void>
  /** Overlay banner's Stop button - broadcasts a request; the main window's LiveView acts on it. */
  requestStopCapture: () => Promise<void>
  /** Overlay banner's Pause/Resume button - broadcasts a request; the main window's LiveView acts on it. */
  requestTogglePause: () => Promise<void>
  onRequestStopCapture: (cb: () => void) => () => void
  onRequestTogglePause: (cb: () => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      transcription: TranscriptionApi
      calls: CallsApi
      tasks: TasksApi
      contacts: ContactsApi
      deals: DealsApi
      dealStages: DealStagesApi
      events: EventsApi
      auth: AuthApi
      loopback: LoopbackApi
      google: GoogleApi
      outlook: OutlookApi
      backup: BackupApi
      virtualmic: VirtualMicApi
      knowledge: KnowledgeApi
      objectionQueue: ObjectionQueueApi
      settings: AppSettingsApi
      app: AppControlApi
      aiKeys: AiKeysApi
      detection: DetectionApi
    }
  }
}
