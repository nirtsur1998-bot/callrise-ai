// Two-cursor lag tracking (§1.2) — the metric that makes the 90-second lag bug
// visible instead of unreproducible.
//
//   X = seconds of audio SUBMITTED to Deepgram (cumulative, across reconnects)
//   Y = seconds Deepgram has ACKNOWLEDGED (start + duration of the latest result)
//   lag = X − Y
//
// The critical design point is that both cursors are CUMULATIVE ACROSS
// RECONNECTS. The previous implementation reset its counter to 0 on every
// socket open (because Deepgram restarts its own audio clock per connection),
// which meant the metric was structurally incapable of observing lag that
// accumulated across a reconnect — precisely the case it existed to catch.
//
// Here, `ackBaseSec` records where the cumulative cursor stood when the current
// connection opened, so a per-connection `start + duration` maps back onto the
// session-wide scale and the reading stays continuous.

import { HEALTH_TUNING, type LagAction, type LagSample } from './types'

export interface LagVerdict {
  action: LagAction
  medianLagSec: number
  /** Set when the action was triggered by the slope rather than the value —
   *  the ratchet guard. Worth surfacing separately: a small-but-climbing lag
   *  is the shape of the bug, and the absolute number looks fine. */
  rising: boolean
  /** Populated when `action` is 'reset' but the budget refused it. */
  suppressed?: 'budget' | 'backoff'
}

export class LagTracker {
  private submittedSec = 0
  /** Cumulative submitted-seconds at the moment the current socket opened. */
  private ackBaseSec = 0
  /** Highest `start + duration` seen on the CURRENT connection. Monotonic, so
   *  an out-of-order interim result can never walk the acknowledgement back. */
  private connectionAckSec = 0
  /** Silence we injected on the current connection purely to keep Deepgram's
   *  no-audio deadline satisfied while the mic was muted. It advances the
   *  server's audio clock but is not real audio, so it is subtracted back out
   *  of the acknowledgement — otherwise a long pause quietly buys the pipeline
   *  free "credit" and the lag reading under-reports for the rest of the call. */
  private connectionSyntheticSec = 0
  private samples: LagSample[] = []
  private lastSampleAtMs = -Infinity
  /** Monotonic ms of each reset, for the per-window budget. */
  private resetAtMs: number[] = []
  private nextResetAllowedAtMs = 0

  /** Audio handed to the socket. Discarded audio must NOT go through here. */
  onAudioSubmitted(seconds: number): void {
    if (Number.isFinite(seconds) && seconds > 0) this.submittedSec += seconds
  }

  /**
   * A new connection is live. Deepgram's audio clock restarts at 0, so rebase:
   * everything acknowledged from now on is relative to what we had submitted
   * at this instant.
   */
  onConnectionOpen(): void {
    this.ackBaseSec = this.submittedSec
    this.connectionAckSec = 0
    this.connectionSyntheticSec = 0
  }

  /** Silence injected to keep the socket alive while the mic is muted. Not
   *  real audio: recorded only so it can be subtracted back out of the
   *  server's audio clock. */
  onSilenceSubmitted(seconds: number): void {
    if (Number.isFinite(seconds) && seconds > 0) this.connectionSyntheticSec += seconds
  }

  /** `start + duration` from a Deepgram Results message, in seconds. */
  onAcknowledged(startPlusDuration: number): void {
    if (!Number.isFinite(startPlusDuration) || startPlusDuration < 0) return
    if (startPlusDuration > this.connectionAckSec) this.connectionAckSec = startPlusDuration
  }

  /**
   * Audio removed from the queue without being sent (shed or discarded on
   * reconnect). It never counted toward `submittedSec`, so the cursors need no
   * adjustment — but the caller still wants the seconds for the gap marker,
   * and routing it through here keeps that intent explicit at the call site.
   */
  get submittedSeconds(): number {
    return this.submittedSec
  }

  get acknowledgedSeconds(): number {
    return this.ackBaseSec + Math.max(0, this.connectionAckSec - this.connectionSyntheticSec)
  }

  /** Instantaneous lag. Never act on this directly — use `sample`/`evaluate`. */
  get instantLagSec(): number {
    return Math.max(0, this.submittedSeconds - this.acknowledgedSeconds)
  }

  /**
   * Take a 1Hz sample. Call freely; readings closer together than
   * `lagSampleMs` are ignored so the median window always spans a real
   * ~5 seconds regardless of how often the caller ticks.
   */
  sample(atMs: number): LagSample | null {
    if (atMs - this.lastSampleAtMs < HEALTH_TUNING.lagSampleMs) return null
    this.lastSampleAtMs = atMs
    const s: LagSample = { atMs, lagSec: this.instantLagSec }
    this.samples.push(s)
    // Keep enough history for the rising-slope window, with a little slack.
    const cutoff = atMs - HEALTH_TUNING.risingWindowMs * 2
    while (this.samples.length > 0 && this.samples[0].atMs < cutoff) this.samples.shift()
    return s
  }

