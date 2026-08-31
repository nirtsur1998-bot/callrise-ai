import { ElectronAPI } from '@electron-toolkit/preload'
import type { DetectedCall, DetectorEvent, DetectorState } from '../main/detection/types'
import type { UpdateStatus } from '../main/updater'
// M26 4.3 — the live-transcript wire format, defined once in main and re-exported
// so the renderer describes the protocol with the same types that produce it.
import type { AttachSnapshot, TranscriptPatch } from '../main/live/transcript-patch'

export type { AttachSnapshot, TranscriptPatch }

export type MicAccessStatus = 'granted' | 'denied' | 'restricted' | 'not-determined'

export interface TranscriptionStateEvent {
  state: 'idle' | 'connecting' | 'listening' | 'reconnecting' | 'error'
  attempt?: number
}

export interface TranscriptWord {
  speaker: number
  text: string
  /** 0 = the rep's mic, 1 = the other party. Absent on mono calls. */
  channel?: number
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
  /** Which speaker-label namespace `words[].speaker` belongs to. Bumped on
   *  every Deepgram (re)connection and on the mono↔multichannel swap, because
   *  both restart labelling from scratch. Consumers must not merge or
   *  attribute across a change. */
  speakerEpoch: number
  /** False when Deepgram returned no speaker labels for these words — the old
   *  code silently defaulted those to speaker 0, which made "unknown" look
   *  identical to "the rep". */
  speakerCertain: boolean
  /** Lowest per-word confidence in this result, when Deepgram reported any. */
  minConfidence: number | null
  /** True when labels are CHANNELS (0 = rep, 1 = buyer) rather than a
   *  diarization guess — i.e. attribution is deterministic. */
  multichannel: boolean
}

export interface TranscriptionErrorEvent {
  message: string
}

export interface PostCallBrief {
  brief: string
  nextSteps: string[]
  email: { subject: string; body: string }
  model: string
  createdAt: string
}

export type PostCallBriefEvent =
  | { ok: true; brief: PostCallBrief; copied: boolean }
  | { ok: false; error: 'no-key' | 'failed' | 'empty-call'; message?: string }

/** The durable consent gate: main reads capture permission from disk, never
 *  from the renderer's word for it (acceptance criterion 11). */
export interface ConsentGateApi {
  /** Write this call's consent. Returns false when it does not permit
   *  capture. Keyed on callId, not sessionId — M27 E1, see
   *  main/consent-gate.ts's own doc comment for why. */
  persist: (callId: string, consent: ConsentRecord) => boolean
  /** Drop the record — call ended, or consent revoked. */
  clear: () => void
}

export interface TranscriptionGapEvent {
  /** How much audio was lost. */
  durationMs: number
  /** Why: backlog dropped to rejoin the live edge, queue overflow, or a suspend. */
  reason: 'reconnect' | 'shed' | 'sleep'
  /** Ready-to-render marker, e.g. `[gap: 34s]`. */
  marker: string
}

export interface TranscriptionHealthEvent {
  /** Seconds of audio handed to the socket, cumulative across reconnects. */
  submittedSec: number
  /** Seconds Deepgram has acknowledged, on the same cumulative scale. */
  acknowledgedSec: number
  lagSec: number
  /** The 5-sample median the watchdog actually acts on. */
  medianLagSec: number
  tier: 'none' | 'warn' | 'shed' | 'reset'
  queuedSec: number
  shedSec: number
  resets: number
  gaps: ReadonlyArray<{ atMs: number; durationMs: number; reason: string }>
  liveness: 'ok' | 'silent' | 'capture-dead' | 'socket-dead'
  /** Parts-per-million deviation of the declared sample rate from the actual
   *  arrival rate. A healthy clock sits inside roughly ±100ppm. */
  driftPpm: number
  /** Audio frames this session refused because they came from a capture
   *  pipeline other than the one it was started for — e.g. a recorder left
   *  over from an earlier, already-ended call. Any value above 0 means that
   *  happened during this session. */
  rejectedProducerFrames: number
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
    /** Names the capture pipeline that will feed this session. Main refuses
     *  audio from any other producer in the same window — see
     *  StartOptions.producerId in main/transcription.ts for why the window
     *  alone was insufficient. */
    producerId?: number
  }) => Promise<{ ok: boolean; error?: 'no-key' | 'stale'; sessionId?: number }>
  sendAudio: (chunk: ArrayBuffer, producerId?: number) => void
  requestAudioPort: () => void
  reportAudioDropped: (frames: number, producerId?: number) => void
  /** `session: null` is the ONLY affirmative "there is no call in progress"
   *  answer in the system. Nothing else may conclude that — not a timeout,
   *  not a default. */
  stop: () => Promise<{ ok: boolean; session: null }>
  /** M26 4.3 — what main knows about the call in progress, asked on mount. */
  attach: () => Promise<AttachSnapshot>
  /** M26 4.4 — "the view went away", never "the call ended". A pure signal;
   *  main does not stop, pause, or otherwise react to the session on it. */
  detach: () => Promise<{ ok: true }>
  /** M26 4.3 — transcript deltas from main, which owns the transcript. */
  onSegments: (cb: (payload: TranscriptPatch) => void) => () => void
  onState: (cb: (payload: TranscriptionStateEvent) => void) => () => void
  onTranscript: (cb: (payload: TranscriptResultEvent) => void) => () => void
  onError: (cb: (payload: TranscriptionErrorEvent) => void) => () => void
  onUtteranceEnd: (cb: (payload: Record<string, never>) => void) => () => void
  /** Fires after a stopped session's connection has fully closed (flush done). */
  onClosed: (cb: (payload: Record<string, never>) => void) => () => void
  /** Audio that will never be transcribed — shed, discarded on reconnect, or
   *  lost to a suspend. Surfaced as a `[gap: Ns]` marker in the transcript so
   *  two distant moments are never silently spliced together. */
  onGap: (cb: (payload: TranscriptionGapEvent) => void) => () => void
  /** 1Hz session-health snapshot (lag cursors, queue, shed, liveness). */
  onHealth: (cb: (payload: TranscriptionHealthEvent) => void) => () => void
  /** No audio callbacks for ~10s: the capture device is gone, reacquire. */
  onCaptureLost: (cb: (payload: { forMs: number }) => void) => () => void
  onBuyerSilent: (cb: (payload: { reason: string }) => void) => () => void
  /** M19 Task 2 Part A — Deepgram's claimed channel disagreed with which
   *  channel actually had the energy for a finalized utterance (the
   *  loudspeaker/echo signature: buyer audio leaking into the mic). Not
   *  fatal, not a reassignment — just a "this attribution may be wrong,
   *  consider headphones" signal, same spirit as onBuyerSilent above. */
  onCrossTalkWarning: (cb: (payload: Record<string, never>) => void) => () => void
  /** M22 — buyer-side capture needed lag corrections faster than they could
   *  recover (a sustained deficit, e.g. Deepgram's own multichannel compute
   *  cost, not a one-off network blip), so main dropped it and the call
   *  continues mic-only. Fired at most once per call. */
  onMultichannelFallback: (cb: (payload: Record<string, never>) => void) => () => void
  /** Async, non-blocking: a short next-question suggestion for live cues. */
  suggestQuestion: (text: string) => Promise<{ ok: true; question: string } | { ok: false }>
  /** Manual mid-call help: sends the running transcript + the rep's question. */
  askCoach: (
    transcript: string,
    question: string,
    /** 1.2.5 hotfix, M27 E1 — see main/live-cue.ts's own doc comment: lets
     *  main check fresh consent before a pass that may include
     *  buyer-attributed content ever reaches an AI prompt. Keyed on callId,
     *  not sessionId (see main/consent-gate.ts's own doc comment for why). */
    callId?: string,
    includesBuyerContent?: boolean
  ) => Promise<
    | { ok: true; headline: string; tips: string[] }
    | { ok: false; message?: string; blockedReason?: 'consent' }
  >
  /** Conversation-aware live cue from a speaker-labeled transcript window. */
  liveCue: (
    transcript: string,
    repSpeaker: number | null,
    /** M26 4.5 (BUG-055) / M27 E1 — see main/live-cue.ts's own doc comment:
     *  lets main check fresh consent before a pass that may include
     *  buyer-attributed content ever reaches an AI prompt. Keyed on callId,
     *  not sessionId. */
    callId?: string,
    includesBuyerContent?: boolean
  ) => Promise<
    | {
        ok: true
        repSpeaker: number | null
        cue: 'objection' | 'discovery' | 'next-question' | 'buying-signal' | 'none'
        text: string
        /** M19 Task 2 step 5 — null unless Settings has self-intro
         *  extraction on AND the other party explicitly said their name. */
        buyerName: string | null
        buyerSpeaker: number | null
      }
    | {
        ok: false
        /** M20 — set only when the whole per-job fallback chain was tried
         *  and every entry failed this cycle (not on "not enough transcript
         *  yet"). Renderer shows a small non-blocking "coaching paused"
         *  indicator, never a modal — see LiveView.tsx. */
        pausedReason?: 'all-models-unavailable' | 'timed-out' | 'quota-exhausted'
        /** M26 4.5 (BUG-055) — never read as "paused"; see main/live-cue.ts. */
        blockedReason?: 'consent'
      }
  >
}

export type SpeakerRole = 'rep' | 'other' | 'unknown'

/** Plain-English custom trackers (§4.8) — the rep types a request, gets a
 *  candidate trigger back, and (once accepted) it's persisted here and fed
 *  into the live BattlecardMatcher alongside the starter library. */
export interface TrackersApi {
  /** Raw, unsanitized AI output — run it through sanitizeGeneratedTrigger
   *  (features/live/battlecards/from-prompt.ts) before trusting it. */
  generate: (
    prompt: string
  ) => Promise<
    { ok: true; raw: unknown } | { ok: false; error: 'no-key' | 'failed'; message?: string }
  >
  list: () => Promise<StoredTracker[]>
  /** Replaces the whole persisted list. */
  save: (trackers: unknown) => Promise<StoredTracker[]>
}

