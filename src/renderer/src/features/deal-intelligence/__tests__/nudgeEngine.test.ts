import { describe, expect, it } from 'vitest'
import {
  createNudgeEngineState,
  dismissNudge,
  evaluateSignals,
  type NudgeEngineState,
  type Tier1SignalCandidate
} from '../nudgeEngine'

const balanced = { sensitivity: 'balanced' as const }

const candidate = (overrides: Partial<Tier1SignalCandidate> = {}): Tier1SignalCandidate => ({
  type: 'risk',
  subtype: 'stalling',
  confidence: 0.9,
  evidenceQuote: "We'll think about it and get back to you.",
  evidenceRole: 'other',
  suggestedCue: 'Ask what specifically needs more thought.',
  ...overrides
})

describe('evaluateSignals — confidence floor', () => {
  it('rejects a candidate below the sensitivity threshold', () => {
    const { surfaced } = evaluateSignals(
      createNudgeEngineState(),
      [candidate({ confidence: 0.5 })],
      balanced,
      0,
      null
    )
    expect(surfaced).toBeNull()
  })

  it('accepts a candidate at or above the threshold', () => {
    const { surfaced } = evaluateSignals(
      createNudgeEngineState(),
      [candidate({ confidence: 0.75 })],
      balanced,
      0,
      null
    )
    expect(surfaced).not.toBeNull()
  })

  it('quiet requires a higher confidence than aggressive', () => {
    const mid = candidate({ confidence: 0.7 })
    expect(
      evaluateSignals(createNudgeEngineState(), [mid], { sensitivity: 'quiet' }, 0, null).surfaced
    ).toBeNull()
    expect(
      evaluateSignals(createNudgeEngineState(), [mid], { sensitivity: 'aggressive' }, 0, null)
        .surfaced
    ).not.toBeNull()
  })
})

describe('evaluateSignals — priority ordering', () => {
  it('picks risk over opportunity over tactical when several are eligible in one pass', () => {
    const candidates = [
      candidate({ type: 'tactical', subtype: 'a' }),
      candidate({ type: 'opportunity', subtype: 'b' }),
      candidate({ type: 'risk', subtype: 'c' })
    ]
    const { surfaced } = evaluateSignals(createNudgeEngineState(), candidates, balanced, 0, null)
    expect(surfaced?.type).toBe('risk')
    expect(surfaced?.subtype).toBe('c')
  })

  it('breaks a tie within the same type by higher confidence', () => {
    const candidates = [
      candidate({ type: 'risk', subtype: 'a', confidence: 0.8 }),
      candidate({ type: 'risk', subtype: 'b', confidence: 0.95 })
    ]
    const { surfaced } = evaluateSignals(createNudgeEngineState(), candidates, balanced, 0, null)
    expect(surfaced?.subtype).toBe('b')
  })
})

describe('evaluateSignals — cooldown', () => {
  it('does not surface a second nudge within the cooldown window', () => {
    const first = evaluateSignals(
      createNudgeEngineState(),
      [candidate({ subtype: 'a' })],
      balanced,
      0,
      null
    )
    expect(first.surfaced).not.toBeNull()

    const second = evaluateSignals(
      first.state,
      [candidate({ subtype: 'b' })], // different subtype — not a dedupe case
      balanced,
      10_000, // well under balanced's 45s cooldown
      null
    )
    expect(second.surfaced).toBeNull()
  })

  it('surfaces again once the cooldown has elapsed', () => {
    const first = evaluateSignals(
      createNudgeEngineState(),
      [candidate({ subtype: 'a' })],
      balanced,
      0,
      null
    )
    const second = evaluateSignals(
      first.state,
      [candidate({ subtype: 'b' })],
      balanced,
      46_000,
      null
    )
    expect(second.surfaced).not.toBeNull()
  })
})

