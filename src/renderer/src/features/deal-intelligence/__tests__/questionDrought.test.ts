import { describe, expect, it } from 'vitest'
import { detectQuestionDrought } from '../tier0/questionDrought'
import { createInitialState, type LiveCallState, type LiveTurn, type Tier0Signal } from '../types'

const turn = (role: LiveTurn['role'], text: string, atMs: number, speaker = 0): LiveTurn => ({
  speaker,
  text,
  role,
  atMs
})

const config = { questionDroughtMs: 60_000, questionDroughtMinTurns: 3 }

function fold(turns: LiveTurn[], cfg = config): { state: LiveCallState; signals: Tier0Signal[] } {
  let state = createInitialState(0)
  const signals: Tier0Signal[] = []
  for (const t of turns) {
    const result = detectQuestionDrought(state, t, cfg)
    state = { ...state, ...result.patch }
    signals.push(...result.signals)
  }
  return { state, signals }
}

describe('detectQuestionDrought', () => {
  it('counts a buyer turn ending in "?" and updates lastBuyerQuestionAtMs', () => {
    const t = turn('other', 'What integrations do you support?', 1_000)
    const { patch } = detectQuestionDrought(createInitialState(0), t, config)

    expect(patch.buyerQuestionCount).toBe(1)
    expect(patch.lastBuyerQuestionAtMs).toBe(1_000)
  })

  it('does not count a rep turn ending in "?" as a buyer question', () => {
    const t = turn('rep', 'Does that make sense?', 1_000)
    const { patch } = detectQuestionDrought(createInitialState(0), t, config)

    expect(patch.buyerQuestionCount).toBe(0)
    expect(patch.lastBuyerQuestionAtMs).toBeNull()
  })

  it('reports zero rate before 30 seconds of elapsed call time', () => {
    const t = turn('other', 'What does onboarding look like?', 10_000)
    const { patch } = detectQuestionDrought(createInitialState(0), t, config)

    expect(patch.buyerQuestionRatePerMin).toBe(0)
  })

  it('reports a sane positive rate once past 30 seconds', () => {
    const t = turn('other', 'What does onboarding look like?', 60_000)
    const { patch } = detectQuestionDrought(createInitialState(0), t, config)

    // 1 buyer question over exactly 1 elapsed minute
    expect(patch.buyerQuestionRatePerMin).toBeCloseTo(1)
  })

  it('fires the drought signal exactly once, on the turn that crosses the threshold', () => {
    const turns = [
      turn('other', 'What integrations do you support?', 0), // buyer question — resets baseline
      turn('rep', 'We support the usual suspects.', 10_000),
      turn('rep', 'Anyway, let me continue.', 20_000), // turnCount now 3, meets the floor
      turn('rep', 'Still no buyer question here.', 70_000) // crosses 60s since the baseline
    ]
    const { state, signals } = fold(turns)

    expect(signals).toHaveLength(1)
    expect(signals[0].type).toBe('question-drought')
    expect(signals[0].atMs).toBe(70_000)
    expect(state.turnCount).toBe(4)
  })

  it('does not fire again on later turns once it has already fired for this drought', () => {
    const turns = [
      turn('other', 'What integrations do you support?', 0),
      turn('rep', 'A', 10_000),
      turn('rep', 'B', 20_000),
      turn('rep', 'C', 70_000), // fires here
      turn('rep', 'D', 140_000), // drought continues — should NOT fire a second time
      turn('rep', 'E', 200_000)
    ]
    const { signals } = fold(turns)

    expect(signals).toHaveLength(1)
    expect(signals[0].atMs).toBe(70_000)
  })

  it('fires again for a NEW drought after a buyer question resets the baseline', () => {
    const turns = [
      turn('other', 'Question one?', 0),
      turn('rep', 'A', 10_000),
      turn('rep', 'B', 20_000),
      turn('rep', 'C', 70_000), // first drought fires
      turn('other', 'Question two?', 75_000), // resets the baseline
      turn('rep', 'D', 85_000),
      turn('rep', 'E', 95_000),
      turn('rep', 'F', 140_000) // second drought: 140_000 - 75_000 = 65_000 >= 60_000
    ]
    const { signals } = fold(turns)

    expect(signals).toHaveLength(2)
    expect(signals[0].atMs).toBe(70_000)
    expect(signals[1].atMs).toBe(140_000)
  })

  // The floor guards against a call that's simply too young to say anything
  // yet — a big silent gap in the first couple of turns isn't a drought.
  it('does not fire when the turn-count floor is unmet, even though the time gap alone qualifies', () => {
    const turns = [
      turn('other', 'What integrations do you support?', 0), // buyer question, turnCount 1
      turn('rep', 'Long uninterrupted answer here.', 70_000) // turnCount 2, gap alone qualifies (70s >= 60s)
    ]
    const { signals } = fold(turns, { questionDroughtMs: 60_000, questionDroughtMinTurns: 6 })

    expect(signals).toHaveLength(0)
  })

  // Regression test for a real bug found during review: the signal used to be
  // edge-triggered purely on "was the gap under threshold last turn," which
  // gets stuck true forever once a drought starts before the turn-count floor
  // clears (see questionDrought.ts's file comment) — permanently missing the
  // drought rather than merely delaying it. It should instead fire the moment
  // BOTH conditions are finally true together, however late that is.
  it('fires once the turn-count floor finally clears, even if the time threshold crossed earlier', () => {
    const turns = [
      turn('other', 'What integrations do you support?', 0), // turnCount 1
      turn('rep', 'Long answer.', 70_000), // turnCount 2 — gap already qualifies, floor (6) not met
      turn('rep', 'Still talking.', 80_000), // turnCount 3
      turn('rep', 'More detail.', 90_000), // turnCount 4
      turn('rep', 'Wrapping up this point.', 100_000), // turnCount 5
      turn('rep', 'One more thing.', 110_000) // turnCount 6 — floor now met
    ]
    const { signals } = fold(turns, { questionDroughtMs: 60_000, questionDroughtMinTurns: 6 })

    expect(signals).toHaveLength(1)
    expect(signals[0].atMs).toBe(110_000)
  })

  // Regression test for a second bug found during review: a plain time-based
  // check could fire on the SAME turn the buyer asks the question that ends
  // the drought, because the pre-turn baseline hadn't caught up yet.
  it('does not fire on the turn where the buyer question itself breaks the drought', () => {
    const turns = [
      turn('other', 'Question one?', 0),
      turn('rep', 'A', 10_000),
      turn('rep', 'B', 20_000), // turnCount 3, floor met, no question yet
      turn('other', 'Sorry, one more — question two?', 70_000) // crosses 60s AND is itself a buyer question
    ]
    const { signals } = fold(turns)

    expect(signals).toHaveLength(0)
  })
})