/** M24 §3 — Tier 1 fast micro-analysis. See main/deal-tier1.ts for the full
 *  contract; the renderer builds transcriptDelta/compactState (never sends
 *  the full transcript — token discipline per the milestone spec) and
 *  applies its own confidence-threshold/priority gating (nudgeEngine.ts) to
 *  whatever signals come back. */
export type DealSignalType = 'risk' | 'opportunity' | 'tactical'

export interface DealSignal {
  type: DealSignalType
  subtype: string
  confidence: number
  evidenceQuote: string
  evidenceRole: 'rep' | 'other'
  suggestedCue: string
}

export type DealTier1Result =
  | { ok: true; signals: DealSignal[] }
  | {
      ok: false
      pausedReason?: 'all-models-unavailable' | 'timed-out'
      /** M26 4.5 (BUG-055) — never read as "paused"; see main/deal-tier1.ts. */
      blockedReason?: 'consent'
    }

/** M24 §4 — Tier 2 strategic analysis output. Trajectory is NOT part of this
 *  shape — see deal-intelligence/healthScore.ts's computeTrajectory(), which
 *  the renderer computes itself by comparing successive scores. */
export interface DealHealthFactors {
  engagement: number
  sentiment: number
  objectionStatus: number
  momentum: number
  agendaCoverage: number
}

export interface DealHealthResult {
  score: number
  factors: DealHealthFactors
  topRecommendation: string
}

export type DealTier2Result =
  | { ok: true; result: DealHealthResult }
  | {
      ok: false
      pausedReason?: 'all-models-unavailable' | 'timed-out'
      blockedReason?: 'consent'
    }

export interface DealIntelligenceApi {
  analyzeTier1: (input: {
    transcriptDelta: string
    compactState: string
    dealContext?: string
    triggerReason?: string
    /** M26 4.5 (BUG-055) / M27 E1 — see main/deal-tier1.ts's own doc
     *  comment. Keyed on callId, not sessionId. */
    callId?: string
    includesBuyerContent?: boolean
  }) => Promise<DealTier1Result>
  analyzeTier2: (input: {
    transcriptDelta: string
    compactState: string
    dealContext?: string
    triggerReason?: string
    callId?: string
    includesBuyerContent?: boolean
  }) => Promise<DealTier2Result>
  /** M24 §8 — the feedback loop. */
  recordFeedback: (input: {
    type: DealSignalType
    subtype: string
    helpful: boolean
  }) => Promise<{ ok: boolean }>
  getFeedbackSummary: () => Promise<DealFeedbackSummaryEntry[]>
}

export interface DealFeedbackSummaryEntry {
  type: DealSignalType
  subtype: string
  totalRatings: number
  rejectionRate: number
}

export type StoredTrackerCategory = 'objection' | 'competitor' | 'pricing' | 'process'

export interface StoredTracker {
  id: string
  patterns: string[]
  card: {
    id: string
    label: string
    say: string
    category: StoredTrackerCategory
  }
}

export interface CallSegment {
  speaker: number
  text: string
  /** Speaker-label namespace this `speaker` belongs to (bumped on every
   *  Deepgram reconnect and on the mono↔multichannel swap). Absent pre-M21. */
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
  /** 0 = the rep's mic, 1 = the other party. Absent on mono calls. A hardware
   *  fact, never a diarization guess — the only signal the consent-retention
   *  strip trusts (see calls-fs.ts). Identity is the (channel, speaker) PAIR —
   *  `speaker` alone means different things on either side of a mid-call
   *  switch to buyer capture. */
  channel?: number
  /** A `[gap: Ns]` marker — audio that was never transcribed. Never counted as
   *  speech and never attributed to a speaker. */
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
  questionSpread?: number | null
  buyerQuestionCount?: number
  buyerLongestMonologueWords?: number
  pricingMentions?: number
  pricingMentionsLatePct?: number | null
  nextStepsLocked?: boolean
}

export interface CoachDealContext {
  type: 'transactional' | 'complex' | 'unknown'
  summary: string
  lens: string
}

// --- M23 Coach 2.0 ------------------------------------------------------
export type CallType = 'cold-call' | 'discovery' | 'demo' | 'closing' | 'other'

export type SalesMethodology = 'spin' | 'meddic' | 'meddpicc' | 'challenger' | 'sandler' | 'blended'

export type SkillKey =
  | 'discovery'
  | 'listening'
  | 'objectionHandling'
  | 'valueArticulation'
  | 'pricing'
  | 'momentum'
  | 'rapport'
  | 'methodology'

export type SkillScoreSet = Record<SkillKey, number>

export interface MethodologyAssessment {
  methodology: SalesMethodology
  score: number
  comment: string
  evidence?: CoachEvidence
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
  callType?: CallType
  skills?: SkillScoreSet
  methodologyAdherence?: MethodologyAssessment
  focusSkillAtCoaching?: FocusSkillAtCoaching
}

// --- M23 Workstream B: coaching chat --------------------------------------

export type CoachChatRole = 'user' | 'assistant'
export type CoachChatMode = 'advisor' | 'practice'

export interface CoachChatMessage {
  id: string
  role: CoachChatRole
  text: string
  createdAt: string
  mode?: CoachChatMode
}

export interface CoachChatContextSuggestion {
  id: string
  type: 'kyc' | 'next-steps' | 'call-notes' | 'memory'
  field?: string
  text: string
  confidence: 'high' | 'medium'
  /** M25 Phase 4 — only present when type === 'memory'. */
  memoryScope?: string
  memoryCategory?: string
}

export interface CoachChatSendResult {
  ok: boolean
  reply?: string
  suggestions?: CoachChatContextSuggestion[]
  error?: string
  message?: string
}

export interface CoachChatTaskProposal {
  title: string
  type: 'follow-up' | 'email' | 'meeting' | 'research' | 'general'
  priority: 'low' | 'medium' | 'high'
}

export interface CoachChatDelta {
  callId: string
  delta: string
}

export interface CoachChatStreamError {
  callId: string
  message: string
}

/** M23 Workstream B — advisor Q&A + practice/roleplay chat for one call.
 *  `send`'s own Promise resolves with the FINAL message once the whole
 *  reply has streamed in; subscribe to `onDelta` before calling `send` to
 *  render it incrementally — same shape as transcription's live push
 *  events, since Electron IPC has no native bidirectional streaming. */
export interface CoachChatApi {
  /** `startFreshPractice`: true when the rep just switched INTO practice
   *  mode for a new rehearsal attempt — tells the main process to ignore any
   *  trailing practice turns left over from a session that was never
   *  formally ended with "End practice". */
  send: (
    callId: string,
    message: string,
    mode: CoachChatMode,
    startFreshPractice?: boolean
  ) => Promise<CoachChatSendResult>
  applySuggestion: (
    callId: string,
    suggestion: CoachChatContextSuggestion
  ) => Promise<{ ok: boolean }>
  draftFollowUpEmail: (callId: string) => Promise<CoachChatSendResult>
  proposeTask: (
    callId: string
  ) => Promise<{ ok: true; proposal: CoachChatTaskProposal } | { ok: false; message: string }>
  confirmTask: (callId: string, proposal: CoachChatTaskProposal) => Promise<{ ok: boolean }>
  regenerateCrmNote: (
    callId: string
  ) => Promise<{ ok: true; note: string } | { ok: false; message: string }>
  saveCrmNote: (callId: string, note: string) => Promise<{ ok: boolean }>
  onDelta: (cb: (payload: CoachChatDelta) => void) => () => void
  onError: (cb: (payload: CoachChatStreamError) => void) => () => void
}

// --- M28: the Rise assistant (top-level AI chat section) --------------------

export interface AssistantCitation {
  kind: 'memory' | 'call'
  id: string
  label: string
  /** The [n] marker this citation owns — chips bind by this, never by position. */
  marker?: number
}

/** M28 Part 3 — a file sent with a user message (metadata only). */
export interface AssistantAttachment {
  id: string
  name: string
  kind: 'image' | 'pdf' | 'text'
  mimeType: string
  sizeBytes: number
  extractedChars?: number
}

/** M28 Part 4 — the client a conversation is about, fixed at creation. */
export interface AssistantScope {
  contactId: string
  contactName: string
  company?: string
  dealId?: string
  dealTitle?: string
}

export interface AssistantTaskProposal {
  id: string
  title: string
  type: 'follow-up' | 'email' | 'meeting' | 'research' | 'general'
  priority: 'low' | 'medium' | 'high'
  status: 'pending' | 'accepted'
}

export interface AssistantMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: string
  citations?: AssistantCitation[]
  suggestions?: CoachChatContextSuggestion[]
  appliedSuggestionIds?: string[]
  taskProposals?: AssistantTaskProposal[]
  /** The voice note this user message was dictated from — playback only;
   *  the message TEXT is the reviewed transcript and is all the AI sees. */
  voiceNote?: { mediaId: string; durationMs: number }
  attachments?: AssistantAttachment[]
}

export interface AssistantConversation {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messages: AssistantMessage[]
  /** "Don't learn from this conversation" — see AssistantApi.setSalesBrainExcluded. */
  salesBrainExcluded?: boolean
  scope?: AssistantScope
}

export interface AssistantConversationMeta {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
  preview: string
  scope?: AssistantScope
}

export interface AssistantSendResult {
  ok: boolean
  /** 'attachment-mismatch' (2026-08-24): a staged file belonged to a
   *  different conversation and was refused rather than sent. */
  error?:
    | 'not-found'
    | 'busy'
    | 'empty'
    | 'ai-failed'
    | 'cancelled'
    | 'attachment-mismatch'
    | 'too-many-documents'
  message?: string
  reply?: string
  citations?: AssistantCitation[]
  suggestions?: CoachChatContextSuggestion[]
  stopped?: boolean
  userMessageId?: string
}

