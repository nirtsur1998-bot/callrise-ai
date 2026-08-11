// Live Call State (M24 §1) — the single structured object every tier reads
// from and writes into, folded one turn at a time by engine.ts's ingestTurn.
//
// Turn timing lives here on LiveTurn, not on the persisted CallSegment
// (@renderer/features/calls/types) — M21 deliberately dropped per-turn
// timestamps from what gets saved (see that file's comments), because a
// saved call doesn't need a clock. A LIVE call does, so this feature defines
// its own turn shape rather than reusing CallSegment verbatim. Whatever
// eventually wires this into a real call stamps atMs = Date.now() -
// callStartedAtMs on each turn as it arrives; the Call Simulator does the
// same against a replayed transcript's own clock. Either way the engine
// sees identical input shapes and cannot tell the difference — that's what
// makes the whole thing testable with zero real calls.
//
// SpeakerRole below deliberately MIRRORS (does not import)
// @renderer/features/calls/types's SpeakerRole, so this whole feature has no
// dependency on the `@renderer` path alias and stays runnable by plain
// tsx/node (see simulator/run.ts) without needing vite's alias resolution.

export type SpeakerRole = 'rep' | 'other' | 'unknown'

export interface LiveTurn {
  speaker: number
  text: string
  /** 'unknown' turns are deliberately under-used below — the same
   *  conservatism CallSegment documents: asserting a side on a turn nobody
   *  has attributed yet would be a guess, and a wrong guess here is worse
   *  than no signal at all. */
  role: SpeakerRole
  /** Elapsed ms since the call started. Not wall-clock time. */
  atMs: number
  epoch?: number
  channel?: number
}

export interface EvidenceQuote {
  role: SpeakerRole
  text: string
  atMs: number
}

export type ObjectionType = 'price' | 'timing' | 'authority' | 'trust' | 'need'
export type ObjectionStatus = 'raised' | 'addressed' | 'unresolved'

export interface Objection {
  type: ObjectionType
  /** Tier 0 can only ever produce 'raised' — it detected a phrase, not
   *  whether the rep's response actually landed. 'addressed'/'unresolved'
   *  need semantic judgement and are Tier 1/2's to set (Phase 2/3). */
  status: ObjectionStatus
  raisedEvidence: EvidenceQuote
  addressedEvidence?: EvidenceQuote
  lastMentionedAtMs: number
}

export interface LiveCommitment {
  owner: 'rep' | 'other'
  text: string
  evidence: EvidenceQuote
}

export interface MentionEvidence {
  term: string
  evidence: EvidenceQuote[]
}

export type CallStage = 'opening' | 'discovery' | 'demo-pitch' | 'objections' | 'closing'

export interface SentimentSample {
  atMs: number
  /** -1..1. A coarse Tier 0 keyword-lexicon estimate, not a real sentiment
   *  model — Tier 1/2 (Phase 2/3) should treat this as a rough prior to
   *  refine, never as ground truth on its own. */
  score: number
}

export interface PendingQuestion {
  evidence: EvidenceQuote
}

export interface LiveCallState {
  callStartedAtMs: number
  /** atMs of the most recent turn folded into this state. */
  lastUpdatedAtMs: number
  repSpeaker: number | null
  /** role of the most recently folded turn, null before the first one — how
   *  detectTalkRatio recognises an interruption without re-scanning history. */
  lastTurnRole: SpeakerRole | null

  /** Word counts, not literal speaking milliseconds — the same proxy
   *  features/live/monologue.ts's computeTalkRatio already uses, and for
   *  the same reason: deterministic from data already on hand, no new ASR. */
  talkWords: { rep: number; other: number }
  /** Rep share of talkWords, 0..1. Null until there's enough to say
   *  anything (mirrors computeTalkRatio's minWordsForRatio floor). */
  talkRatio: number | null
  interruptionCount: number
  /** Most recent gaps between consecutive turns, newest last, capped. */
  recentSilenceGapsMs: number[]
  longestRepMonologueMs: number
  currentRepMonologueMs: number
  /** atMs the current uninterrupted rep run began, null when the other side
   *  currently holds the floor. Internal bookkeeping for detectMonologue. */
  repMonologueStartAtMs: number | null

