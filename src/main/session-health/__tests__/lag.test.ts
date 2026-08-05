import { describe, expect, it } from 'vitest'
import { LagTracker } from '../lag'
import { HEALTH_TUNING } from '../types'

/**
 * Models one Deepgram connection, whose audio clock starts at 0 no matter how
 * much the SESSION has already streamed. Getting this right in the harness
 * matters: acknowledgements are connection-relative while the submitted cursor
 * is cumulative, and a helper that conflates the two silently tests nothing.
 */
class FakeConnection {
  private readonly baseline: number
  private acked = 0

  constructor(private readonly tracker: LagTracker) {
    this.baseline = tracker.submittedSeconds
    tracker.onConnectionOpen()
  }

  /** Establish a standing lag without a ramp: audio sent but never acked. */
  primeLag(seconds: number): this {
    this.tracker.onAudioSubmitted(seconds)
    return this
  }

  /** One second of audio, acknowledged so the lag lands on `lagSec`. */
  tick(atMs: number, lagSec: number): void {
    this.tracker.onAudioSubmitted(1)
    const onThisConnection = this.tracker.submittedSeconds - this.baseline
    // Deepgram never un-acknowledges audio, so the harness must not either.
    this.acked = Math.max(this.acked, onThisConnection - lagSec)
    this.tracker.onAcknowledged(this.acked)
    this.tracker.sample(atMs)
  }
}

/** Drive a connection at 1Hz with a lag that follows `lagAt(second)`. */
function run(
  connection: FakeConnection,
  seconds: number,
  lagAt: (s: number) => number,
  fromMs = 0
): number {
  let t = fromMs
  for (let s = 0; s < seconds; s++) {
    t = fromMs + s * 1000
    connection.tick(t, lagAt(s))
  }
  return t
}

/** A tracker holding a steady `lagSec`, with no ramp in its history. */
function steady(lagSec: number): { tracker: LagTracker; connection: FakeConnection } {
  const tracker = new LagTracker()
  const connection = new FakeConnection(tracker).primeLag(lagSec)
  return { tracker, connection }
}

describe('LagTracker cursors', () => {
  it('reports submitted − acknowledged', () => {
    const t = new LagTracker()
    t.onConnectionOpen()
    t.onAudioSubmitted(10)
    t.onAcknowledged(7)
    expect(t.instantLagSec).toBeCloseTo(3)
  })

  it('never walks the acknowledgement backwards on an out-of-order result', () => {
    const t = new LagTracker()
    t.onConnectionOpen()
    t.onAudioSubmitted(10)
    t.onAcknowledged(8)
    t.onAcknowledged(5) // late interim for older audio
    expect(t.instantLagSec).toBeCloseTo(2)
  })

  // This is the regression the old implementation could not catch: it zeroed
  // its counter on every socket open, so lag carried across a reconnect was
  // structurally invisible to the metric that existed to find it.
  it('keeps lag continuous across a reconnect', () => {
    const t = new LagTracker()
    t.onConnectionOpen()
    t.onAudioSubmitted(30)
    t.onAcknowledged(10) // 20s behind when the socket dies

    t.onConnectionOpen() // Deepgram's audio clock restarts at 0
    t.onAudioSubmitted(5)
    t.onAcknowledged(1) // 1s acknowledged on the NEW connection

    // 35 submitted; 10 acked on the old connection + 1 on the new = 11.
    expect(t.submittedSeconds).toBeCloseTo(35)
    expect(t.acknowledgedSeconds).toBeCloseTo(31)
    expect(t.instantLagSec).toBeCloseTo(4)
  })

  // Silence sent to keep Deepgram's no-audio deadline satisfied advances the
  // SERVER's audio clock but is not real audio. Left uncorrected, a long
  // muted stretch buys the pipeline acknowledgement credit it never earned,
  // and lag under-reports for the rest of the connection.
  it('does not let injected silence buy acknowledgement credit', () => {
    const t = new LagTracker()
    t.onConnectionOpen()
    t.onAudioSubmitted(10)
    // Five minutes muted: 100 fills of 20ms = 2s of synthetic audio.
    for (let i = 0; i < 100; i++) t.onSilenceSubmitted(0.02)
    t.onAcknowledged(12) // server counted our silence too
    expect(t.acknowledgedSeconds).toBeCloseTo(10)
    expect(t.instantLagSec).toBeCloseTo(0)

    // Real lag after the pause is still visible, not masked by the credit.
    t.onAudioSubmitted(5)
    expect(t.instantLagSec).toBeCloseTo(5)
  })

  it('clears the synthetic credit on a new connection', () => {
    const t = new LagTracker()
    t.onConnectionOpen()
    t.onSilenceSubmitted(2)
    t.onConnectionOpen()
    t.onAudioSubmitted(4)
    t.onAcknowledged(1)
    expect(t.instantLagSec).toBeCloseTo(3)
  })

  it('collapses lag to zero when resuming at the live edge', () => {
    const t = new LagTracker()
    t.onConnectionOpen()
    t.onAudioSubmitted(90)
    t.onAcknowledged(0)
    expect(t.instantLagSec).toBeCloseTo(90)
    t.resumeAtLiveEdge()
    expect(t.instantLagSec).toBe(0)
  })
})