export interface AssistantAttachSnapshot {
  streaming: boolean
  accumulated: string
  pendingUserText: string
}

export interface AssistantDelta {
  conversationId: string
  delta: string
}

export interface AssistantStreamError {
  conversationId: string
  message: string
}

export interface AssistantMemoryEvidence {
  id: string
  statement: string
  status: 'active' | 'hypothesis' | 'invalidated' | 'archived'
  confidence: number
  category: string
  scope: string
  evidence: Array<
    | { type: 'transcript'; callId: string; chatMessageId?: string; quote: string }
    | { type: 'reflection'; memoryIds: string[] }
  >
}

/** Same streaming shape as CoachChatApi (delta pushes during the in-flight
 *  invoke), plus two M28 additions: `attach` recovers an in-flight turn's
 *  accumulated text after a remount, and `cancel` genuinely aborts the
 *  provider walk (a real Stop, not a UI dismissal). */
export interface AssistantApi {
  listConversations: () => Promise<AssistantConversationMeta[]>
  getConversation: (id: string) => Promise<AssistantConversation | null>
  /** M28 Part 4 — pass a scope to open the conversation about ONE client. */
  createConversation: (scope?: AssistantScope) => Promise<AssistantConversation>
  renameConversation: (id: string, title: string) => Promise<AssistantConversation | null>
  deleteConversation: (id: string) => Promise<boolean>
  send: (
    conversationId: string,
    message: string,
    voiceNote?: { mediaId: string; durationMs: number },
    attachmentIds?: string[]
  ) => Promise<AssistantSendResult>
  /** M28 Part 3 — validate/cap/extract/store a file locally. Nothing reaches
   *  a provider until it rides a send(). `preview` is exactly what will be
   *  sent (extracted text head, or how the binary travels). */
  addAttachment: (
    name: string,
    bytes: ArrayBuffer,
    /** AUDIT FIX (2026-08-24) — the conversation this file is staged for.
     *  Required: an unowned attachment could be sent into any conversation,
     *  including a different client's scoped one. */
    conversationId: string
  ) => Promise<
    | { ok: true; attachment: AssistantAttachment; preview: string }
    | { ok: false; message: string }
  >
  discardAttachment: (id: string) => Promise<boolean>
  /** M28 Phase 3 — one-shot voice-note transcription (Deepgram prerecorded
   *  REST; NOT the live-call pipeline). On ok the audio is stored and the
   *  text goes to the composer FOR REVIEW — nothing is sent automatically. */
  transcribeVoiceNote: (
    audio: ArrayBuffer,
    mimeType: string,
    durationMs: number
  ) => Promise<
    | { ok: true; text: string; mediaId: string; durationMs: number }
    | { ok: false; error: string; message: string }
  >
  discardVoiceNote: (mediaId: string) => Promise<boolean>
  getVoiceNote: (mediaId: string) => Promise<ArrayBuffer | null>
  cancel: (conversationId: string) => Promise<boolean>
  attach: (conversationId: string) => Promise<AssistantAttachSnapshot>
  applySuggestion: (
    conversationId: string,
    messageId: string,
    suggestion: CoachChatContextSuggestion
  ) => Promise<{ ok: boolean }>
  /** Confirm a pending task proposal — the task is created only here, never
   *  during the turn (writes are confirmed, reads are free). */
  confirmTask: (
    conversationId: string,
    messageId: string,
    proposalId: string
  ) => Promise<{ ok: boolean }>
  /** "Don't learn from this conversation." Excluding ALSO retroactively
   *  deletes every memory the conversation taught (zero trace, same rule as
   *  the per-call toggle); re-enabling does not re-extract. */
  setSalesBrainExcluded: (conversationId: string, excluded: boolean) => Promise<{ ok: boolean }>
  getMemoryEvidence: (memoryId: string) => Promise<AssistantMemoryEvidence | null>
  onDelta: (cb: (payload: AssistantDelta) => void) => () => void
  onError: (cb: (payload: AssistantStreamError) => void) => () => void
  /** Fires on EVERY terminal outcome of a turn (success/stop/cancel/failure),
   *  after persistence — the recovery signal for a renderer that mounted
   *  mid-stream and does not own the original invoke() promise. */
  onTurnComplete: (cb: (payload: { conversationId: string }) => void) => () => void
  /** Coarse pre-first-token progress, driven by what the turn is actually
   *  doing: reading (profiles+retrieval) → searching (tool lookups, only
   *  when any were planned) → thinking (the answer request is out). */
  onPhase: (
    cb: (payload: { conversationId: string; phase: 'reading' | 'searching' | 'thinking' }) => void
  ) => () => void
  /** M31 Stage 5 — what the turn ACTUALLY did, emitted once after research
   *  completes and before the answer request goes out. Built from executed
   *  outcomes, never from the plan: a lookup that failed or matched nothing
   *  appears saying so, because silence about it is what makes a trace
   *  describe intent rather than work. */
  onTrace: (cb: (payload: AssistantTrace) => void) => () => void
}

/** One line of the stream-of-thought. `label` is written in main, which is
 *  what knows the domain; the renderer decides presentation and is never
 *  asked to infer what happened from a status code. */
export interface AssistantTraceStep {
  label: string
  detail?: string
  /** ok = it produced something · none = ran, found nothing · failed = threw
   *  · skipped = never ran (a capability that is switched off). All four are
   *  worth showing; collapsing them is how a trace starts lying by omission. */
  status: 'ok' | 'none' | 'failed' | 'skipped'
}

export interface AssistantTrace {
  conversationId: string
  steps: AssistantTraceStep[]
}

export interface SkillHistoryPoint {
  callId: string
  createdAt: string
  score: number
}

export interface SkillProgress {
  key: SkillKey
  history: SkillHistoryPoint[]
  current: number | null
  trend: 'up' | 'down' | 'flat' | null
  streakAboveTarget: number
}

export interface FocusSkillState {
  skill: SkillKey
  microBehavior: string
  since: string
  sourceCallId?: string
}

export interface FocusSkillAtCoaching {
  skill: SkillKey
  microBehavior: string
}

export type CommitmentOwner = 'rep' | 'prospect'

export interface Commitment {
  owner: CommitmentOwner
  text: string
  dueDate?: string
}

// M24 §8 — the post-call "Radar Report" source data. Mirrors main/calls-fs.ts's
// same-named types verbatim (that file is the sanitizing authority).
export interface DealNudgeRecord {
  id: string
  type: DealSignalType
  subtype: string
  confidence: number
  evidenceQuote: string
  evidenceRole: 'rep' | 'other'
  suggestedCue: string
  atMs: number
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
  /** M23 — sticky call-type classification, auto-detected then overridable. */
  callType?: CallType
}

export interface CallSummary extends CallBase {
  hasSummary: boolean
  attachmentCount: number
  hasCoaching: boolean
  coachScore?: number
  skills?: SkillScoreSet
  /** True once this call has been read for Objection Library mining. */
  objectionsMined: boolean
}

// --- M19 Task 2: resolved speaker identities --------------------------------
export type SpeakerIdentitySource =
  | 'user-profile'
  | 'calendar'
  | 'contact'
  | 'participant-list'
  | 'self-intro'
  | 'voice-profile'
  | 'manual'
export type SpeakerIdentityConfidence = 'high' | 'medium' | 'low'
/** Keyed by speakerKey() — see src/renderer/src/features/live/segments.ts. */
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
  /** M24 §8 — the post-call "Radar Report" source data, if this call ran
   *  with Live Deal Intelligence on. Absent on every call before this
   *  milestone, and on any call it stayed off for — never a required field. */
  dealIntelligence?: DealIntelligenceRecord
  consent?: ConsentRecord
  objectionsMinedAt?: string
  speakerIdentities?: Record<string, SpeakerIdentity>
  /** M23 Workstream B — the coaching-chat thread for this call, complete
   *  turns only. Absent until the first message is sent. */
  coachChat?: CoachChatMessage[]
  /** M23 Workstream B — free-text notes saved from the coaching chat's
   *  "Save to call notes" chip. Local-only, never synced to cloud. */
  notes?: string
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
  /** `selfIntro`: M19 Task 2 step 5's live-resolved buyer name, if any —
   *  applied with source 'self-intro' BEFORE the auto-resolution cascade
   *  runs, so a higher-confidence calendar/contact match can still override
   *  it (unlike a 'manual' rename, which the cascade never touches). */
  save: (input: CallSaveInput, selfIntro?: { key: string; name: string }) => Promise<CallSummary>
  delete: (id: string) => Promise<{ ok: boolean }>
  addAttachment: (
    callId: string,
    file: { name: string; ext: string; data: ArrayBuffer }
  ) => Promise<AddAttachmentResult>
  removeAttachment: (callId: string, attachmentId: string) => Promise<{ ok: boolean }>
  summarizeCall: (callId: string) => Promise<{ ok: boolean; jobId?: string }>
  summarizeAttachment: (callId: string, attachmentId: string) => Promise<SummaryResult>
  coachCall: (callId: string) => Promise<{ ok: boolean; jobId?: string }>
  /** Who promised what on this call, split rep vs. prospect (§4.7). */
  extractCommitments: (callId: string) => Promise<{ ok: boolean; jobId?: string }>
  /** M24 §8 — persist the Radar Report source data onto an already-saved
   *  call. No AI call; the renderer already has the full history. */
  saveDealIntelligence: (callId: string, record: DealIntelligenceRecord) => Promise<{ ok: boolean }>
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
  /** M26 Phase 3 — enqueues a BATCH-lane job (mines every not-yet-mined call
   *  with a transcript, one at a time) and returns immediately; it survives
   *  navigating away from the Objection Library screen. Track it via
   *  window.api.jobs (list/onChanged), filtering for
   *  type === 'objections:scanPastCalls' — same job the Activity Center
   *  already shows. Gated on the toggle; only ever run when the user
   *  explicitly clicks the button. If a scan is already running/queued,
   *  hands back that job's id instead of starting a second one. */
  scanPastCallsForObjections: () => Promise<{ ok: boolean; jobId?: string }>
  /** AI Note Taker's auto-title feature: generate + save a title in one step. */
  generateTitle: (callId: string) => Promise<{ ok: true; title: string } | { ok: false }>
  /** §4.6 — brief + next steps + follow-up email, written straight to the
   *  clipboard by the main process (which needs no window focus). */
  postCallBrief: (callId: string) => Promise<PostCallBriefEvent>
  /** Link (contactId) or clear (null) the contact this call belongs to. */
  setContact: (callId: string, contactId: string | null) => Promise<Call | null>
  /** M23 — override (or clear, with `null`) this call's auto-detected type. */
  setCallType: (callId: string, callType: CallType | null) => Promise<Call | null>
  /** Bookmark a moment mid-call ("clip this") — atMs from call start, plus the
   *  transcript text at that point. */
  addBookmark: (callId: string, atMs: number, text: string) => Promise<Call | null>
  removeBookmark: (callId: string, bookmarkId: string) => Promise<Call | null>
  /** Renders the call's coaching report as a PDF and prompts the user to save
   *  it. Returns the saved path on success, or 'canceled'/'no-report'/'failed'. */
  exportCoachingPdf: (
    callId: string
  ) => Promise<{ ok: true; path: string } | { ok: false; error: string }>
  /** Rename (or clear, with `null`) a speaker for THIS call — always
   *  source: 'manual', which the auto-resolution cascade never overwrites.
   *  `key` is speakerKey()'s format (e.g. "ch1/spk1", "mono/spk0").
   *  `rememberAsContactId` links the identity to a saved contact so future
   *  calls with them resolve instantly. */
  setSpeakerName: (
    callId: string,
    key: string,
    name: string | null,
    opts?: { rememberAsContactId?: string }
  ) => Promise<Call | null>
}

