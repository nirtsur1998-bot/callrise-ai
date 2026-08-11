// The Nudge Engine (M24 §6) — the strict quality gate between Tier 1's raw
// signal candidates and what the rep actually sees. This is deliberately the
// most conservative part of the whole system: the spec's own framing is "a
// wrong or spammy cue is WORSE than silence," so every rule below defaults
// to suppressing rather than showing when it's ambiguous.
//
// Pure reducer, same shape as the Phase 1 Tier 0 engine: evaluateSignals(state,
// candidates, config, now, ...) -> {state, surfaced}. No timers, no I/O — the
// caller (useDealIntelligence.ts) owns the clock and the 20s/Tier-0-event
// trigger cadence; this only ever answers "given everything so far, should
// ANY of these candidates actually surface, and which one."

export type NudgeType = 'risk' | 'opportunity' | 'tactical'

export interface Nudge {
  id: string
  type: NudgeType
  subtype: string
  confidence: number
  evidenceQuote: string
  evidenceRole: 'rep' | 'other'
  suggestedCue: string
  createdAtMs: number
}

export interface Tier1SignalCandidate {
  type: NudgeType
  subtype: string
  confidence: number
  evidenceQuote: string
  evidenceRole: 'rep' | 'other'
  suggestedCue: string
}

export type Sensitivity = 'quiet' | 'balanced' | 'aggressive'

/** §8's feedback loop, read into the engine: a per-(type,subtype) rejection
 *  rate the caller loaded once at call start (main/deal-feedback-fs.ts's
 *  getFeedbackSummary()) — never re-fetched mid-call, so a rep's ratings
 *  during THIS call adapt the NEXT call, not retroactively this one. */
export interface FeedbackAdjustment {
  type: NudgeType
  subtype: string
  totalRatings: number
  rejectionRate: number
}

export interface NudgeEngineConfig {
  sensitivity: Sensitivity
  /** Defaults to no adjustment when omitted — every existing caller/test
   *  that doesn't pass this keeps behaving exactly as before it existed. */
  feedback?: FeedbackAdjustment[]
}

/** A subtype the rep rejects more than half the time (with enough ratings to
 *  mean something — see MIN_RATINGS_TO_ADAPT in deal-feedback-fs.ts) gets a
 *  higher confidence bar going forward: it costs the same accuracy to reach
 *  the rep, just less often for a signal they've shown they don't want. */
const REJECTION_RATE_THRESHOLD = 0.5
const REJECTION_PENALTY = 0.15
const MAX_CONFIDENCE_FLOOR = 0.95

function confidenceFloorFor(
  candidate: Tier1SignalCandidate,
  baseFloor: number,
  feedback: FeedbackAdjustment[]
): number {
  const match = feedback.find((f) => f.type === candidate.type && f.subtype === candidate.subtype)
  if (!match || match.rejectionRate <= REJECTION_RATE_THRESHOLD) return baseFloor
  return Math.min(MAX_CONFIDENCE_FLOOR, baseFloor + REJECTION_PENALTY)
}

// risk > opportunity > tactical, per spec — lower number wins when choosing
// among several eligible candidates from the same pass.
const PRIORITY_RANK: Record<NudgeType, number> = { risk: 0, opportunity: 1, tactical: 2 }

/** Confidence floor, cooldown between shown nudges, and the rolling-30-minute
 *  cap all move together with sensitivity — Quiet is strictly more
 *  conservative than Balanced, which is strictly more conservative than
 *  Aggressive, on all three axes at once, so the setting reads as one
 *  coherent "how much do you want to hear from me" dial rather than three
 *  independent ones that could fight each other. */
const TUNING: Record<
  Sensitivity,
  { confidenceFloor: number; cooldownMs: number; capPer30Min: number }
> = {
  quiet: { confidenceFloor: 0.85, cooldownMs: 90_000, capPer30Min: 6 },
  balanced: { confidenceFloor: 0.75, cooldownMs: 45_000, capPer30Min: 7 },
  aggressive: { confidenceFloor: 0.6, cooldownMs: 25_000, capPer30Min: 8 }
}

const DEDUPE_WINDOW_MS = 5 * 60_000
const ROLLING_CAP_WINDOW_MS = 30 * 60_000

export interface NudgeEngineState {
  /** Currently shown to the rep — bounded small in practice (cooldown alone
   *  makes >1 simultaneous nudge rare), cleared only by dismissNudge(). */
  visibleNudges: Nudge[]
  /** Every nudge ever shown this call, oldest first — the ledger dedupe/cap/
   *  cooldown all read from. Never trimmed mid-call (a 30-min call is a few
   *  KB of history at most; simplicity beats a rolling-window array here). */
  history: Nudge[]
}

export function createNudgeEngineState(): NudgeEngineState {
  return { visibleNudges: [], history: [] }
}

let nextId = 1
/** Deliberately not crypto.randomUUID()/Date.now()-keyed — ids only need to
 *  be unique within one engine's lifetime (one call), and a plain counter is
 *  trivially deterministic for tests. Reset per module load (i.e. per app
 *  session), which is fine since ids are never persisted or compared across
 *  calls. */
