import { describe, expect, it } from 'vitest'
import {
  MONOLOGUE_TUNING,
  MonologueTracker,
  computeTalkRatio,
  formatMonologue,
  type Turn
} from '../monologue'

const words = (n: number): string => Array.from({ length: n }, () => 'word').join(' ')
const turn = (speaker: number, n: number, t: number): Turn => ({ speaker, text: words(n), t })

describe('computeTalkRatio', () => {
  // A gauge reading "100% you" because the rep said hello first is a gauge the
  // rep stops believing by minute two.
  it('has no opinion before there are enough words', () => {
    const r = computeTalkRatio([turn(0, 5, 0)], 0)
    expect(r.ratio).toBeNull()
    expect(r.tone).toBe('neutral')
  })

  it('has no opinion before the rep is identified', () => {
    expect(computeTalkRatio([turn(0, 100, 0)], null).ratio).toBeNull()
  })

  it('reports the rep share once there is enough to say', () => {
    const r = computeTalkRatio([turn(0, 60, 0), turn(1, 40, 1)], 0)
    expect(r.repWords).toBe(60)
    expect(r.otherWords).toBe(40)
    expect(r.ratio).toBeCloseTo(0.6)
  })

  it('flags a lopsided call', () => {
    expect(computeTalkRatio([turn(0, 90, 0), turn(1, 10, 1)], 0).tone).toBe('high')
  })

  // A discovery call SHOULD be buyer-heavy. A meter that complains about
  // listening would be worse than no meter.
  it('never complains about the rep listening', () => {
    expect(computeTalkRatio([turn(0, 10, 0), turn(1, 90, 1)], 0).tone).toBe('good')
    expect(computeTalkRatio([turn(1, 200, 0)], 0).tone).toBe('good')
  })

  it('counts every non-rep speaker as the other side', () => {
    const r = computeTalkRatio([turn(0, 20, 0), turn(1, 20, 1), turn(2, 20, 2)], 0)
    expect(r.repWords).toBe(20)
    expect(r.otherWords).toBe(40)
  })

  it('survives an empty call', () => {
    expect(computeTalkRatio([], 0).ratio).toBeNull()
  })
})

describe('MonologueTracker', () => {
  const t = (): MonologueTracker => new MonologueTracker()

  it('says nothing before the rep is known', () => {
    expect(t().update([turn(0, 50, 0)], null, 100_000).ms).toBe(0)
  })

  it('times an uninterrupted run of rep turns', () => {
    const m = t()
    const state = m.update([turn(0, 20, 0), turn(0, 20, 5_000)], 0, 30_000)
    expect(state.ms).toBe(30_000)
  })

  // "Uninterrupted" is measured by TURNS, not silence: a pause for breath is
  // not the buyer speaking, and resetting on it would never register the
  // monologue this exists to catch.
  it('does not reset on a pause between the rep’s own turns', () => {
    const m = t()
    const state = m.update([turn(0, 20, 0), turn(0, 20, 40_000)], 0, 60_000)
    expect(state.ms).toBe(60_000)
  })

  it('resets the moment the other side gets in', () => {
    const m = t()
    expect(m.update([turn(0, 20, 0)], 0, 90_000).nudging).toBe(true)
    expect(m.update([turn(0, 20, 0), turn(1, 5, 91_000)], 0, 92_000).ms).toBe(0)
  })

  it('starts the next run from the rep’s first turn after the interruption', () => {
    const m = t()
    const turns = [turn(0, 20, 0), turn(1, 5, 60_000), turn(0, 20, 61_000)]
    expect(m.update(turns, 0, 71_000).ms).toBe(10_000)
  })

  it('climbs through the tones rather than jumping', () => {
    const m = t()
    expect(m.update([turn(0, 20, 0)], 0, 1_000).tone).toBe('good')
    expect(m.update([turn(0, 20, 0)], 0, MONOLOGUE_TUNING.warnMs).tone).toBe('warn')
    expect(m.update([turn(0, 20, 0)], 0, MONOLOGUE_TUNING.nudgeMs).tone).toBe('high')
  })

  it('only nudges past the threshold', () => {
    const m = t()
    expect(m.update([turn(0, 20, 0)], 0, MONOLOGUE_TUNING.nudgeMs - 1).nudging).toBe(false)
    expect(m.update([turn(0, 20, 0)], 0, MONOLOGUE_TUNING.nudgeMs).nudging).toBe(true)
  })

  it('handles an empty buffer', () => {
    expect(t().update([], 0, 10_000).ms).toBe(0)
  })

  it('never reports negative time if a turn is stamped ahead of now', () => {
    expect(t().update([turn(0, 20, 5_000)], 0, 1_000).ms).toBe(0)
  })

  it('clears on reset', () => {
    const m = t()
    m.update([turn(0, 20, 0)], 0, 90_000)
    m.reset()
    expect(m.runStartedAt).toBeNull()
  })
})

describe('formatMonologue', () => {
  it('reads at a glance', () => {
    expect(formatMonologue(0)).toBe('0:00')
    expect(formatMonologue(9_000)).toBe('0:09')
    expect(formatMonologue(75_000)).toBe('1:15')
    expect(formatMonologue(605_000)).toBe('10:05')
  })

  it('never renders a negative clock', () => {
    expect(formatMonologue(-5_000)).toBe('0:00')
  })
})