describe('LagTracker.evaluate tiers', () => {
  it('is healthy under 2s', () => {
    const { tracker, connection } = steady(0.5)
    const at = run(connection, 10, () => 0.5)
    expect(tracker.evaluate(at).action).toBe('none')
  })

  it('warns between 2s and 5s', () => {
    const { tracker, connection } = steady(3)
    const at = run(connection, 10, () => 3)
    expect(tracker.evaluate(at).action).toBe('warn')
  })

  it('sheds between 5s and 15s', () => {
    const { tracker, connection } = steady(8)
    const at = run(connection, 10, () => 8)
    expect(tracker.evaluate(at).action).toBe('shed')
  })

  it('resets at or above 15s', () => {
    const { tracker, connection } = steady(20)
    const at = run(connection, 10, () => 20)
    const verdict = tracker.evaluate(at)
    expect(verdict.action).toBe('reset')
    expect(verdict.rising).toBe(false) // the VALUE tripped it, not the slope
  })

  it('acts on the median, not a single spike', () => {
    const { tracker, connection } = steady(0.4)
    const at = run(connection, 20, () => 0.4)
    // A single burst submission — one outlier sample among healthy readings.
    tracker.onAudioSubmitted(30)
    tracker.sample(at + 1000)
    const verdict = tracker.evaluate(at + 1000)
    expect(verdict.medianLagSec).toBeCloseTo(0.4)
    expect(verdict.action).toBe('none')
  })
})

describe('LagTracker rising-slope guard', () => {
  // The specific guard that would have caught the 90-second bug: lag climbing
  // steadily is a ratchet that never self-heals, and it trips long before the
  // absolute value looks alarming.
  it('trips on a monotonic rise even while the absolute lag is small', () => {
    const { tracker, connection } = steady(0)
    const at = run(connection, 40, (s) => s * 0.1) // 0 → 3.9s: never reaches 5s
    const verdict = tracker.evaluate(at)
    expect(verdict.medianLagSec).toBeLessThan(HEALTH_TUNING.shedLagSec)
    expect(verdict.rising).toBe(true)
    expect(verdict.action).toBe('reset')
  })

  it('does not trip on lag that is high but flat', () => {
    const { tracker, connection } = steady(3)
    const at = run(connection, 40, () => 3)
    expect(tracker.evaluate(at).rising).toBe(false)
  })

  it('does not trip on lag that rises then recovers', () => {
    const { tracker, connection } = steady(0)
    const at = run(connection, 40, (s) => (s < 20 ? s * 0.1 : Math.max(0.2, 4 - (s - 20) * 0.2)))
    expect(tracker.evaluate(at).rising).toBe(false)
  })

  it('needs a full window before judging a slope', () => {
    const { tracker, connection } = steady(0)
    const at = run(connection, 8, (s) => s * 0.5)
    expect(tracker.evaluate(at).rising).toBe(false)
  })

  it('forgets pre-reset history so it cannot immediately re-trip', () => {
    const { tracker, connection } = steady(0)
    const at = run(connection, 40, (s) => s * 0.1)
    expect(tracker.evaluate(at).action).toBe('reset')
    tracker.noteReset(at)
    tracker.resumeAtLiveEdge()
    expect(tracker.evaluate(at).rising).toBe(false)
  })
})

