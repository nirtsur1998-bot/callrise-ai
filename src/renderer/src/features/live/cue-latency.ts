// Measured cue latency (§1.7) — from the moment a turn ends to the moment a
// cue is actually on screen.
//
// Balto, Cresta ("near-zero"), Observe.AI and Spiky all assert speed and none
// of them publish a number. Once the instrumentation exists this costs one
// histogram, and a measured p50/p95 is a credible, unfakeable differentiator
// against companies a thousand times the size.
//
// Measured per TIER, because the two are different products sharing a screen:
//
//   interrupt   — deterministic triggers. ASR partial ~300ms + match ~50ms +
//                 render ~50ms, so ~400ms is the realistic target and the p95
//                 is the number worth publishing.
//   suggestion  — LLM-generated. Realistically 1.5–2.5s, which is past the
//                 ~1.5s threshold where an interruption starts doing more harm
//                 than good. That is precisely why it is not allowed to
//                 interrupt, and measuring it is how we keep ourselves honest
//                 about the gap rather than quoting the fast number for both.

export type CueTier = 'interrupt' | 'suggestion'

export interface LatencyStats {
  count: number
  /** Milliseconds. Null until there is at least one sample. */
  p50: number | null
  p95: number | null
  /** Slowest sample retained, for spotting the tail behind a healthy p95. */
  max: number | null
}

export type CueLatencyReport = Record<CueTier, LatencyStats>

const EMPTY: LatencyStats = { count: 0, p50: null, p95: null, max: null }

/** Enough to make a p95 meaningful, small enough that a long call's early
 *  minutes stop dominating the number once conditions change. */
const WINDOW = 200

/**
 * Nearest-rank percentile on a sorted ascending array.
 *
 * Nearest-rank rather than interpolated on purpose: every reported value is a
 * latency that genuinely occurred, so "p95 = 1840ms" means some cue really did
 * take 1840ms. An interpolated percentile invents a number nobody experienced,
 * which is the wrong property for a figure we intend to publish.
 */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]
}

export class CueLatencyTracker {
  private samples: Record<CueTier, number[]> = { interrupt: [], suggestion: [] }

  /** Record one turn-end → cue-rendered measurement. */
  record(tier: CueTier, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return
    const bucket = this.samples[tier]
    bucket.push(ms)
    if (bucket.length > WINDOW) bucket.shift()
  }

  stats(tier: CueTier): LatencyStats {
    const bucket = this.samples[tier]
    if (bucket.length === 0) return EMPTY
    const sorted = [...bucket].sort((a, b) => a - b)
    return {
      count: sorted.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      max: sorted[sorted.length - 1]
    }
  }

  report(): CueLatencyReport {
    return { interrupt: this.stats('interrupt'), suggestion: this.stats('suggestion') }
  }

  reset(): void {
    this.samples = { interrupt: [], suggestion: [] }
  }
}

/** One-line summary for a log or the --diagnose report. */
export function formatLatencyReport(report: CueLatencyReport): string {
  const part = (tier: CueTier): string => {
    const s = report[tier]
    if (s.count === 0) return `${tier}: no samples`
    return `${tier}: p50 ${s.p50}ms · p95 ${s.p95}ms (n=${s.count})`
  }
  return `${part('interrupt')} | ${part('suggestion')}`
}
