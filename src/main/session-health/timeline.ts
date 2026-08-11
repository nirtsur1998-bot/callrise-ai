// SessionTimeline — one object owning time for a transcription session (§1.1).
//
// The rule: `performance.now()` is the ONLY timeline source. Wall-clock time is
// recorded exactly once, at session start, as metadata — never as a source.
//
// Why this matters more than it looks: `Date.now()` can jump backwards (NTP
// correction), forwards (user changes the clock), and stalls across sleep in
// ways that differ per platform. Anything that derives an ELAPSED value from it
// silently produces a wrong answer that no test catches, because the wrongness
// only appears on the machine whose clock moved. `performance.now()` is
// monotonic by contract, so elapsed values are always meaningful.
//
// The timeline also owns gap markers, so "audio that never reached the
// transcript" is a first-class, reportable fact rather than an invisible hole.

import { HEALTH_TUNING, type GapReason, type TimelineGap } from './types'

/** Injectable so tests can drive time deterministically. */
export type Clock = () => number

export class SessionTimeline {
  private readonly clock: Clock
  private readonly originMs: number
  private readonly gaps: TimelineGap[] = []
  private totalGapMs = 0

  /** Wall clock at session start — METADATA ONLY. Never subtract from this. */
  readonly startedAtWallClock: string

  constructor(clock: Clock = () => performance.now()) {
    this.clock = clock
    this.originMs = clock()
    this.startedAtWallClock = new Date().toISOString()
  }

  /** Monotonic milliseconds since this session started. */
  elapsedMs(): number {
    return this.clock() - this.originMs
  }

  /**
   * Record audio that will never reach the transcript, so the gap can be shown
   * to the user as `[gap: Ns]` instead of silently corrupting the timeline.
   * Sub-millisecond gaps are ignored — they are rounding, not loss.
   */
  markGap(durationMs: number, reason: GapReason): TimelineGap | null {
    if (!Number.isFinite(durationMs) || durationMs < 1) return null
    const gap: TimelineGap = {
      atMs: Math.round(this.elapsedMs()),
      durationMs: Math.round(durationMs),
      reason
    }
    this.gaps.push(gap)
    this.totalGapMs += gap.durationMs
    return gap
  }

  /** Total audio lost this session, in ms. */
  get gapMs(): number {
    return this.totalGapMs
  }

  gapMarkers(): readonly TimelineGap[] {
    return this.gaps
  }
}

/**
 * Detects that the machine slept, WITHOUT relying on Electron's `powerMonitor`
 * (which fires twice on macOS and sometimes not at all — §5.2). The mechanism
 * is a plain interval that notices wall clock advanced far more than the
 * monotonic clock did: that divergence is only possible if the process was
 * suspended.
 *
 * `powerMonitor` is still useful as a FASTER hint, but never as the mechanism.
 */
export class SleepDetector {
  private readonly monotonic: Clock
  private readonly wall: Clock
  private readonly toleranceMs: number
  private lastMonotonic: number
  private lastWall: number

  constructor(
    monotonic: Clock = () => performance.now(),
    wall: Clock = () => Date.now(),
    toleranceMs = 2_000
  ) {
    this.monotonic = monotonic
    this.wall = wall
    this.toleranceMs = toleranceMs
    this.lastMonotonic = monotonic()
    this.lastWall = wall()
  }

  /**
   * Call on a ~1s interval. Returns how long the machine appears to have been
   * suspended, or 0 for a normal tick.
   *
   * Both clocks are re-based every tick, so a one-off wall-clock correction
   * costs one false reading at most rather than latching a permanent offset.
   */
  tick(): number {
    const nowMonotonic = this.monotonic()
    const nowWall = this.wall()
    const monotonicDelta = nowMonotonic - this.lastMonotonic
    const wallDelta = nowWall - this.lastWall
    this.lastMonotonic = nowMonotonic
    this.lastWall = nowWall
    // A suspended process advances wall time while its monotonic clock is
    // (mostly) frozen. Requiring BOTH a large wall jump and a large divergence
    // means an NTP step alone can't be mistaken for sleep.
    const divergence = wallDelta - monotonicDelta
    if (divergence > this.toleranceMs && wallDelta > this.toleranceMs) {
      return Math.round(divergence)
    }
    return 0
  }
}

/**
 * Render `[gap: Ns]` for a transcript. Kept here so main and renderer can never
 * disagree about the marker's shape.
 */
export function formatGapMarker(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1000))
  return `[gap: ${seconds}s]`
}

/** Whether a discarded backlog is small enough to simply replay (§1.3). */
export function isReplayable(bufferedSec: number): boolean {
  return bufferedSec <= HEALTH_TUNING.replayCapSec
}
