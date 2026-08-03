import { describe, expect, it } from 'vitest'
import { SessionTimeline, SleepDetector, formatGapMarker, isReplayable } from '../timeline'

/** A hand-cranked monotonic clock. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 5_000 // deliberately non-zero: origin must be subtracted, not assumed
  return { now: () => t, advance: (ms) => (t += ms) }
}

describe('SessionTimeline', () => {
  it('measures elapsed time from its own origin, not from zero', () => {
    const c = clock()
    const timeline = new SessionTimeline(c.now)
    expect(timeline.elapsedMs()).toBe(0)
    c.advance(1500)
    expect(timeline.elapsedMs()).toBe(1500)
  })

  it('records wall clock once, as metadata', () => {
    const timeline = new SessionTimeline(clock().now)
    expect(() => new Date(timeline.startedAtWallClock).toISOString()).not.toThrow()
  })

  it('accumulates gap markers with monotonic positions', () => {
    const c = clock()
    const timeline = new SessionTimeline(c.now)
    c.advance(10_000)
    timeline.markGap(27_000, 'reconnect')
    c.advance(5_000)
    timeline.markGap(3_000, 'shed')

    const gaps = timeline.gapMarkers()
    expect(gaps).toHaveLength(2)
    expect(gaps[0]).toEqual({ atMs: 10_000, durationMs: 27_000, reason: 'reconnect' })
    expect(gaps[1].atMs).toBe(15_000)
    expect(timeline.gapMs).toBe(30_000)
  })

  it('ignores sub-millisecond gaps', () => {
    const timeline = new SessionTimeline(clock().now)
    expect(timeline.markGap(0.4, 'shed')).toBeNull()
    expect(timeline.markGap(Number.NaN, 'shed')).toBeNull()
    expect(timeline.gapMarkers()).toHaveLength(0)
  })
})

describe('formatGapMarker', () => {
  it('renders whole seconds', () => {
    expect(formatGapMarker(34_000)).toBe('[gap: 34s]')
    expect(formatGapMarker(1_400)).toBe('[gap: 1s]')
  })

  it('never renders a 0s gap', () => {
    expect(formatGapMarker(200)).toBe('[gap: 1s]')
  })
})

describe('isReplayable', () => {
  it('allows a short tail and refuses a long backlog', () => {
    expect(isReplayable(2)).toBe(true)
    expect(isReplayable(30)).toBe(false)
    expect(isReplayable(1200)).toBe(false)
  })
})

describe('SleepDetector', () => {
  // powerMonitor fires twice on macOS and sometimes not at all, so the
  // MECHANISM has to be clock divergence; powerMonitor is only a faster hint.
  it('stays quiet on a normal tick', () => {
    const mono = clock()
    const wall = clock()
    const d = new SleepDetector(mono.now, wall.now)
    for (let i = 0; i < 10; i++) {
      mono.advance(1000)
      wall.advance(1000)
      expect(d.tick()).toBe(0)
    }
  })

  it('detects a 20-minute suspend from clock divergence alone', () => {
    const mono = clock()
    const wall = clock()
    const d = new SleepDetector(mono.now, wall.now)
    mono.advance(1000)
    wall.advance(1000)
    expect(d.tick()).toBe(0)

    // Suspended: wall time advanced 20 minutes, the monotonic clock barely moved.
    mono.advance(50)
    wall.advance(20 * 60_000)
    expect(d.tick()).toBeGreaterThan(19 * 60_000)
  })

  it('re-bases after a jump so one correction is not latched forever', () => {
    const mono = clock()
    const wall = clock()
    const d = new SleepDetector(mono.now, wall.now)
    mono.advance(50)
    wall.advance(600_000)
    expect(d.tick()).toBeGreaterThan(0)

    mono.advance(1000)
    wall.advance(1000)
    expect(d.tick()).toBe(0)
  })

  it('ignores a monotonic-only stall (a busy main thread is not sleep)', () => {
    const mono = clock()
    const wall = clock()
    const d = new SleepDetector(mono.now, wall.now)
    mono.advance(5000)
    wall.advance(5000)
    expect(d.tick()).toBe(0)
  })
})