/** M23 Workstream A — Skill Graph progress + the current Focus Skill. Both
 *  read-only from the renderer's side; the underlying state is written by
 *  the main process right after a Coach 2.0 scorecard is saved. */
export interface Coach2Api {
  getProgress: () => Promise<SkillProgress[]>
  getFocusSkill: () => Promise<FocusSkillState | null>
}

export interface TasksApi {
  list: () => Promise<Task[]>
  create: (input: TaskCreateInput) => Promise<Task>
  update: (id: string, patch: TaskUpdateInput) => Promise<Task | null>
  delete: (id: string) => Promise<{ ok: boolean }>
  generateFromCall: (
    callId: string,
    opts?: { force?: boolean }
  ) => Promise<{ ok: boolean; jobId?: string }>
  /** The proposals have been saved, so the job holding them can be cleared.
   *  Purpose-built rather than the generic jobs.dismiss, which cannot mark
   *  a job consumed — see JobsApi.dismiss. */
  markGenerationConsumed: (jobId: string) => Promise<{ ok: boolean }>
}

/** A comment left on a contact — either the rep's own note, or an AI-drafted
 *  one from a linked call (opt-in, Settings → CRM → "Auto-generate notes"). */
export interface ContactComment {
  id: string
  text: string
  createdAt: string
  source: 'user' | 'ai'
}

/** M19 KYC/deal/personal/briefing fields on the stored Contact record —
 *  factored out so Contact and the *Input variant below can't drift as
 *  fields get added (they did drift once already: the M19 Task 3A form
 *  fields were built without ever being wired into the create/update
 *  payload, silently discarding everything a user typed into them). */
interface ContactKycFields {
  industry?: string
  companySize?: string
  website?: string
  registrationNumber?: string
  verificationStatus?: string
  title?: string
  decisionAuthority?: string
  otherStakeholders?: string
  dealValue?: number
  pipelineStage?: string
  leadSource?: string
  budgetIndication?: string
  timeline?: string
  competitors?: string
  knownObjections?: string
  currentTooling?: string
  lastContactDate?: string
  preferredLanguage?: string
  communicationStyle?: string
  timezone?: string
  personalNotes?: string
  /** Free text: "Anything else the AI should know before I meet this
   *  person" — the highest-value input to the M19 Task 3B pre-meeting brief. */
  briefingNotes?: string
}

/** Same fields, but as a create/update payload: `null` explicitly clears the
 *  field, `undefined`/absent leaves it untouched (update) or unset (create). */
interface ContactKycInput {
  industry?: string | null
  companySize?: string | null
  website?: string | null
  registrationNumber?: string | null
  verificationStatus?: string | null
  title?: string | null
  decisionAuthority?: string | null
  otherStakeholders?: string | null
  dealValue?: number | null
  pipelineStage?: string | null
  leadSource?: string | null
  budgetIndication?: string | null
  timeline?: string | null
  competitors?: string | null
  knownObjections?: string | null
  currentTooling?: string | null
  lastContactDate?: string | null
  preferredLanguage?: string | null
  communicationStyle?: string | null
  timezone?: string | null
  personalNotes?: string | null
  briefingNotes?: string | null
}

export interface Contact extends ContactKycFields {
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
  /** E.164 (e.g. "+14155551234"), derived from phoneCountry+phone at write
   *  time — the join key M19 Task 2's phone-based contact matching uses. */
  phoneE164?: string
  notes?: string
  createdAt: string
  /** Last modification (create or edit); a future backup's "newest wins" key. */
  updatedAt: string
  comments?: ContactComment[]
}

export interface ContactCreateInput extends ContactKycInput {
  name: string
  company?: string | null
  cid?: string | null
  registeredAt?: string | null
  country?: string | null
  email?: string | null
  phoneCountry?: string | null
  phone?: string | null
  phoneE164?: string | null
  notes?: string | null
}

