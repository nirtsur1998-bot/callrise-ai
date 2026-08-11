// The Live Call State engine (M24 §1) — folds one LiveTurn at a time into
// LiveCallState, running every Tier 0 extractor (§2) on each fold.
//
// ingestTurn is a pure reducer: (state, turn, config) -> (state, signals),
// nothing hidden, no clock of its own, no randomness. That's what makes the
// Call Simulator and a real call produce identical state for identical
// input — the engine genuinely cannot tell the two apart. LiveCallStateEngine
// below is only a thin stateful convenience wrapper for call sites that
// don't want to thread state through by hand.
//
// `previousRole` and `previousAtMs` are captured from the INCOMING state
// before any extractor runs, then threaded explicitly into whichever
// extractors need "what was true before this turn." They're not just read
// back off `state` inside each extractor, because extractors run in
// sequence and each one's patch gets merged into the accumulator before the
// next runs — a second extractor reading `state.lastUpdatedAtMs` (say) would
// see a value the first extractor already overwrote for THIS turn, not the
// value from before it. Passing the two facts every extractor might need as
// plain parameters sidesteps that hazard entirely rather than relying on
// every extractor remembering not to touch fields it doesn't own.

import type { DealIntelligenceConfig, LiveCallState, LiveTurn, Tier0Signal } from './types'
import { DEFAULT_CONFIG, createInitialState } from './types'
import { detectTalkRatio } from './tier0/talkRatio'
import { detectMonologue } from './tier0/monologue'
import { detectSilenceGap } from './tier0/silenceGap'
import { detectMentions } from './tier0/mentions'
import { detectQuestionDrought } from './tier0/questionDrought'
import { detectSentiment } from './tier0/sentiment'
import { detectCallStage } from './tier0/callStage'

export { createInitialState }
export type { DealIntelligenceConfig, LiveCallState, LiveTurn, Tier0Signal }

export interface IngestResult {
  state: LiveCallState
  signals: Tier0Signal[]
}

export function ingestTurn(
  state: LiveCallState,
  turn: LiveTurn,
  config: DealIntelligenceConfig = {}
): IngestResult {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const signals: Tier0Signal[] = []

  const previousRole = state.lastTurnRole
  const previousAtMs = state.lastUpdatedAtMs
  const gapMs = Math.max(0, turn.atMs - previousAtMs)

  let next: LiveCallState = {
    ...state,
    lastUpdatedAtMs: turn.atMs,
    lastTurnRole: turn.role,
    repSpeaker: turn.role === 'rep' ? turn.speaker : state.repSpeaker
  }

  const steps: Array<() => { patch: Partial<LiveCallState>; signals: Tier0Signal[] }> = [
    () => detectTalkRatio(next, turn, previousRole),
    () => detectMonologue(next, turn, previousRole, cfg),
    () => detectSilenceGap(next, turn, gapMs, cfg),
    () => detectMentions(next, turn, cfg),
    () => detectQuestionDrought(next, turn, cfg),
    () => detectSentiment(next, turn)
  ]
  for (const step of steps) {
    const { patch, signals: stepSignals } = step()
    next = { ...next, ...patch }
    signals.push(...stepSignals)
  }

  next = { ...next, callStage: detectCallStage(next, turn) }

  return { state: next, signals }
}

/** Thin stateful wrapper for call sites (the Call Simulator, and eventually
 *  a real live hook) that would rather not thread state through by hand. */
export class LiveCallStateEngine {
  private currentState: LiveCallState
  private readonly config: DealIntelligenceConfig

  constructor(callStartedAtMs: number, config: DealIntelligenceConfig = {}) {
    this.config = config
    this.currentState = createInitialState(callStartedAtMs, config.agendaTopics ?? [])
  }

  ingest(turn: LiveTurn): Tier0Signal[] {
    const { state, signals } = ingestTurn(this.currentState, turn, this.config)
    this.currentState = state
    return signals
  }

  get state(): LiveCallState {
    return this.currentState
  }
}