  /** Median of the last `lagMedianWindow` samples. 0 when there is no data. */
  medianLagSec(): number {
    const recent = this.samples.slice(-HEALTH_TUNING.lagMedianWindow)
    if (recent.length === 0) return 0
    const sorted = recent.map((s) => s.lagSec).sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  }

  /**
   * The ratchet guard. Splits the trailing `risingWindowMs` into buckets, takes
   * each bucket's median, and reports a rise when every bucket is at least as
   * high as the one before it (within tolerance) AND the net rise is real.
   *
   * Bucketed medians rather than raw samples because raw lag is noisy at the
   * ~100ms scale and a strict sample-by-sample monotonicity test would almost
   * never fire on real data.
   */
  isRising(atMs: number): boolean {
    const { risingWindowMs, risingBuckets, risingToleranceSec, risingMinRiseSec } = HEALTH_TUNING
    const windowStart = atMs - risingWindowMs
    const inWindow = this.samples.filter((s) => s.atMs >= windowStart)
    // Need the window genuinely covered, not just a couple of stray samples.
    if (inWindow.length < risingBuckets * 2) return false
    if (atMs - inWindow[0].atMs < risingWindowMs * 0.9) return false

    const bucketMs = risingWindowMs / risingBuckets
    const medians: number[] = []
    for (let i = 0; i < risingBuckets; i++) {
      const from = windowStart + i * bucketMs
      const to = from + bucketMs
      const bucket = inWindow.filter((s) => s.atMs >= from && s.atMs < to).map((s) => s.lagSec)
      if (bucket.length === 0) return false // a hole in the window — don't guess
      bucket.sort((a, b) => a - b)
      const mid = Math.floor(bucket.length / 2)
      medians.push(bucket.length % 2 === 1 ? bucket[mid] : (bucket[mid - 1] + bucket[mid]) / 2)
    }

    for (let i = 1; i < medians.length; i++) {
      if (medians[i] < medians[i - 1] - risingToleranceSec) return false
    }
    return medians[medians.length - 1] - medians[0] >= risingMinRiseSec
  }

  /**
   * What should happen right now. `reset` is only ever returned when the reset
   * budget actually permits it — otherwise the verdict degrades to `shed` with
   * `suppressed` set, so the caller can never build a reconnect storm out of a
   * condition it cannot fix.
   */
  evaluate(atMs: number): LagVerdict {
    const median = this.medianLagSec()
    const rising = this.isRising(atMs)
    const wantsReset = median >= HEALTH_TUNING.resetLagSec || rising

    if (wantsReset) {
      const gate = this.resetGate(atMs)
      if (gate === 'ok') return { action: 'reset', medianLagSec: median, rising }
      return {
        action: median >= HEALTH_TUNING.shedLagSec ? 'shed' : 'warn',
        medianLagSec: median,
        rising,
        suppressed: gate
      }
    }
    if (median >= HEALTH_TUNING.shedLagSec) return { action: 'shed', medianLagSec: median, rising }
    if (median >= HEALTH_TUNING.warnLagSec) return { action: 'warn', medianLagSec: median, rising }
    return { action: 'none', medianLagSec: median, rising }
  }

  private resetGate(atMs: number): 'ok' | 'budget' | 'backoff' {
    const windowStart = atMs - HEALTH_TUNING.resetWindowMs
    this.resetAtMs = this.resetAtMs.filter((t) => t >= windowStart)
    if (this.resetAtMs.length >= HEALTH_TUNING.maxResetsPerWindow) return 'budget'
    if (atMs < this.nextResetAllowedAtMs) return 'backoff'
    return 'ok'
  }

  /**
   * Record that a reset actually happened, arming the backoff for the next one.
   * Separate from `evaluate` so a caller that decides not to act (or fails to)
   * doesn't burn budget.
   */
  noteReset(atMs: number): void {
    this.resetAtMs.push(atMs)
    const index = Math.min(this.resetAtMs.length, HEALTH_TUNING.resetBackoffMs.length) - 1
    this.nextResetAllowedAtMs = atMs + HEALTH_TUNING.resetBackoffMs[index]
    // A reset resumes at the live edge, so the history describes a pipeline
    // that no longer exists — keeping it would re-trip the rising guard
    // immediately on the old, high samples.
    this.samples = []
  }

  get resetCount(): number {
    return this.resetAtMs.length
  }

  /**
   * Resuming at the live edge: everything submitted is declared acknowledged,
   * because the backlog it referred to has been thrown away. Without this the
   * lag reading stays pinned at its pre-reset value forever.
   */
  resumeAtLiveEdge(): void {
    this.ackBaseSec = this.submittedSec
    this.connectionAckSec = 0
    this.connectionSyntheticSec = 0
    this.samples = []
    this.lastSampleAtMs = -Infinity
  }

  recentSamples(): readonly LagSample[] {
    return this.samples
  }
}
