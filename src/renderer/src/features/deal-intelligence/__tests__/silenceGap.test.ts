import { describe, expect, it } from 'vitest'
import { detectSilenceGap } from '../tier0/silenceGap'
import { createInitialState, RECENT_GAPS_CAP, type LiveCallState, type LiveTurn } from '../types'

const turn = (
  role: LiveTurn['role'],
  atMs: number,
  text: string,
  speaker = role === 'rep' ? 0 : 1
): LiveTurn => ({ speaker, text, role, atMs })

const config = { silenceAfterQuestionThresholdMs: 8_000 }

// Mirrors engine.ts's own bookkeeping: gapMs is derived from the incoming
// state's lastUpdatedAtMs (the previous turn's atMs), which the extractor
// itself never touches — engine.ts threads it in as a separate parameter for
// exactly this reason.
function step(
  state: LiveCallState,
  t: LiveTurn,
  cfg = config
): { state: LiveCallState; signals: ReturnType<typeof detectSilenceGap>['signals'] } {
  const gapMs = Math.max(0, t.atMs - state.lastUpdatedAtMs)
  const { patch, signals } = detectSilenceGap(state, t, gapMs, cfg)
  return { state: { ...state, ...patch, lastUpdatedAtMs: t.atMs }, signals }
}

describe('detectSilenceGap', () => {
  it('fires silence-after-question with both evidence quotes attached in order once the gap is long enough', () => {
    let state = createInitialState(0)
    ;({ state } = step(state, turn('rep', 0, 'Do you have budget for this?')))
    const { signals } = step(state, turn('other', 15_000, 'Umm, let me check.'))

    expect(signals).toHaveLength(1)
    expect(signals[0].type).toBe('silence-after-question')
    expect(signals[0].evidence.map((e) => e.text)).toEqual([
      'Do you have budget for this?',
      'Umm, let me check.'
    ])
  })

  it('does not fire when the gap after a rep question is short', () => {
    let state = createInitialState(0)
    ;({ state } = step(state, turn('rep', 0, 'Do you have budget for this?')))
    const { signals } = step(state, turn('other', 3_000, 'Yes, we do.'))

    expect(signals).toEqual([])
  })

  it('never sets pendingRepQuestion for a rep turn that does not end in "?"', () => {
    const { state } = step(createInitialState(0), turn('rep', 0, 'Let me explain our pricing.'))
    expect(state.pendingRepQuestion).toBeNull()
  })

  it('clears pendingRepQuestion after any next turn, even a short-gap one', () => {
    let state = createInitialState(0)
    ;({ state } = step(state, turn('rep', 0, 'Does that make sense?')))
    expect(state.pendingRepQuestion).not.toBeNull()
    ;({ state } = step(state, turn('other', 1_000, 'Yeah.')))
    expect(state.pendingRepQuestion).toBeNull()
  })

  it('caps recentSilenceGapsMs at RECENT_GAPS_CAP, keeping the newest and dropping the oldest', () => {
    let state = createInitialState(0)
    const total = RECENT_GAPS_CAP + 5
    for (let i = 0; i < total; i++) {
      // Feeding gapMs directly (rather than via atMs deltas) keeps this test
      // about the cap, not about timestamp arithmetic already covered above.
      const { patch } = detectSilenceGap(state, turn('other', i, 'ok'), i, config)
      state = { ...state, ...patch }
    }

    expect(state.recentSilenceGapsMs).toHaveLength(RECENT_GAPS_CAP)
    expect(state.recentSilenceGapsMs).toEqual(
      Array.from({ length: RECENT_GAPS_CAP }, (_, i) => total - RECENT_GAPS_CAP + i)
    )
  })
})