describe('evaluateSignals — dedupe', () => {
  it('does not re-fire the same type+subtype within 5 minutes, even off cooldown', () => {
    const first = evaluateSignals(
      createNudgeEngineState(),
      [candidate({ subtype: 'stalling' })],
      balanced,
      0,
      null
    )
    const second = evaluateSignals(
      first.state,
      [candidate({ subtype: 'stalling' })],
      balanced,
      200_000, // past the 45s cooldown, still under the 5-minute dedupe window
      null
    )
    expect(second.surfaced).toBeNull()
  })

  it('allows the same subtype again once the dedupe window has fully elapsed', () => {
    const first = evaluateSignals(
      createNudgeEngineState(),
      [candidate({ subtype: 'stalling' })],
      balanced,
      0,
      null
    )
    const second = evaluateSignals(
      first.state,
      [candidate({ subtype: 'stalling' })],
      balanced,
      301_000, // just past 5 minutes
      null
    )
    expect(second.surfaced).not.toBeNull()
  })

  it('a different subtype of the SAME type is not deduped against', () => {
    const first = evaluateSignals(
      createNudgeEngineState(),
      [candidate({ subtype: 'stalling' })],
      balanced,
      0,
      null
    )
    const second = evaluateSignals(
      first.state,
      [candidate({ subtype: 'price-objection' })],
      balanced,
      46_000,
      null
    )
    expect(second.surfaced).not.toBeNull()
  })
})

describe('evaluateSignals — rolling 30-minute cap', () => {
  it('stops surfacing once the sensitivity cap is reached within the window', () => {
    let state: NudgeEngineState = createNudgeEngineState()
    let now = 0
    let shown = 0
    // balanced caps at 7 per 30 min; space attempts well past cooldown/dedupe
    // so only the cap itself is under test.
    for (let i = 0; i < 10; i++) {
      const result = evaluateSignals(state, [candidate({ subtype: `s${i}` })], balanced, now, null)
      state = result.state
      if (result.surfaced) shown++
      now += 60_000
    }
    expect(shown).toBe(7)
  })

  it('a nudge older than 30 minutes drops out of the cap window, allowing a new one', () => {
    let state: NudgeEngineState = createNudgeEngineState()
    // Fill the balanced cap (7), each spaced past cooldown so every one of
    // the 7 actually lands — the cap, not the cooldown, is what's under test.
    let now = 0
    for (let i = 0; i < 7; i++) {
      state = evaluateSignals(state, [candidate({ subtype: `s${i}` })], balanced, now, null).state
      now += 46_000
    }
    // Still within 30 minutes of the oldest (t=0) entry — cap binding.
    const stillCapped = evaluateSignals(
      state,
      [candidate({ subtype: 'new' })],
      balanced,
      now + 46_000,
      null
    )
    expect(stillCapped.surfaced).toBeNull()

    // Once 30 minutes have passed since the oldest entry, the window rolls
    // forward and a new nudge is allowed again.
    const afterWindow = evaluateSignals(
      state,
      [candidate({ subtype: 'new' })],
      balanced,
      31 * 60_000,
      null
    )
    expect(afterWindow.surfaced).not.toBeNull()
  })
})

describe('evaluateSignals — suppression', () => {
  it("suppresses a candidate whose issue vocabulary overlaps the rep's latest substantive turn", () => {
    const c = candidate({
      subtype: 'price-objection',
      evidenceQuote: 'Honestly the pricing seems too expensive for our budget this year.'
    })
    const repAlreadyOnIt =
      'I hear you on pricing — let me walk through how the budget actually breaks down and where the expensive parts really come from.'
    const { surfaced } = evaluateSignals(createNudgeEngineState(), [c], balanced, 0, repAlreadyOnIt)
    expect(surfaced).toBeNull()
  })

  it('does not suppress when the rep text is unrelated', () => {
    const c = candidate({
      subtype: 'price-objection',
      evidenceQuote: 'Honestly the pricing seems too expensive for our budget this year.'
    })
    const unrelated = 'Let me pull up the onboarding calendar and walk through next steps.'
    const { surfaced } = evaluateSignals(createNudgeEngineState(), [c], balanced, 0, unrelated)
    expect(surfaced).not.toBeNull()
  })

  it('a short/filler rep turn never counts as "addressing" anything', () => {
    const { surfaced } = evaluateSignals(
      createNudgeEngineState(),
      [candidate()],
      balanced,
      0,
      'Yeah okay'
    )
    expect(surfaced).not.toBeNull()
  })

  it('null rep text never suppresses', () => {
    const { surfaced } = evaluateSignals(createNudgeEngineState(), [candidate()], balanced, 0, null)
    expect(surfaced).not.toBeNull()
  })
})

