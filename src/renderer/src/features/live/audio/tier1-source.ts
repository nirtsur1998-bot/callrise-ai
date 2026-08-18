// M27 Tier 1 — the renderer half of driver-free noise cancellation.
//
// Everything here is pure and directly testable ON PURPOSE. The Web Audio
// parts (AudioWorkletNode, graph edges) live in recorder.ts where they can
// only be exercised through a real AudioContext; the two things that can
// actually be WRONG — whether we should use the pipe at all, and whether
// frames survive the jitter between a 100Hz pipe and a 128-sample render
// quantum — are lifted out to here so a unit test reaches them through the
// same door production does.

import type { Tier1Status } from './tier1-types'

/**
 * THE PASSTHROUGH GUARD. The single decision that says whether denoised audio
 * replaces the raw microphone.
 *
 * `connected` is NOT sufficient and that is the whole point of this function.
 * kern_bridge runs in PASSTHROUGH when its model fails to load: the pipe
 * connects, full-rate audio flows, every field reads healthy, and the audio is
 * unprocessed. Routing that to the call would be strictly WORSE than doing
 * nothing, because the raw microphone at least goes through Chromium's echo
 * cancellation, noise suppression and gain control, and the pipe bypasses all
 * three. So a passthrough pipe is not "denoising that didn't help" — it is a
 * downgrade we would be choosing deliberately.
 *
 * `denoisingActive === true` is therefore required, not merely preferred.
 * `null` (unknown: no status file, older engine, unreadable) is treated
 * exactly like `false`. An unverifiable claim of denoising is precisely what
 * this returns false for.
 */
export function shouldUseDenoisedSource(status: Tier1Status | null): boolean {
  if (!status) return false
  if (!status.engineRunning) return false
  if (!status.connected) return false
  return status.denoisingActive === true
}

/**
 * Why a user-visible state and not just a boolean: a feature that silently
 * does nothing is the failure mode this whole release exists to fix. Each
 * value below maps to something the UI can honestly say.
 */
export type Tier1UiState =
  /** No engine binary on this machine — the toggle should not be offered. */
  | 'unavailable'
  /** Available, user hasn't switched it on. */
  | 'off'
  /** Switched on, engine still coming up or pipe not connected yet. */
  | 'starting'
  /** Working. Audio genuinely being cleaned. */
  | 'active'
  /** Connected but NOT denoising — the model is missing or failed to load.
   *  A real error state with a real remedy, deliberately not folded into
   *  'starting' or 'off': silently degrading here is the exact bug. */
  | 'model-missing'

export function tier1UiState(status: Tier1Status | null, wanted: boolean): Tier1UiState {
  if (!status || !status.engineAvailable) return 'unavailable'
  if (!wanted) return 'off'
  if (!status.engineRunning || !status.connected) return 'starting'
  // Connected. Now the only question that matters is whether it is cleaning.
  if (status.denoisingActive === true) return 'active'
  if (status.denoisingActive === false) return 'model-missing'
  // null — connected but the engine never told us. Not claimed as active.
  return 'starting'
}

/**
 * A fixed-capacity Float32 ring between the pipe and the audio graph.
 *
 * WHY IT HAS TO EXIST. kern_bridge delivers 480-sample frames at ~100Hz over
 * IPC; the audio graph pulls 128 samples every render quantum on a different
 * clock that never aligns. Without a buffer, a pull that lands between two
 * IPC deliveries reads nothing and emits a gap — audible as a click ~100
 * times a second.
 *
 * WHY IT DROPS OLD AUDIO RATHER THAN GROWING. This sits in a live call. If
 * the graph ever consumes slower than the pipe delivers, an unbounded queue
 * converts a small timing error into steadily increasing LATENCY — the user
 * hears themselves further and further behind, and it never recovers because
 * nothing ever drains it. Dropping the oldest audio keeps latency bounded at
 * the ring's own size and costs a brief artifact instead of a call that
 * degrades permanently. Overflow is a real event, so it is COUNTED rather
 * than swallowed: a silent drop is indistinguishable from working.
 */
export class Tier1Ring {
  private buf: Float32Array
  private readPos = 0
  private writePos = 0
  private filled = 0
  /** Samples discarded because the graph fell behind. Diagnostics only —
   *  but a nonzero value is the difference between "sounds odd" and "we know
   *  why it sounds odd". */
  overflowSamples = 0
  /** Samples handed out that the pipe had not delivered (underrun). Emitted
   *  as silence, which is correct and must still be visible. */
  underrunSamples = 0

  constructor(capacity = 48000) {
    this.buf = new Float32Array(capacity)
  }

  get available(): number {
    return this.filled
  }

  push(frame: Float32Array): void {
    const cap = this.buf.length
    // A single frame larger than the whole ring can only be satisfied by its
    // tail; taking the head would play audio we are about to overwrite.
    if (frame.length >= cap) {
      this.buf.set(frame.subarray(frame.length - cap))
      this.readPos = 0
      this.writePos = 0
      this.filled = cap
      this.overflowSamples += frame.length - cap
      return
    }
    for (let i = 0; i < frame.length; i++) {
      this.buf[this.writePos] = frame[i] as number
      this.writePos = (this.writePos + 1) % cap
    }
    this.filled += frame.length
    if (this.filled > cap) {
      // Advance the reader past what we just overwrote, so it never serves
      // a mix of new and stale audio.
      const lost = this.filled - cap
      this.readPos = (this.readPos + lost) % cap
      this.overflowSamples += lost
      this.filled = cap
    }
  }

  /** Fills `out` completely, padding with silence on underrun. Always fills:
   *  handing back a short buffer would push the gap onto every caller. */
  pull(out: Float32Array): void {
    const cap = this.buf.length
    const n = Math.min(out.length, this.filled)
    for (let i = 0; i < n; i++) {
      out[i] = this.buf[this.readPos] as number
      this.readPos = (this.readPos + 1) % cap
    }
    if (n < out.length) {
      out.fill(0, n)
      this.underrunSamples += out.length - n
    }
    this.filled -= n
  }

  reset(): void {
    this.readPos = 0
    this.writePos = 0
    this.filled = 0
  }
}