export interface ContactUpdateInput extends ContactKycInput {
  name?: string
  company?: string | null
  cid?: string | null
  registeredAt?: string | null
  country?: string | null
  email?: string | null
  phoneCountry?: string | null
  phone?: string | null
  phoneE164?: string | null
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

/** M23 Workstream C. */
export type CrmNoteLength = 'short' | 'medium' | 'detailed'

/** A single KYC fact harvested from a contact's most recent call, proposed
 *  for the rep to accept or reject — never applied until then. */
export interface KycFact {
  id: string
  field: string
  text: string
  confidence: 'high' | 'medium'
}

/** The rep's decisions about one generated draft. Mirrors main's
 *  crm-note-review.ts. */
export interface CrmNoteReview {
  noteHandled?: boolean
  accepted?: string[]
  /** Permanent by design — a skipped suggestion never re-asks. Still shown
   *  (collapsed) so a mis-click leaves a trace. */
  skipped?: string[]
}

/** What a `crmNote:generate` job carries in Job.resultData. */
export interface CrmNoteJobResult {
  note: string
  facts: KycFact[]
  review?: CrmNoteReview
}

/** M23 Workstream C — the standalone "Generate CRM note" card on the
 *  Contact page. Contact-scoped, not call-scoped: `generate` finds that
 *  contact's own most recent linked call itself.
 *
 *  M26 Phase 3: `generate` enqueues a job and returns its id; the drafted
 *  note and harvested suggestions live in that job's resultData, so
 *  navigating away mid-review no longer discards them. The save/apply/skip
 *  calls take the jobId so each decision is recorded back onto the job. */
export interface CrmNoteGeneratorApi {
  generate: (
    contactId: string,
    length: CrmNoteLength,
    opts?: { force?: boolean }
  ) => Promise<{ ok: boolean; jobId?: string; message?: string }>
  save: (contactId: string, note: string, jobId?: string) => Promise<{ ok: boolean }>
  applyFact: (
    contactId: string,
    field: string,
    text: string,
    jobId?: string,
    factId?: string
  ) => Promise<{ ok: boolean }>
  skipFact: (jobId: string, factId: string) => Promise<{ ok: boolean }>
  discardNote: (jobId: string) => Promise<{ ok: boolean }>
}

export interface DetectNameResult {
  ok: boolean
  /** Present when detection ran and found a name (now saved). Absent (but
   *  ok:true) when detection ran cleanly and found nothing. */
  name?: string
  message?: string
}

/** M23 Workstream D — the post-hoc "Detect who this was" action on the Call
 *  Detail page. Scoped to one call, no callId->contactId mapping needed
 *  since it only writes a speakerIdentities entry, not a contact. */
export interface ContactIntelligenceApi {
  /** M26 Phase 3: enqueues a job and returns its id. The full
   *  DetectNameResult comes back as that job's resultData, so the button's
   *  three distinct outcomes (found / ran-clean-found-nothing / refused
   *  with a reason) all survive. */
  detectName: (callId: string) => Promise<{ ok: boolean; jobId?: string }>
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
  /** Manual, per-deal AI risk assessment (Phase 5 Step 1) — never automatic.
   *  M26 Phase 3: enqueues a job and returns immediately; the assessment
   *  itself is saved onto the deal by main, so the renderer refetches the
   *  deal once the job succeeds rather than reading a result from here. */
  assessRisk: (id: string) => Promise<{ ok: boolean; jobId?: string }>
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
  /** M31 Slice B — the call recorded during this meeting, joining plan to
   *  outcome. Set only at call-save time from the meeting the app already
   *  knows is running; never inferred afterwards from contact + time
   *  overlap, which would be a guess. App-local, never pushed. */
  callId?: string
  /** Minutes-before-start lead times for a REAL reminder pushed to the
   *  linked Google/Outlook event — that provider's own app fires the actual
   *  push notification. Distinct from CallRise's own in-app alerts (see
   *  AlertsApi). Only takes effect once synced in two-way (readwrite) mode. */
  reminderMinutes?: number[]
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
  reminderMinutes?: number[]
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
  /** See CalendarEvent.callId — written by the live-call save path, not the
   *  event editor. */
  callId?: string | null
  reminderMinutes?: number[]
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
  /** Open Windows's sound settings — the fix for the endpoint bug. */
  openWindowsSoundSettings: () => Promise<{ ok: boolean }>
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
  /** This device's clock minus the server's, in ms, last time it was measured.
   *  Absent when it has never been measurable (e.g. offline, or the schema's
   *  `server_now()` function hasn't been created yet). */
  clockSkewMs?: number
  clockSkewCheckedAt?: string
  /** True when the device clock is far enough off the server's to be worth
   *  telling the user. Backup ORDERING is corrected for skew regardless — this
   *  is about times displayed in the app being wrong, so it never blocks. */
  clockSkewWarning?: boolean
}

export interface BackupApi {
  /** Force a backup now (the "Back up now" button). */
  pushNow: () => Promise<BackupPushResult>
  /** Full sync: restore (pull + reconcile) then push. M26 Phase 3: enqueues
   *  a MAINTENANCE-lane job and returns its id immediately; track progress
   *  (including WHICH half is running) via window.api.jobs. */
  syncNow: () => Promise<{ ok: boolean; jobId?: string }>
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

export type AiKeyName =
  | 'DEEPGRAM_API_KEY'
  | 'ANTHROPIC_API_KEY'
  | 'OPENAI_API_KEY'
  | 'GROQ_API_KEY'
  | 'OPENROUTER_API_KEY'
  | 'GOOGLE_AI_API_KEY'
  | 'NVIDIA_API_KEY'
  | 'CEREBRAS_API_KEY'
  | 'MISTRAL_API_KEY'
  | 'ZAI_API_KEY'
  | 'HUGGINGFACE_API_KEY'
  | 'CLOUDFLARE_API_KEY'
  | 'CLOUDFLARE_ACCOUNT_ID'

export interface AiKeyStatus {
  /** True once real API calls will succeed for this key — a Settings-saved
   *  key, or a developer .env value, either way. */
  configured: boolean
  /** Masked preview ("sk-ant-…UD2I") for display only — never the raw key. */
  hint: string | null
}

/** 'anthropic'/'openai' are the original M16 pair. The next six (M20) and
 *  the last two (M31 — Z.ai, Hugging Face) are all free-tier providers in the
 *  model catalog — see ai/model-catalog.ts in the main process; this type
 *  must stay in lockstep with src/main/ai/types.ts's AIProviderId, which is
 *  now derived from the AI_PROVIDER_IDS array there. This copy exists because
 *  preload cannot import from main; it is checked by
 *  ai/__tests__/provider-lockstep.test.ts rather than by convention. */
export type AiProviderId =
  | 'anthropic'
  | 'openai'
  | 'groq'
  | 'openrouter'
  | 'google'
  | 'nvidia'
  | 'cerebras'
  | 'mistral'
  | 'zai'
  | 'huggingface'
  | 'cloudflare'

export type AiKeyValidateResult = { ok: true; models: string[] } | { ok: false; reason: string }

export interface AiKeysApi {
  getStatus: () => Promise<Record<AiKeyName, AiKeyStatus>>
  /**
   * Saved key takes effect on the very next AI call — no restart needed.
   *
   * BUG-143 — the result also reports what the save did to the DEFAULT
   * PROVIDER, which used to happen silently. `autoSelectedProvider` is set only
   * when the default actually moved.
   *
   * BUG-146 — `keyValidated` no longer tracks "was a promotion considered".
   * The two came apart when Deepgram gained a real check: it is validated on
   * every save and is NEVER a promotion candidate, because it cannot serve as
   * a text-AI provider. `keyValidated` now answers one question only — was
   * this credential shown to work, just now? `true`/`false` when something
   * checked it; `undefined` when nothing could (today only
   * CLOUDFLARE_ACCOUNT_ID). A caller that ignores every field behaves exactly
   * as before.
   */
  save: (
    name: AiKeyName,
    value: string
  ) => Promise<{
    ok: boolean
    error?: string
    autoSelectedProvider?: string
    /** Present for every text-AI key: was it shown to work, just now? */
    keyValidated?: boolean
    /** The provider's own words when it was not. Safe to display verbatim. */
    validationReason?: string
  }>
  clear: (name: AiKeyName) => Promise<{ ok: boolean; error?: string }>
  /** Cheapest possible round-trip against a credential the user just pasted
   *  (not necessarily saved yet). Every text-AI provider, plus — since
   *  BUG-146 — Deepgram, named by 'deepgram' rather than a provider id
   *  because it has no PROVIDER_REGISTRY entry and must not gain one.
   *  CLOUDFLARE_ACCOUNT_ID remains uncheckable (BUG-147). */
  validate: (target: AiValidateTarget, value: string) => Promise<AiKeyValidateResult>
}

/** Mirrors AiValidateTarget in main/ai-keys.ts. 'deepgram' is deliberately
 *  not an AiProviderId — see the note on `validate` above. */
export type AiValidateTarget = AiProviderId | 'deepgram'

export type ModelLane = 'speed' | 'quality'
export type RetentionPosture = 'trains' | 'no-training' | 'unknown'

/** Mirrors main/ai/model-catalog.ts's CatalogEntry. */
export interface AiCatalogEntry {
  id: string
  displayName: string
  brand: string
  providerId: AiProviderId
  lane: ModelLane
  modelId: string
  contextWindow: number | null
  retentionPosture: RetentionPosture
  retentionUrl: string
  keyUrl: string
  knownStale?: string
}

export interface AiResolvedCatalogEntry extends AiCatalogEntry {
  hasKey: boolean
  available: boolean
}

export interface AiCatalogApi {
  /** Bundled catalog only — instant, no network. */
  list: () => Promise<AiCatalogEntry[]>
  /** Cross-checked against each configured provider's live /models endpoint. */
  resolve: (forceRefresh?: boolean) => Promise<AiResolvedCatalogEntry[]>
  /** V1 chain-editing scope — picks one primary model for a job; main
   *  derives and persists the full fallback chain (promotes the pick to the
   *  front of the bundled default ordering). Returns the updated AppSettings,
   *  same shape as settings.update(). */
  assignPrimaryModel: (purpose: AiPurpose, catalogId: string) => Promise<AppSettings>
  /** Clears a job back to Automatic — main then picks the best available
   *  model itself (today's active provider if configured, else the bundled
   *  default chain) every time this job runs. Returns the updated
   *  AppSettings, same shape as settings.update(). */
  resetToAutomatic: (purpose: AiPurpose) => Promise<AppSettings>
}

export interface AiFallbackEventView {
  ts: string
  purpose: AiPurpose
  fromCatalogId: string
  toCatalogId: string | null
  reason: string
  /** The provider's own error message, when available. */
  detail?: string
  fromDisplayName: string
  toDisplayName: string | null
}

export interface AiFallbackApi {
  /** Most-recent-first, last ~20 - for the "recent fallback activity" list. */
  recentEvents: () => Promise<AiFallbackEventView[]>
}

/** BUG-057 Part 3 — per-purpose AI health, already classified into what to
 *  show (severity + message) and where a "fix this" click should go, so the
 *  renderer never needs its own copy of purpose-health.ts's severity logic. */
export interface PurposeHealthView {
  severity: 'ok' | 'not-configured' | 'substituting' | 'failing'
  message: string
  actionPageId: 'ai-setup' | 'ai-models' | null
}

export interface PurposeHealthApi {
  getAll: () => Promise<Record<AiPurpose, PurposeHealthView>>
}

/** M27 Tier 1 — driver-free noise cancellation for CallRise's OWN audio.
 *  Separate from VirtualMicApi: that one publishes a system-wide capture
 *  DEVICE for Zoom/Teams and needs a signed driver; this one delivers
 *  denoised PCM to this app over a named pipe and needs nothing installed.
 *  Shape must match Tier1Status in src/main/tier1.ts and
 *  src/renderer/src/features/live/audio/tier1-types.ts. */
export interface Tier1Api {
  /** attenDb: denoise attenuation limit in dB; omit for the engine's
   *  compiled-in default (the "high" strength). */
  start: (micName: string, attenDb?: number) => Promise<{ ok: boolean; error?: string }>
  stop: () => Promise<{ ok: boolean }>
  /** Collects noise-cancellation logs + audio state into one zip (save
   *  dialog). No call audio, recordings or transcripts are included. */
  exportDiagnostics: (info: {
    deviceLabels?: string[]
    tier1Enabled?: boolean
    denoiseStrength?: string
  }) => Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>
  getStatus: () => Promise<{
    engineAvailable: boolean
    engineRunning: boolean
    connected: boolean
    denoisingActive: boolean | null
    enginePath: string | null
  }>
  onStatus: (
    cb: (status: {
      engineAvailable: boolean
      engineRunning: boolean
      connected: boolean
      denoisingActive: boolean | null
      enginePath: string | null
    }) => void
  ) => () => void
  /** Denoised PCM frames, ~100/s, as transferred ArrayBuffers of Float32 samples. */
  onPcm: (cb: (frame: ArrayBuffer) => void) => () => void
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
  /** M25 — whole memory.db file, uploaded as one blob (same as attachments). */
  salesBrain: boolean
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
  /** M23 Workstream C — master switch for the standalone "Generate CRM
   *  note" card on the Contact page. Off (default) hides that card. */
  noteGeneratorEnabled: boolean
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

/** M19 Task 2 — see main/app-settings.ts's SpeakerIdSettings for the exact
 *  behavior of each field. `allowSelfIntroExtraction` has no dedicated
 *  Settings UI of its own — Settings → CRM → "Contact Intelligence" is what
 *  keeps it in sync today (see CrmSection.tsx). */
export interface SpeakerIdSettings {
  enabled: boolean
  allowSelfIntroExtraction: boolean
  voiceProfileMatching: boolean
}

/** M20 — must stay in lockstep with src/main/ai/types.ts's AIPurpose. The
 *  Settings → Model Assignment page exposes 5 of these 6
 *  ('other' has no UI — its 4 call sites keep using the plain `aiProvider`
 *  choice forever, an intentional non-goal for this milestone). */
export type AiPurpose =
  | 'coaching-cue'
  | 'summary'
  | 'scorecard'
  | 'tasks'
  | 'other'
  | 'prep-brief'
  | 'deal-tier1'
  | 'deal-tier2'
  | 'coaching-chat'
  | 'memory-extract'
  | 'assistant-chat'

export interface ModelAssignment {
  /** Ordered model-catalog entry IDs — see main/ai/model-catalog.ts. Empty
   *  means "no explicit assignment for this job." */
  chain: string[]
}

export type ModelAssignments = Record<AiPurpose, ModelAssignment>

export interface AppSettings {
  /** Master switch: OFF removes all buyer/other-party recording capability.
   *  Can only remove capability, never grant it — per-call consent still
   *  fully governs actual recording. Defaults to true. */
  allowOtherPartyRecording: boolean
  /** Standing consent: every call starts already consented for buyer capture
   *  (method 'pre-agreed'), so the per-call consent step is skipped. Records a
   *  real consent rather than bypassing one. Gated on the master switch. */
  alwaysRecordOtherParty: boolean
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
  /** M19 Task 2 — auto-name-resolution cascade + privacy-sensitive opt-ins. */
  speakerId: SpeakerIdSettings
  /** Which text-AI provider coaching/summaries/tasks/etc. use when a purpose
   *  has no aiModelAssignments chain configured. Defaults to 'anthropic'.
   *  The API key itself is separate, encrypted (see AiKeysApi). */
  aiProvider: AiProviderId
  /** M20 — ordered per-job model-fallback chains. Empty chain for a purpose
   *  falls back to `aiProvider` above, then to a bundled default catalog
   *  chain — see main/ai/complete-with-fallback.ts's resolution rule. */
  aiModelAssignments: ModelAssignments
  /** M23 — when true, the updater downloads and installs new versions on
   *  its own (no clicks) instead of requiring manual Download/Restart
   *  clicks. Off by default. */
  autoUpdateEnabled: boolean
  autoUpdateMigratedToDefaultOn: boolean
  autoUpdateNoticePending: boolean
  accountMigratedToNewProject: boolean
  accountMigrationNoticePending: boolean
  /** M23 Workstream A — Coach 2.0 master switch + methodology picker. */
  coach2: Coach2Settings
  /** M23 Workstream D — Contact Intelligence mode. Off by default. */
  contactIntelligence: ContactIntelligenceSettings
  /** M25 — Sales Brain (Beta) master switch. Off by default. */
  salesBrain: SalesBrainSettings
  /** M26 Phase 4.5.2 — Deal Intelligence (M24 beta) enable/sensitivity/
   *  per-type/frequency. Off by default; see main/app-settings.ts's
   *  DealIntelligenceSettings for the exact shape and defaults. */
  dealIntelligence: DealIntelligenceSettings
  /** M26 Phase 4.5.2 — live coaching cues (M9) enable/sensitivity. On by
   *  default; see main/app-settings.ts's LiveCueSettings. */
  liveCues: LiveCueSettings
  /** M26 Phase 5 — per-lane job concurrency override (LIVE excluded —
   *  always unbounded). See main/app-settings.ts's JobConcurrencySettings. */
  jobConcurrency: JobConcurrencySettings
  /** M26 Phase 5 — job-completion notification preferences. On by default;
   *  see main/app-settings.ts's JobNotificationSettings. */
  jobNotifications: JobNotificationSettings
}

/** M26 Phase 5 — see main/app-settings.ts's JobConcurrencySettings for the
 *  exact behavior (clamped 1-10, LIVE never included). */
export interface JobConcurrencySettings {
  interactive: number
  batch: number
  maintenance: number
}

/** M26 Phase 5 — see main/app-settings.ts's JobNotificationSettings. */
export interface JobNotificationSettings {
  nativeEnabled: boolean
}

/** M26 Phase 4.5.2 — see main/app-settings.ts's DealIntelligenceSettings
 *  for the exact behavior of each field. */
export type DealIntelligenceSensitivity = 'quiet' | 'balanced' | 'aggressive'
export type AnalysisFrequency = 'frequent' | 'balanced' | 'infrequent'

export interface EnabledNudgeTypes {
  risk: boolean
  opportunity: boolean
  tactical: boolean
}

export interface DealIntelligenceSettings {
  enabled: boolean
  sensitivity: DealIntelligenceSensitivity
  enabledTypes: EnabledNudgeTypes
  frequency: AnalysisFrequency
}

/** M26 Phase 4.5.2 — see main/app-settings.ts's LiveCueSettings. */
export type CueSensitivity = 'low' | 'medium' | 'high'

export interface LiveCueSettings {
  enabled: boolean
  sensitivity: CueSensitivity
}

/** M23 — see main/app-settings.ts's Coach2Settings for the exact behavior. */
export interface Coach2Settings {
  enabled: boolean
  methodology: SalesMethodology
}

/** M25 — see main/app-settings.ts's SalesBrainSettings for the exact behavior. */
export interface SalesBrainSettings {
  enabled: boolean
}

/** M23 Workstream D — see main/app-settings.ts's ContactIntelligenceSettings
 *  for the exact behavior of each mode. */
export type ContactIntelligenceMode = 'off' | 'suggest' | 'full-auto'

export interface ContactIntelligenceSettings {
  mode: ContactIntelligenceMode
}

export interface AppSettingsPatch {
  allowOtherPartyRecording?: boolean
  alwaysRecordOtherParty?: boolean
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
   *  `capturePolicy.appOverrides` merges KEY BY KEY - send only the single
   *  changed `{appId: value}`, never the whole map (a stale full-map replacement
   *  from your own possibly-outdated copy would silently drop a concurrent
   *  change). Use `'default'` (or `null`) as the value to remove an override. */
  detection?: {
    enabled?: boolean
    capturePolicy?: {
      autoCapturePolicy?: CapturePolicyValue
      appOverrides?: Record<string, AppOverride | 'default' | null>
    }
  }
  /** Partial — only the keys present are changed; others are left as-is. */
  speakerId?: Partial<SpeakerIdSettings>
  aiProvider?: AiProviderId
  /** M20 — partial per-purpose; only the purposes present are replaced
   *  (whole-chain replace per purpose, not key-by-key — a chain is authored
   *  as one unit in the Model Assignment UI). */
  aiModelAssignments?: Partial<Record<AiPurpose, ModelAssignment>>
  autoUpdateEnabled?: boolean
  autoUpdateNoticePending?: boolean
  accountMigratedToNewProject?: boolean
  accountMigrationNoticePending?: boolean
  /** Partial — only the keys present are changed; others are left as-is. */
  coach2?: Partial<Coach2Settings>
  /** Partial — only the keys present are changed; others are left as-is. */
  contactIntelligence?: Partial<ContactIntelligenceSettings>
  /** Partial — only the keys present are changed; others are left as-is. */
  salesBrain?: Partial<SalesBrainSettings>
  /** Partial — only the keys present are changed; others are left as-is.
   *  `enabledTypes` merges key-by-key, and a patch that would leave all
   *  three nudge types disabled is rejected wholesale (use the master
   *  `enabled` switch to actually turn the feature off). */
  dealIntelligence?: {
    enabled?: boolean
    sensitivity?: DealIntelligenceSensitivity
    enabledTypes?: Partial<EnabledNudgeTypes>
    frequency?: AnalysisFrequency
  }
  /** Partial — only the keys present are changed; others are left as-is. */
  liveCues?: Partial<LiveCueSettings>
  /** Partial — only the keys present are changed; others are left as-is.
   *  Each value clamped to [1, 10]. */
  jobConcurrency?: Partial<JobConcurrencySettings>
  /** Partial — only the keys present are changed; others are left as-is. */
  jobNotifications?: Partial<JobNotificationSettings>
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
  /** The version string from package.json, for the Settings "Software update" section. */
  getVersion: () => Promise<string>
  /** Windows only — repaint the native caption buttons to match the theme.
   *  A no-op elsewhere; never rejects. */
  setTitleBarOverlay: (colors: { color: string; symbolColor: string }) => Promise<void>
  /** Full path to the on-disk error log, for display/copy in Settings. */
  getLogsPath: () => Promise<string>
  /** Reveals the log file in the OS file explorer (creating it first if nothing has logged yet). */
  openLogsFolder: () => Promise<void>
  /** Forwards a renderer-side crash/error into the same persistent log file as the main process. */
  logRendererError: (scope: string, message: string) => Promise<void>
}

export interface SupportBundleResult {
  ok: boolean
  path?: string
  files?: string[]
  error?: string
}

/** M29 A5.4 — one click collects the fallback log, purpose health, job
 *  history, versions, and device basics into a folder ready to email
 *  support. Separate from Tier1Api's own diagnostics export (engine logs
 *  only); this covers the whole app. NEVER transcripts, keys, or memories. */
export interface SupportApi {
  createBundle: () => Promise<SupportBundleResult>
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

// --- Auto-update (§5.3) -----------------------------------------------------

// --- M29 telemetry (opt-in diagnostics) --------------------------------
// Mirrors src/main/telemetry/{events,consent,ipc}.ts — re-declared, same
// convention as every other main-process shape in this file.
export type TelemetryConsent = 'on' | 'off' | 'unasked'
export interface TelemetryConsentRecord {
  consent: TelemetryConsent
  decidedAt?: string
  askedWithVersion?: string
}
export interface TelemetryEvent {
  id: string
  ts: string
  kind: 'crash' | 'error' | 'health' | 'usage'
  name: string
  props: Record<string, string | number | boolean>
}
/** One row as it was POSTed — mirrors src/main/telemetry/transport.ts IngestRow. */
export interface TelemetrySentRow {
  event_id: string
  anon_id: string
  session_id: string
  app_version: string
  platform: string
  os_version: string
  arch: string
  kind: string
  name: string
  props: Record<string, string | number | boolean>
  client_ts: string
}
export interface TelemetryFlushResult {
  attempted: boolean
  sent: number
  remaining: number
  reason?: string
}
export interface TelemetryState {
  consent: TelemetryConsentRecord
  /** null until the user opts in; deleted when they opt out. */
  anonId: string | null
  /** The real payloads waiting to be sent, oldest first. */
  queued: TelemetryEvent[]
  /** The exact rows already sent, newest batch first. */
  sent: TelemetrySentRow[]
}
export interface SalesBrainExportResult {
  ok: boolean
  path?: string
  bytes?: number
  canceled?: boolean
  reason?: string
}

export interface TelemetryApi {
  getState: () => Promise<TelemetryState>
  setConsent: (value: 'on' | 'off') => Promise<TelemetryState>
  clearQueue: () => Promise<TelemetryState>
  clearSent: () => Promise<TelemetryState>
  /** A3 — coarse usage counter; main validates against its allowlist. */
  featureOpened: (feature: string) => Promise<boolean>
  flushNow: () => Promise<{ result: TelemetryFlushResult; state: TelemetryState }>
}

export interface UpdaterApi {
  status: () => Promise<UpdateStatus>
  check: () => Promise<UpdateStatus>
  download: () => Promise<UpdateStatus>
  /** Quits and installs — only succeeds from a 'downloaded' state; main
   *  re-verifies this itself rather than trusting the renderer's call. */
  install: () => Promise<{ ok: boolean }>
}

// --- M26 job queue -----------------------------------------------------
// Mirrors src/main/jobs/types.ts — re-declared here rather than imported,
// same convention as every other main-process event shape in this file
// (TranscriptionStateEvent etc. above), since preload/renderer code never
// imports directly from src/main/**.

export type JobLane = 'LIVE' | 'INTERACTIVE' | 'BATCH' | 'MAINTENANCE'
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'

export type JobProgress =
  | {
      mode: 'determinate'
      itemsDone: number
      itemsTotal: number
      /** 'percent' means itemsDone IS the percentage (itemsTotal 100),
       *  rendered "45%" — for work with no meaningful item count, like a
       *  download. Omitted means countable things, "12 / 50". */
      unit?: 'percent'
    }
  | { mode: 'stages'; stageLabel: string }
  | { mode: 'indeterminate' }

export interface JobErrorInfo {
  message: string
  code?: string
}

/** What a job's `targetRef` names, so the Activity Center knows which screen
 *  to open. Mirrors main/jobs/types.ts. */
export type JobTargetKind = 'call' | 'contact' | 'deal'

export interface Job {
  id: string
  type: string
  title: string
  targetRef?: string
  targetKind?: JobTargetKind
  state: JobState
  progress: JobProgress
  lane: JobLane
  priority: number
  createdAt: number
  startedAt?: number
  endedAt?: number
  error?: JobErrorInfo
  resultRef?: string
  /** The executor's full resolved result, for job types whose output is
   *  more than a single deep-link string (see main/jobs/types.ts's Job for
   *  the full doc). */
  resultData?: unknown
  cancellable: boolean
  /** This job produces no toast/OS notification of its own — the feature
   *  behind it ships a better-worded one. Still shown in the Activity
   *  Center. */
  silent?: boolean
  /** While succeeded, this job's resultData may be the only copy of AI
   *  output the rep hasn't reviewed. It is exempt from automatic history
   *  pruning and cannot be cleared from generic history UI — see
   *  holdsUnreviewedOutput() and JobsApi.dismiss (BUG-052). */
  retainUntilConsumed?: boolean
  input: unknown
  checkpoint?: unknown
  /** M27 — DERIVED, never persisted: true when this job is queued and the
   *  only thing keeping it from starting is that every configured AI model
   *  is currently unusable (rate-limited / daily quota spent / cooling down).
   *  Computed fresh in main at each send (see main/jobs/ipc.ts's jobViews and
   *  JobManager.deferredJobIds); absent when the job is merely waiting its
   *  turn behind another job in the same lane. Lets the UI say "waiting for
   *  AI capacity" instead of implying work is underway. */
  deferredForCapacity?: boolean
}

/** Mirrors src/main/jobs/activity.ts's ActivityEvent. */
export type JobActivityEvent =
  | { kind: 'started'; job: Job; message: string }
  | { kind: 'succeeded' | 'failed'; job: Job; message: string }
  | { kind: 'digest'; jobs: Job[]; message: string }

export interface JobsApi {
  list: () => Promise<Job[]>
  get: (id: string) => Promise<Job | null>
  cancel: (id: string) => Promise<{ ok: boolean }>
  retry: (id: string) => Promise<Job | null>
  resume: (id: string) => Promise<Job | null>
  /** Clear a finished job from history. Refuses (ok:false) on a job still
   *  running/queued, AND on one still holding unreviewed AI output — that
   *  can only be cleared by the feature's own "you've dealt with it" path,
   *  never from generic history UI (BUG-052). Use holdsUnreviewedOutput()
   *  to avoid offering a dismiss that would be refused. */
  dismiss: (id: string) => Promise<{ ok: boolean }>
  /** Full current snapshot, pushed at most ~4/sec. */
  onChanged: (cb: (payload: Job[]) => void) => () => void
  /** One event per start/completion, already call-aware-DND-filtered. */
  onNotify: (cb: (payload: JobActivityEvent) => void) => () => void
  /** Clicked an OS-native job notification — undefined jobId means a digest
   *  (open the Activity panel generally, not one specific job). */
  onOpenRequested: (cb: (jobId: string | undefined) => void) => () => void
  /** Dev builds only (see main/index.ts's is.dev guard) — rejects in a
   *  packaged build since main never registers the handler. */
  dev: {
    startFake: (
      req:
        | {
            kind: 'batch'
            input: { title: string; itemsTotal: number; msPerItem: number; failAtItem?: number }
          }
        | {
            kind: 'staged'
            input: { title: string; stages: string[]; msPerStage: number; failAtStage?: number }
          }
        | {
            kind: 'cpu'
            input: { title: string; itemsTotal: number; msBudget: number; failAtItem?: number }
          }
    ) => Promise<Job>
  }
}

// --- Scheduled alerts (M19 Task 1) ------------------------------------------

export type AlertTriggerType = 'meeting_starting' | 'task_due' | 'deal_cold' | 'no_next_step'
export type AlertChannelType = 'telegram' | 'email' | 'whatsapp' | 'desktop'

export interface NotificationChannel {
  id: string
  user_id: string
  type: AlertChannelType
  address: string | null
  label: string | null
  verified_at: string | null
  verification_token: string | null
  verification_expires_at: string | null
  consecutive_failures: number
  unhealthy_at: string | null
  revoked_at: string | null
  created_at: string
  updated_at: string
}

export interface AlertRule {
  id: string
  user_id: string
  trigger_type: AlertTriggerType
  lead_time_minutes: number | null
  enabled: boolean
  params: Record<string, unknown>
  created_at: string
  updated_at: string
  alert_rule_channels?: { channel_id: string }[]
}

export interface UserAlertSettings {
  user_id: string
  timezone: string
  quiet_hours_start: string | null
  quiet_hours_end: string | null
  quiet_hours_behavior: 'hold' | 'drop'
  rate_limit_behavior: 'drop' | 'queue' | 'coalesce'
  max_alerts_per_hour: number
  deal_cold_days: number
  deal_cold_digest_hour: number
  allow_server_side_brief_generation: boolean
  updated_at: string
}

export type TelegramVerifyResult =
  | {
      ok: true
      channelId: string
      deepLink: string | null
      qrData: string | null
      expiresAt: string
    }
  | { ok: false; error: 'not-signed-in' | 'not-configured' | 'create-failed' }

export type EmailVerifyResult =
  | { ok: true; channelId: string; expiresAt: string }
  | {
      ok: false
      error: 'not-signed-in' | 'invalid-email' | 'create-failed' | 'send-failed'
      channelId?: string
    }

export type ConfirmEmailCodeResult =
  | { ok: true }
  | { ok: false; error: 'invalid-input' | 'not-found' | 'expired' | 'wrong-code' | 'update-failed' }

export type TestSendResult =
  | { ok: true }
  | {
      ok: false
      error: 'invalid-input' | 'not-found' | 'unverified' | 'send-failed' | 'not-configured'
      message?: string
    }

export interface AlertsApi {
  channels: {
    list: () => Promise<NotificationChannel[]>
    startTelegramVerify: (label?: string) => Promise<TelegramVerifyResult>
    startEmailVerify: (address: string) => Promise<EmailVerifyResult>
    confirmEmailCode: (channelId: string, code: string) => Promise<ConfirmEmailCodeResult>
    delete: (channelId: string) => Promise<{ ok: boolean }>
    whatsappStatus: () => Promise<{ configured: boolean }>
    testSend: (channelId: string) => Promise<TestSendResult>
  }
  rules: {
    list: () => Promise<AlertRule[]>
    create: (input: {
      triggerType: AlertTriggerType
      leadTimeMinutes?: number
      enabled?: boolean
      params?: Record<string, unknown>
      channelIds?: string[]
    }) => Promise<AlertRule | null>
    update: (
      ruleId: string,
      patch: Partial<{
        leadTimeMinutes: number
        enabled: boolean
        params: Record<string, unknown>
        channelIds: string[]
      }>
    ) => Promise<AlertRule | null>
    delete: (ruleId: string) => Promise<{ ok: boolean }>
  }
  settings: {
    get: () => Promise<UserAlertSettings | null>
    update: (patch: Partial<UserAlertSettings>) => Promise<UserAlertSettings | null>
  }
  deliveries: {
    recent: (limit?: number) => Promise<Record<string, unknown>[]>
  }
}

export interface PrepBriefAttendee {
  email: string
  name?: string
}

export interface PrepBriefEventInput {
  eventId: string
  title: string
  startIso: string
  attendees: PrepBriefAttendee[]
  contactId?: string
  dealId?: string
}

export interface PrepBrief {
  whoYoureMeeting: string
  dealStatus: string
  lastTime: string
  openCommitments: string[]
  likelyObjections: string[]
  openers: string[]
  model: string
  generatedAt: string
}

export interface PrepBriefRecord {
  eventId: string
  contactId?: string
  dealId?: string
  inputHash: string
  brief: PrepBrief
  savedAt: string
}

export type PrepBriefResult =
  | {
      ok: true
      record: PrepBriefRecord
      fromCache: boolean
      focusSkillReminder?: FocusSkillAtCoaching
      /** M25 Phase 3 — "Your edge": what Sales Brain knows about this
       *  client + the business's own proven objection responses. Absent
       *  (not an empty string) when Sales Brain is off or nothing's been
       *  compiled yet. */
      salesBrainEdge?: string
    }
  | { ok: false; error: 'no-key' | 'failed' | 'no-context'; message?: string }

/** What the calendar's prep-brief dot may claim. `ready` means opening the
 *  brief right now genuinely serves the cached copy without spending an AI
 *  call; `outdated` means the contact/deal/last-call it was written from has
 *  changed since, so opening it regenerates. See getPrepBriefStatus. */
export type PrepBriefStatus = 'none' | 'ready' | 'outdated'

export interface PrepBriefApi {
  getForEvent: (input: PrepBriefEventInput) => Promise<PrepBriefResult>
  regenerate: (input: PrepBriefEventInput) => Promise<PrepBriefResult>
  /** Read-only batch status for a whole visible calendar range — one round
   *  trip for every chip. Never generates a brief and never writes. Events
   *  omitted from the result (unparseable input) simply get no dot. */
  statuses: (inputs: PrepBriefEventInput[]) => Promise<Record<string, PrepBriefStatus>>
  /** Fired when a callrise://meeting/<eventId> deep link is opened (from a
   *  meeting_starting alert) — the caller resolves eventId to a full
   *  PrepBriefEventInput itself (the renderer already holds the merged
   *  calendar event via useCalendar()) and opens the brief for it. */
  onOpenRequested: (callback: (eventId: string) => void) => () => void
}

/** M25 Phase 4 — onboarding interview. */
export interface OnboardingStatusResult {
  status: 'not-started' | 'in-progress' | 'skipped' | 'finished'
  nextTopic: { id: string; question: string } | null
  completedCount: number
  totalCount: number
}

export interface SalesBrainOnboardingApi {
  status: () => Promise<OnboardingStatusResult>
  submitAnswer: (topicId: string, answer: string) => Promise<OnboardingStatusResult>
  skipTopic: (topicId: string) => Promise<OnboardingStatusResult>
  skipAll: () => Promise<OnboardingStatusResult>
  restart: () => Promise<OnboardingStatusResult>
}

/** M25 Phase 5 — Memory Center. Mirrors main/memory/types.ts's Memory shape
 *  (hand-duplicated, same convention as every other main/preload/renderer
 *  type mirror in this app). */
export type MemoryScope = 'rep' | 'business' | `client:${string}`
export type MemoryStatus = 'active' | 'hypothesis' | 'invalidated' | 'archived'
export type MemorySource = 'auto' | 'user_stated' | 'user_confirmed'
export type MemoryEvidence =
  | { type: 'transcript'; callId: string; chatMessageId?: string; quote: string }
  | { type: 'reflection'; memoryIds: string[] }

export interface Memory {
  id: string
  scope: MemoryScope
  category: string
  statement: string
  evidence: MemoryEvidence[]
  confidence: number
  importance: number
  status: MemoryStatus
  source: MemorySource
  pinned: boolean
  invalidatedBy?: string
  createdAt: string
  lastConfirmedAt: string
  invalidatedAt?: string
}

export interface MemoryChangelogEntry {
  memoryId: string
  statement: string
  scope: MemoryScope
  kind: 'created' | 'reinforced' | 'invalidated'
  at: string
}

export interface SalesBrainBackfillApi {
  start: (opts: {
    includeContacts?: boolean
    includeDeals?: boolean
    includeCalls?: boolean
    /** Forget past attempts and reconsider every call. Normal runs resume —
     *  that is what makes the import completable at all on a rate-limited
     *  key — so this is the explicit "learn from everything again". */
    rescanAll?: boolean
  }) => Promise<{ ok: boolean; message?: string; jobId?: string }>
}

export interface SalesBrainMemoriesApi {
  list: (opts?: { scope?: string; status?: string }) => Promise<Memory[]>
  update: (id: string, newStatement: string) => Promise<{ ok: boolean }>
  setPinned: (id: string, pinned: boolean) => Promise<{ ok: boolean }>
  delete: (id: string) => Promise<{ ok: boolean }>
  forgetEverything: () => Promise<{ ok: boolean }>
  changelog: (scope?: string) => Promise<MemoryChangelogEntry[]>
  byCall: (callId: string) => Promise<Memory[]>
}

export interface SalesBrainCallsApi {
  setExcluded: (callId: string, excluded: boolean) => Promise<{ ok: boolean }>
  getExcluded: (callId: string) => Promise<boolean>
}

export interface SalesBrainApi {
  status: () => Promise<SalesBrainStatus>
  /** M29 A5.3 — consistent snapshot via the shared snapshot mechanism. */
  exportSnapshot: () => Promise<SalesBrainExportResult>
  onboarding: SalesBrainOnboardingApi
  backfill: SalesBrainBackfillApi
  memories: SalesBrainMemoriesApi
  calls: SalesBrainCallsApi
  /** Fired when a Sales Brain post-call review notification is clicked —
   *  the caller opens that call's review screen. */
  onReviewRequested: (callback: (callId: string) => void) => () => void
}

/** M26 Phase 4.2 — a call that was interrupted before it could be saved, found
 *  by sweeping the on-disk journals at launch. */
export interface RecoverableCall {
  id: string
  startedAt: string
  durationMs: number
  segmentCount: number
  /** First ~200 characters, so a rep with two interrupted calls can tell them
   *  apart without opening either. */
  preview: string
  /** The journal's last line was torn by the crash. The call is recoverable;
   *  its final utterance may be missing. Shown rather than hidden. */
  truncated: boolean
}

export interface LiveApi {
  /** Fire-and-forget: tells main which speaker is the rep, so its journaled
   *  copy carries the same attribution the on-screen one does. */
  repIdentified: (epoch: number, speaker: number) => void
  /** Interrupted calls awaiting a decision. Never acts on them. */
  listRecoverable: () => Promise<RecoverableCall[]>
  /** Turn one into a real saved call, on the rep's explicit say-so. */
  recoverCall: (id: string) => Promise<{ ok: boolean; call?: CallSummary }>
  /** Throw one away, on the rep's explicit say-so. */
  discardRecoverable: (id: string) => Promise<{ ok: boolean }>
}

declare global {
  /** AUDIT FIX (2026-08-24) — the four states an empty memories.list() can
   *  mean. Each of the first three has a DIFFERENT correct user action, and
   *  the boolean this replaces collapsed them into "your Sales Brain is
   *  empty" — wrong for two of them, and wrong for the SHIPPING DEFAULT.
   *
   *  Ambient rather than exported: no renderer file imports preload types,
   *  and `../../../../preload` resolves to the implementation module (which
   *  would drag electron into the web project), so an import here would be
   *  swimming against the repo's own convention. */
  type SalesBrainStatus =
    | { state: 'off' }
    | { state: 'unavailable'; detail: string }
    | { state: 'empty' }
    | { state: 'ready'; count: number }

  interface Window {
    electron: ElectronAPI
    api: {
      /** process.platform, exposed only for platform-specific CSS/rendering
       *  decisions (see DetectionOverlay.tsx). */
      platform: NodeJS.Platform
      transcription: TranscriptionApi
      trackers: TrackersApi
      dealIntelligence: DealIntelligenceApi
      calls: CallsApi
      coach2: Coach2Api
      coachChat: CoachChatApi
      assistant: AssistantApi
      crmNoteGenerator: CrmNoteGeneratorApi
      contactIntelligence: ContactIntelligenceApi
      tasks: TasksApi
      contacts: ContactsApi
      deals: DealsApi
      dealStages: DealStagesApi
      events: EventsApi
      auth: AuthApi
      loopback: LoopbackApi
      consent: ConsentGateApi
      google: GoogleApi
      outlook: OutlookApi
      backup: BackupApi
      virtualmic: VirtualMicApi
      tier1: Tier1Api
      knowledge: KnowledgeApi
      objectionQueue: ObjectionQueueApi
      settings: AppSettingsApi
      app: AppControlApi
      support: SupportApi
      aiKeys: AiKeysApi
      aiCatalog: AiCatalogApi
      aiFallback: AiFallbackApi
      purposeHealth: PurposeHealthApi
      detection: DetectionApi
      alerts: AlertsApi
      prepBrief: PrepBriefApi
      salesBrain: SalesBrainApi
      telemetry: TelemetryApi
      updater: UpdaterApi
      jobs: JobsApi
      live: LiveApi
    }
  }
}
