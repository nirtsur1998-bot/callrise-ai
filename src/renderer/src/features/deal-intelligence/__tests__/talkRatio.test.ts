import { describe, expect, it } from 'vitest'
import { detectTalkRatio } from '../tier0/talkRatio'
import { createInitialState, type LiveCallState, type LiveTurn, type Tier0Signal } from '../types'

const words = (n: number): string => Array.from({ length: n }, () => 'word').join(' ')

const turn = (
  role: LiveTurn['role'],
  n: number,
  atMs: number,
  speaker = role === 'rep' ? 0 : 1
): LiveTurn => ({ speaker, text: words(n), role, atMs })

// Threads state through detectTalkRatio the same way engine.ts's ingestTurn
// does around it — repSpeaker gets set from a rep turn BEFORE the extractor
// runs, and previousRole is captured from the incoming state rather than
// read back off it — so these tests exercise exactly what the extractor
// sees in production without re-testing engine.ts's own wiring.
function fold(turns: LiveTurn[]): { state: LiveCallState; signals: Tier0Signal[][] } {
  let state = createInitialState(0)
  let previousRole: LiveTurn['role'] | null = null
  const signals: Tier0Signal[][] = []
  for (const t of turns) {
    const next: LiveCallState = {
      ...state,
      repSpeaker: t.role === 'rep' ? t.speaker : state.repSpeaker
    }
    const result = detectTalkRatio(next, t, previousRole)
    state = { ...next, ...result.patch }
    signals.push(result.signals)
    previousRole = t.role
  }
  return { state, signals }
}

describe('detectTalkRatio', () => {
  // Mirrors computeTalkRatio's own floor (see features/live/monologue.ts) —
  // a ratio from a handful of words is noise, not a reading.
  it('has no opinion before there are enough words', () => {
    const { state } = fold([turn('rep', 5, 0)])
    expect(state.talkRatio).toBeNull()
  })

  it('has no opinion before the rep is identified', () => {
    // Only 'other' turns so far — repSpeaker never gets set, so even 100
    // words can't produce a ratio.
    const { state } = fold([turn('other', 100, 0)])
    expect(state.talkRatio).toBeNull()
  })

  it('splits word counts correctly once there is enough to say', () => {
    const { state } = fold([turn('rep', 60, 0), turn('other', 40, 1)])
    expect(state.talkWords).toEqual({ rep: 60, other: 40 })
    expect(state.talkRatio).toBeCloseTo(0.6)
  })

  // A repeated nudge for the same ongoing condition is exactly the spam
  // Coaching Cues 2.0 is trying to avoid — the signal should only mark the
  // moment the ratio crosses into lopsided.
  it('fires talk-ratio-skewed exactly once on the crossing turn, not again while it stays skewed', () => {
    const { signals } = fold([
      turn('rep', 35, 0), // total 35 — below the 40-word floor, no ratio yet
      turn('rep', 10, 1), // total 45, ratio 1.0 — crosses
      turn('rep', 5, 2) // total 50, ratio still 1.0 — stays skewed, no re-fire
    ])
    expect(signals[0]).toEqual([])
    expect(signals[1]).toHaveLength(1)
    expect(signals[1][0].type).toBe('talk-ratio-skewed')
    expect(signals[2]).toEqual([])
  })

  it('increments interruptionCount on a role change, not on same-role consecutive turns', () => {
    const { state } = fold([
      turn('rep', 5, 0), // first turn — nothing to interrupt yet
      turn('rep', 5, 1), // same role — no interruption
      turn('other', 5, 2), // role change — interruption
      turn('other', 5, 3), // same role — no interruption
      turn('rep', 5, 4) // role change — interruption
    ])
    expect(state.interruptionCount).toBe(2)
  })

  it('is a no-op on an unknown-role turn', () => {
    const state = createInitialState(0)
    const result = detectTalkRatio(state, turn('unknown', 20, 0), 'rep')
    expect(result.patch).toEqual({})
    expect(result.signals).toEqual([])
  })
})
