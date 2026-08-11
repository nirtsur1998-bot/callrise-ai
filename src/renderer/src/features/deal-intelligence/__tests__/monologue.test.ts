import { describe, expect, it } from 'vitest'
import { detectMonologue } from '../tier0/monologue'
import { createInitialState, type LiveCallState, type LiveTurn, type Tier0Signal } from '../types'

const turn = (
  role: LiveTurn['role'],
  atMs: number,
  speaker = role === 'rep' ? 0 : 1
): LiveTurn => ({ speaker, text: 'talking', role, atMs })

const config = { monologueThresholdMs: 90_000 }

// Threads state through detectMonologue the way engine.ts's ingestTurn does
// around it — repSpeaker set from a rep turn before the extractor runs,
// previousRole captured from the incoming state rather than read back off
// it (engine.ts's file comment explains why: a second extractor reading
// state.lastTurnRole would see this turn's own value, not the prior one).
function fold(turns: LiveTurn[], cfg = config): { state: LiveCallState; signals: Tier0Signal[][] } {
  let state = createInitialState(0)
  let previousRole: LiveTurn['role'] | null = null
  const signals: Tier0Signal[][] = []
  for (const t of turns) {
    const next: LiveCallState = {
      ...state,
      repSpeaker: t.role === 'rep' ? t.speaker : state.repSpeaker
    }
    const result = detectMonologue(next, t, previousRole, cfg)
    state = { ...next, ...result.patch }
    signals.push(result.signals)
    previousRole = t.role
  }
  return { state, signals }
}

describe('detectMonologue', () => {
  it('accumulates ms correctly across multiple folds of consecutive rep turns', () => {
    const { state } = fold([turn('rep', 0), turn('rep', 30_000), turn('rep', 65_000)])
    expect(state.currentRepMonologueMs).toBe(65_000)
    expect(state.longestRepMonologueMs).toBe(65_000)
  })

  it('resets the run to 0 on a non-rep turn, but keeps the recorded longest', () => {
    const { state } = fold([turn('rep', 0), turn('rep', 50_000), turn('other', 55_000)])
    expect(state.currentRepMonologueMs).toBe(0)
    expect(state.repMonologueStartAtMs).toBeNull()
    expect(state.longestRepMonologueMs).toBe(50_000)
  })

  // "Uninterrupted" is measured by TURNS, not silence — repeated rep turns
  // keep extending the same run rather than each restarting the clock.
  it('does not reset on repeated same-role rep turns', () => {
    const { state } = fold([turn('rep', 0), turn('rep', 20_000), turn('rep', 45_000)])
    expect(state.currentRepMonologueMs).toBe(45_000)
  })

  it('fires long-monologue exactly once, on the turn crossing the threshold', () => {
    const { signals } = fold([
      turn('rep', 0), // 0ms — nowhere near the threshold
      turn('rep', 90_000), // crosses 90s
      turn('rep', 120_000) // stays over — no re-fire
    ])
    expect(signals[0]).toEqual([])
    expect(signals[1]).toHaveLength(1)
    expect(signals[1][0].type).toBe('long-monologue')
    expect(signals[2]).toEqual([])
  })

  // A monologue, interrupted, then a SHORTER second monologue should leave
  // longestRepMonologueMs parked at the first run's peak, not overwritten
  // by the smaller second run.
  it('tracks longestRepMonologueMs as the max across separate runs', () => {
    const { state } = fold([
      turn('rep', 0),
      turn('rep', 100_000), // first run peaks at 100s
      turn('other', 105_000), // interrupted
      turn('rep', 110_000),
      turn('rep', 130_000) // second run only reaches 20s
    ])
    expect(state.currentRepMonologueMs).toBe(20_000)
    expect(state.longestRepMonologueMs).toBe(100_000)
  })

  it('does nothing before repSpeaker is known', () => {
    const state = createInitialState(0)
    const result = detectMonologue(state, turn('rep', 5_000, 0), null, config)
    expect(result.patch).toEqual({ repMonologueStartAtMs: null, currentRepMonologueMs: 0 })
    expect(result.signals).toEqual([])
  })
})