describe('evaluateSignals — feedback-adaptive threshold', () => {
  it('raises the effective confidence floor for a subtype the rep rejects more than half the time', () => {
    const config = {
      sensitivity: 'balanced' as const,
      feedback: [{ type: 'risk' as const, subtype: 'stalling', totalRatings: 4, rejectionRate: 0.75 }]
    }
    // balanced floor is 0.75; a 0.8 candidate clears the base floor but not
    // the adapted one (0.75 + 0.15 = 0.9).
    const { surfaced } = evaluateSignals(
      createNudgeEngineState(),
      [candidate({ confidence: 0.8 })],
      config,
      0,
      null
    )
    expect(surfaced).toBeNull()
  })

  it('still surfaces once confidence clears the raised floor', () => {
    const config = {
      sensitivity: 'balanced' as const,
      feedback: [{ type: 'risk' as const, subtype: 'stalling', totalRatings: 4, rejectionRate: 0.75 }]
    }
    const { surfaced } = evaluateSignals(
      createNudgeEngineState(),
      [candidate({ confidence: 0.95 })],
      config,
      0,
      null
    )
    expect(surfaced).not.toBeNull()
  })

  it('does not adjust a subtype with a rejection rate at or below the threshold', () => {
    const config = {
      sensitivity: 'balanced' as const,
      feedback: [{ type: 'risk' as const, subtype: 'stalling', totalRatings: 10, rejectionRate: 0.5 }]
    }
    const { surfaced } = evaluateSignals(
      createNudgeEngineState(),
      [candidate({ confidence: 0.8 })],
      config,
      0,
      null
    )
    expect(surfaced).not.toBeNull()
  })

  it('only adjusts the matching (type, subtype) pair, not other candidates', () => {
    const config = {
      sensitivity: 'balanced' as const,
      feedback: [{ type: 'risk' as const, subtype: 'stalling', totalRatings: 4, rejectionRate: 0.9 }]
    }
    const { surfaced } = evaluateSignals(
      createNudgeEngineState(),
      [candidate({ subtype: 'price-objection', confidence: 0.8 })],
      config,
      0,
      null
    )
    expect(surfaced).not.toBeNull()
  })

  it('omitting feedback entirely behaves exactly like an empty array (backward compatible)', () => {
    const { surfaced } = evaluateSignals(createNudgeEngineState(), [candidate()], balanced, 0, null)
    expect(surfaced).not.toBeNull()
  })
})

describe('dismissNudge', () => {
  it('removes the nudge from visibleNudges but keeps it in history (dedupe/cap still count it)', () => {
    const { state } = evaluateSignals(
      createNudgeEngineState(),
      [candidate({ subtype: 'a' })],
      balanced,
      0,
      null
    )
    expect(state.visibleNudges).toHaveLength(1)

    const afterDismiss = dismissNudge(state, state.visibleNudges[0].id)
    expect(afterDismiss.visibleNudges).toHaveLength(0)
    expect(afterDismiss.history).toHaveLength(1)

    // Still deduped against, even though it was dismissed from view.
    const again = evaluateSignals(
      afterDismiss,
      [candidate({ subtype: 'a' })],
      balanced,
      10_000,
      null
    )
    expect(again.surfaced).toBeNull()
  })

  it('dismissing an unknown id is a harmless no-op', () => {
    const state = createNudgeEngineState()
    expect(dismissNudge(state, 'does-not-exist')).toEqual(state)
  })
})

describe('evaluateSignals — misc', () => {
  it('an empty candidate list never surfaces anything', () => {
    const { surfaced } = evaluateSignals(createNudgeEngineState(), [], balanced, 0, null)
    expect(surfaced).toBeNull()
  })

  it('is pure: does not mutate the input state', () => {
    const state = createNudgeEngineState()
    const before = JSON.parse(JSON.stringify(state))
    evaluateSignals(state, [candidate()], balanced, 0, null)
    expect(state).toEqual(before)
  })
})
