// Buyer question count/rate + "question drought" (M24 §2).
//
// A buyer who's stopped asking questions is a buyer who's disengaged — or a
// discovery call that never got the buyer talking in the first place. Fires
// once per drought period, guarded by a minimum turn count so a call that's
// simply young doesn't read as a drought before it's had a chance to say
// anything.
//
// "Once per period" is tracked with an explicit droughtSignaledSinceLastQuestion
// flag rather than the time-based edge check the rest of Tier 0 uses (compare
// detectMonologue/detectTalkRatio's "crossed the line since last turn"
// pattern) — that pattern breaks here because the underlying quantity
// (elapsed time since the last buyer question) does not reset on its own
// once the drought begins. Two bugs a plain time-based check produced during
// review: (1) it could fire on the SAME turn where the buyer finally asks a
// question, since the pre-turn baseline hadn't caught up yet; (2) if the
// threshold was crossed before turnCount cleared its floor, the "was under
// threshold last turn" half of the check could never be true again — the
// drought would be permanently missed rather than merely delayed. An
// explicit flag, reset only when a real buyer question arrives, sidesteps
// both: it fires exactly once per gap, whenever the gate first opens,
// however late that turns out to be.

import type { LiveCallState, LiveTurn, Tier0Signal } from '../types'

function isQuestion(text: string): boolean {
  return text.trim().endsWith('?')
}

export function detectQuestionDrought(
  state: LiveCallState,
  turn: LiveTurn,
  config: { questionDroughtMs: number; questionDroughtMinTurns: number }
): { patch: Partial<LiveCallState>; signals: Tier0Signal[] } {
  const turnCount = state.turnCount + 1
  const signals: Tier0Signal[] = []

  const isBuyerQuestion = turn.role === 'other' && isQuestion(turn.text)
  const buyerQuestionCount = state.buyerQuestionCount + (isBuyerQuestion ? 1 : 0)

  const elapsedMs = Math.max(0, turn.atMs - state.callStartedAtMs)
  const buyerQuestionRatePerMin = elapsedMs < 30_000 ? 0 : buyerQuestionCount / (elapsedMs / 60_000)

  const baselineAtMs = state.lastBuyerQuestionAtMs ?? state.callStartedAtMs
  const sinceNow = turn.atMs - baselineAtMs

  if (
    !isBuyerQuestion &&
    !state.droughtSignaledSinceLastQuestion &&
    turnCount >= config.questionDroughtMinTurns &&
    sinceNow >= config.questionDroughtMs
  ) {
    signals.push({
      type: 'question-drought',
      atMs: turn.atMs,
      evidence: [{ role: turn.role, text: turn.text, atMs: turn.atMs }],
      detail: `No buyer question in ${Math.round(sinceNow / 1000)}s`
    })
  }

  return {
    patch: {
      turnCount,
      buyerQuestionCount,
      buyerQuestionRatePerMin,
      lastBuyerQuestionAtMs: isBuyerQuestion ? turn.atMs : state.lastBuyerQuestionAtMs,
      droughtSignaledSinceLastQuestion: isBuyerQuestion
        ? false
        : state.droughtSignaledSinceLastQuestion || signals.length > 0
    },
    signals
  }
}
