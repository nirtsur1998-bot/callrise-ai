import { describe, expect, it } from 'vitest'
import { CueLatencyTracker, formatLatencyReport, percentile } from '../cue-latency'

describe('percentile', () => {
  it('has no answer for no data', () => {
    expect(percentile([], 50)).toBeNull()
  })

  // Nearest-rank, not interpolated: every published number must be a latency
  // that genuinely occurred, not one nobody ever experienced.
  it('returns a value that is actually in the data', () => {
    const sorted = [10, 20, 30, 40]
    expect(sorted).toContain(percentile(sorted, 50))
    expect(sorted).toContain(percentile(sorted, 95))
  })

  it('picks the nearest rank at the ends', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(percentile(sorted, 50)).toBe(5)
    expect(percentile(sorted, 95)).toBe(10)
    expect(percentile(sorted, 100)).toBe(10)
  })

  it('handles a single sample', () => {
    expect(percentile([42], 50)).toBe(42)
    expect(percentile([42], 95)).toBe(42)
  })
})

describe('CueLatencyTracker', () => {
  it('reports nothing before it has seen anything', () => {
    const t = new CueLatencyTracker()
    expect(t.stats('interrupt')).toEqual({ count: 0, p50: null, p95: null, max: null })
  })

  // The two tiers are different products sharing a screen — quoting the fast
  // number for both is exactly the dishonesty this exists to prevent.
  it('keeps the tiers completely separate', () => {
    const t = new CueLatencyTracker()
    for (let i = 0; i < 20; i++) t.record('interrupt', 400)
    for (let i = 0; i < 20; i++) t.record('suggestion', 2000)
    expect(t.stats('interrupt').p50).toBe(400)
    expect(t.stats('suggestion').p50).toBe(2000)
  })

  it('computes a p95 that reflects a tail bigger than 5%', () => {
    const t = new CueLatencyTracker()
    for (let i = 0; i < 94; i++) t.record('interrupt', 300)
    for (let i = 0; i < 6; i++) t.record('interrupt', 1800)
    const stats = t.stats('interrupt')
    expect(stats.p50).toBe(300)
    expect(stats.p95).toBe(1800)
    expect(stats.max).toBe(1800)
  })

  // Nearest-rank p95 sits just BELOW a tail that is exactly 5% — which is
  // correct (95% of cues really were 300ms) and is why `max` is reported
  // alongside it rather than instead of it.
  it('does not overstate a tail that is exactly 5%', () => {
    const t = new CueLatencyTracker()
    for (let i = 0; i < 95; i++) t.record('interrupt', 300)
    for (let i = 0; i < 5; i++) t.record('interrupt', 1800)
    expect(t.stats('interrupt').p95).toBe(300)
    expect(t.stats('interrupt').max).toBe(1800)
  })

  it('surfaces a tail that a healthy p95 would hide', () => {
    const t = new CueLatencyTracker()
    for (let i = 0; i < 99; i++) t.record('interrupt', 350)
    t.record('interrupt', 9000)
    expect(t.stats('interrupt').p95).toBe(350) // looks fine...
    expect(t.stats('interrupt').max).toBe(9000) // ...but it wasn't, once
  })

  it('ignores impossible measurements rather than poisoning the stats', () => {
    const t = new CueLatencyTracker()
    t.record('interrupt', -1)
    t.record('interrupt', Number.NaN)
    t.record('interrupt', Number.POSITIVE_INFINITY)
    expect(t.stats('interrupt').count).toBe(0)
  })

  it('bounds its window so a long call is not dominated by its first minutes', () => {
    const t = new CueLatencyTracker()
    for (let i = 0; i < 200; i++) t.record('interrupt', 5000) // an early bad patch
    for (let i = 0; i < 200; i++) t.record('interrupt', 300) // then conditions improve
    const stats = t.stats('interrupt')
    expect(stats.count).toBe(200)
    expect(stats.p50).toBe(300)
    expect(stats.max).toBe(300)
  })

  it('clears both tiers on reset', () => {
    const t = new CueLatencyTracker()
    t.record('interrupt', 400)
    t.record('suggestion', 2000)
    t.reset()
    expect(t.report().interrupt.count).toBe(0)
    expect(t.report().suggestion.count).toBe(0)
  })
})

describe('formatLatencyReport', () => {
  it('says so plainly when there is nothing to report', () => {
    expect(formatLatencyReport(new CueLatencyTracker().report())).toBe(
      'interrupt: no samples | suggestion: no samples'
    )
  })

  it('publishes both tiers with their sample counts', () => {
    const t = new CueLatencyTracker()
    t.record('interrupt', 380)
    t.record('suggestion', 1900)
    const line = formatLatencyReport(t.report())
    expect(line).toContain('interrupt: p50 380ms · p95 380ms (n=1)')
    expect(line).toContain('suggestion: p50 1900ms · p95 1900ms (n=1)')
  })
})