function generateId(): string {
  return `nudge-${nextId++}`
}

const STOPWORDS = new Set([
  'the',
  'and',
  'that',
  'this',
  'with',
  'have',
  'from',
  'they',
  'were',
  'been',
  'their',
  'about',
  'would',
  'could',
  'your',
  'what',
  'when',
  'where',
  'which',
  'there',
  'here',
  'just',
  'like',
  'really',
  'actually',
  'going',
  'think',
  'know'
])

function keywords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z]{4,}/g) ?? []
  return new Set(words.filter((w) => !STOPWORDS.has(w)))
}

/**
 * Suppression (§6): "if the rep is already actively addressing the detected
 * issue, suppress." This is necessarily a heuristic — real language
 * understanding of "addressing" is Tier 1's own job, and it already saw the
 * same transcript when it produced the candidate. This is a deterministic
 * BACKSTOP for the common case where the rep's very next substantive turn
 * shares real vocabulary with the issue: a genuine word overlap beats
 * nothing, and staying silent on a false-positive suppression costs far less
 * than showing a nudge for something the rep just visibly handled.
 */
function isAlreadyAddressed(
  candidate: Tier1SignalCandidate,
  latestRepText: string | null
): boolean {
  if (!latestRepText || latestRepText.trim().length < 15) return false // too short to be "addressing" anything
  const issueWords = keywords(`${candidate.subtype.replace(/-/g, ' ')} ${candidate.evidenceQuote}`)
  const repWords = keywords(latestRepText)
  for (const w of issueWords) {
    if (repWords.has(w)) return true
  }
  return false
}

function isDuplicate(candidate: Tier1SignalCandidate, history: Nudge[], nowMs: number): boolean {
  return history.some(
    (n) =>
      n.type === candidate.type &&
      n.subtype === candidate.subtype &&
      nowMs - n.createdAtMs < DEDUPE_WINDOW_MS
  )
}

function underRollingCap(history: Nudge[], cap: number, nowMs: number): boolean {
  const recentCount = history.filter((n) => nowMs - n.createdAtMs < ROLLING_CAP_WINDOW_MS).length
  return recentCount < cap
}

export interface EvaluateResult {
  state: NudgeEngineState
  /** At most one — cooldown alone means a pass essentially never surfaces
   *  more than one nudge, and picking exactly one (the best-ranked eligible
   *  candidate) rather than several keeps the rep's queue from ever backing
   *  up, which is the whole point of "rare." */
  surfaced: Nudge | null
}

/**
 * Given this pass's raw Tier 1 candidates, decide whether anything actually
 * surfaces. Order of gates: confidence floor -> suppression -> dedupe ->
 * priority+confidence ranking -> cooldown -> rolling cap. Confidence/
 * suppression/dedupe are checked per-candidate (so a low-confidence risk
 * doesn't block a high-confidence opportunity from the same pass); cooldown
 * and the rolling cap are checked once, against whichever single candidate
 * survives ranking — no point spending the rate-limited slot on the second-
 * best candidate if a better one was available this same pass.
 */
export function evaluateSignals(
  state: NudgeEngineState,
  candidates: Tier1SignalCandidate[],
  config: NudgeEngineConfig,
  nowMs: number,
  /** The rep's most recent substantive speech in the analyzed window, if
   *  any — drives suppression. null when nothing rep-side is available. */
  latestRepText: string | null
): EvaluateResult {
  const tuning = TUNING[config.sensitivity]
  const feedback = config.feedback ?? []

  const eligible = candidates.filter(
    (c) =>
      c.confidence >= confidenceFloorFor(c, tuning.confidenceFloor, feedback) &&
      !isAlreadyAddressed(c, latestRepText) &&
      !isDuplicate(c, state.history, nowMs)
  )
  if (eligible.length === 0) return { state, surfaced: null }

  eligible.sort(
    (a, b) => PRIORITY_RANK[a.type] - PRIORITY_RANK[b.type] || b.confidence - a.confidence
  )
  const best = eligible[0]

  const lastShownAtMs =
    state.history.length > 0 ? state.history[state.history.length - 1].createdAtMs : null
  if (lastShownAtMs !== null && nowMs - lastShownAtMs < tuning.cooldownMs)
    return { state, surfaced: null }
  if (!underRollingCap(state.history, tuning.capPer30Min, nowMs)) return { state, surfaced: null }

  const nudge: Nudge = {
    id: generateId(),
    type: best.type,
    subtype: best.subtype,
    confidence: best.confidence,
    evidenceQuote: best.evidenceQuote,
    evidenceRole: best.evidenceRole,
    suggestedCue: best.suggestedCue,
    createdAtMs: nowMs
  }
  return {
    state: { visibleNudges: [...state.visibleNudges, nudge], history: [...state.history, nudge] },
    surfaced: nudge
  }
}

export function dismissNudge(state: NudgeEngineState, id: string): NudgeEngineState {
  return { ...state, visibleNudges: state.visibleNudges.filter((n) => n.id !== id) }
}