  /** Set when the most recent rep turn read as a question and nobody has
   *  answered yet. Cleared the moment any other turn arrives. Tier 0's
   *  "silence > 8s after a rep question" signal fires off this field. */
  pendingRepQuestion: PendingQuestion | null

  buyerQuestionCount: number
  buyerQuestionRatePerMin: number
  /** null until the buyer's first question. Drives the drought signal. */
  lastBuyerQuestionAtMs: number | null
  /** Whether question-drought has already fired for the CURRENT gap since
   *  lastBuyerQuestionAtMs. Reset the moment a new buyer question arrives.
   *  Deliberately not derived from a time comparison (see detectQuestionDrought's
   *  comment) — a gap that's been open a while stays "since >= threshold"
   *  forever until the next question, so a time-based edge check can only
   *  ever fire once total and would permanently miss a drought that started
   *  before turnCount cleared its floor. */
  droughtSignaledSinceLastQuestion: boolean
  /** Total turns folded so far — guards the drought signal against firing
   *  early in a call that's simply too young to say anything yet. */
  turnCount: number

  agendaTopics: string[]
  /** Subset of agendaTopics whose text has actually come up so far — a
   *  plain substring match against agendaTopics, nothing fancier. */
  topicsCovered: string[]

  objections: Objection[]
  /** Always empty out of Tier 0 — "who promised what" needs semantic
   *  extraction Tier 0 can't do. Phase 2/3's Tier 1/2 populate this. The
   *  field exists now so the state shape doesn't change under those phases. */
  commitments: LiveCommitment[]

  budgetMentions: MentionEvidence[]
  timelineMentions: MentionEvidence[]

  sentimentTrajectory: SentimentSample[]
  callStage: CallStage
}

const RECENT_GAPS_CAP = 20
const SENTIMENT_TRAJECTORY_CAP = 200

export { RECENT_GAPS_CAP, SENTIMENT_TRAJECTORY_CAP }

export function createInitialState(
  callStartedAtMs: number,
  agendaTopics: string[] = []
): LiveCallState {
  return {
    callStartedAtMs,
    lastUpdatedAtMs: callStartedAtMs,
    repSpeaker: null,
    lastTurnRole: null,
    talkWords: { rep: 0, other: 0 },
    talkRatio: null,
    interruptionCount: 0,
    recentSilenceGapsMs: [],
    longestRepMonologueMs: 0,
    currentRepMonologueMs: 0,
    repMonologueStartAtMs: null,
    pendingRepQuestion: null,
    buyerQuestionCount: 0,
    buyerQuestionRatePerMin: 0,
    lastBuyerQuestionAtMs: null,
    droughtSignaledSinceLastQuestion: false,
    turnCount: 0,
    agendaTopics,
    topicsCovered: [],
    objections: [],
    commitments: [],
    budgetMentions: [],
    timelineMentions: [],
    sentimentTrajectory: [],
    callStage: 'opening'
  }
}

// What a Tier 0 extractor emits into the Nudge Engine (Phase 2). Phase 1
// only produces these — nothing consumes them yet, which is why every field
// here is self-contained rather than referencing a not-yet-built cue shape.
export type Tier0SignalType =
  | 'long-monologue'
  | 'silence-after-question'
  | 'trigger-phrase'
  | 'question-drought'
  | 'talk-ratio-skewed'

export interface Tier0Signal {
  type: Tier0SignalType
  /** Free-form detail — e.g. which phrase matched, which objection type was
   *  inferred. Not user-facing copy; the Nudge Engine (Phase 2) is what
   *  turns a signal into a worded cue. */
  subtype?: string
  atMs: number
  evidence: EvidenceQuote[]
  detail: string
}

export interface DealIntelligenceConfig {
  agendaTopics?: string[]
  extraTriggerPhrases?: string[]
  monologueThresholdMs?: number
  silenceAfterQuestionThresholdMs?: number
  questionDroughtMs?: number
  questionDroughtMinTurns?: number
}

export const DEFAULT_CONFIG: Required<DealIntelligenceConfig> = {
  agendaTopics: [],
  extraTriggerPhrases: [],
  monologueThresholdMs: 90_000,
  silenceAfterQuestionThresholdMs: 8_000,
  questionDroughtMs: 3 * 60_000,
  questionDroughtMinTurns: 6
}