describe('LagTracker reset backoff — never permanently blocked (M22)', () => {
  /** Re-establish a 20s lag on a fresh connection, as a real reset would. */
  function sickAgain(tracker: LagTracker, fromMs: number): number {
    const connection = new FakeConnection(tracker).primeLag(20)
    return run(connection, 10, () => 20, fromMs)
  }

  // The live-call bug (found 2026-08, M22): the OLD implementation had a
  // hard `maxResetsPerWindow` cap — past 3 resets in 10 minutes, a
  // reset-worthy tick degraded to 'shed' UNCONDITIONALLY, with no further
  // reset possible until the window rolled over. 'shed' only trims the
  // local queue, which is a no-op once the queue is already near-empty (the
  // socket keeps accepting bytes fine; it's Deepgram's acknowledgement
  // that's behind) — so once a SUSTAINED deficit burned through the budget,
  // nothing bounded lag again for up to 10 minutes. Reproduced on a live
  // buyer-side call: lag grew linearly and unbounded past 47s with zero
  // recovery. Proven here: past 3 resets, spaced well outside every backoff
  // window, a reset-worthy tick STILL gets 'reset', not 'shed' forever.
  it('keeps allowing resets past the old 3-per-10-minute cap, spaced by backoff alone', () => {
    const tracker = new LagTracker()
    let at = 0
    // Six resets — twice the old cap — each one well outside the longest
    // backoff entry (8s), so only the (removed) hard budget could still be
    // blocking this.
    for (let i = 0; i < HEALTH_TUNING.maxResetsPerWindow * 2; i++) {
      at = sickAgain(tracker, at + 60_000)
      const verdict = tracker.evaluate(at)
      expect(verdict.action).toBe('reset')
      expect(verdict.suppressed).toBeUndefined()
      tracker.noteReset(at)
      tracker.resumeAtLiveEdge()
    }
    expect(tracker.resetCount).toBe(HEALTH_TUNING.maxResetsPerWindow * 2)
  })

  // The exact scenario from the live report: resets keep being NEEDED faster
  // than the backoff between them (a sustained deficit, not one-off blips).
  // The system should degrade to periodic, BOUNDED corrections — never a
  // single stall that never recovers.
  it('bounds lag to roughly one backoff window of growth, even under a sustained deficit', () => {
    const tracker = new LagTracker()
    let at = 0
    const observedLagsAtReset: number[] = []
    for (let i = 0; i < 8; i++) {
      at = sickAgain(tracker, at + 5_000) // sick again well within any backoff
      const verdict = tracker.evaluate(at)
      if (verdict.action === 'reset') {
        observedLagsAtReset.push(verdict.medianLagSec)
        tracker.noteReset(at)
        tracker.resumeAtLiveEdge()
      }
    }
    // The old bug produced lag climbing to 47+ seconds with zero corrections
    // after the 3rd. Here, resets keep happening — the tracker is never
    // stuck accumulating lag indefinitely.
    expect(observedLagsAtReset.length).toBeGreaterThan(HEALTH_TUNING.maxResetsPerWindow)
  })

  it('resetsInWindow reports the sustained-deficit signal the caller needs for M22 Phase 1b', () => {
    const tracker = new LagTracker()
    let at = 0
    for (let i = 0; i < HEALTH_TUNING.maxResetsPerWindow + 1; i++) {
      at = sickAgain(tracker, at + 60_000)
      tracker.noteReset(at)
      tracker.resumeAtLiveEdge()
    }
    expect(tracker.resetsInWindow(at)).toBe(HEALTH_TUNING.maxResetsPerWindow + 1)
    // Long after the window has rolled past, the old resets no longer count.
    expect(tracker.resetsInWindow(at + HEALTH_TUNING.resetWindowMs + 1000)).toBe(0)
  })

  it('holds off the immediate next reset with a backoff', () => {
    const tracker = new LagTracker()
    const at = sickAgain(tracker, 0)
    tracker.noteReset(at) // first reset: backoff 0
    tracker.resumeAtLiveEdge()

    const at2 = sickAgain(tracker, at + 1000)
    tracker.noteReset(at2) // second reset arms a 2s backoff
    tracker.resumeAtLiveEdge()

    // Sick again half a second later — well inside the 2s backoff. Sampled
    // once rather than driven for 10s, or the drive itself outlasts the backoff.
    const connection = new FakeConnection(tracker).primeLag(20)
    connection.tick(at2 + 500, 20)
    const verdict = tracker.evaluate(at2 + 500)
    expect(verdict.medianLagSec).toBeGreaterThanOrEqual(HEALTH_TUNING.resetLagSec)
    expect(verdict.action).not.toBe('reset')
    expect(verdict.suppressed).toBe('backoff')
  })
})
