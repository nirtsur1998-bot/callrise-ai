// Drift meter (§1.5).
//
// Drift and lag are the same bug wearing two hats: a pipeline that "handles"
// drift by buffering has converted a sync problem into a latency problem, and
// the latency problem is the one users report. So drift is measured here as a
// first-class number rather than absorbed silently.
//
// The measurement: for each frame record (monotonicMs, cumulativeSamples), fit
// a least-squares slope over a 60s window, and express it against the nominal
// rate in parts per million.
//
//   ppm = (slope / nominalSamplesPerMs − 1) × 1e6
//
// A healthy consumer-grade clock sits inside roughly ±100ppm. A number far
// outside that means the device's real rate is not the rate we told Deepgram,
// and every second of audio is being mis-timed by a fixed proportion.
//
// -----------------------------------------------------------------------------
// SCOPE NOTE — what is deliberately NOT here.
//
// §1.5 also specifies an adaptive PI resampler that slaves the mic clock to the
// loopback clock. That is not applicable to this pipeline as built, and adding
// it would make things worse rather than better:
//
// The mic and the loopback are attached to ONE AudioContext via a
// ChannelMergerNode (recorder.ts). Chromium already resamples each
// MediaStreamAudioSourceNode into the context's clock domain and runs its own
// drift compensation to do it. The two channels are therefore sample-aligned
// by construction before any code here ever sees them — which is precisely why
// the original design chose a single context.
//
// A second PI controller layered on top would be two controllers fighting over
// the same error signal, which is a classic way to manufacture oscillation out
// of a system that was stable. Differential mic-vs-loopback drift also cannot
// be measured from this side: by the time the PCM reaches the main process,
// both sources have already been resampled onto the shared clock, so the
// differential is zero by definition no matter what the hardware is doing.
//
// What IS measurable and useful is the aggregate: the context clock against the
// sample rate we declared to Deepgram. That catches a genuinely misbehaving
// device, a sleep, and a hot-plug — the events that actually produce
// mis-timed transcripts — so that is what this meter reports.
// -----------------------------------------------------------------------------

export interface DriftReading {
  /** Parts-per-million deviation from the declared sample rate. */
  ppm: number
  /** Cumulative timing error in ms: audio-seconds delivered vs wall elapsed. */
  offsetMs: number
  /** Samples the fit is based on. Below ~10 the ppm figure is not meaningful. */
  points: number
}

/** A sudden discontinuity — not drift. Almost always a device event or sleep. */
export interface DriftJump {
  atMs: number
  deltaMs: number
}

const WINDOW_MS = 60_000
/** Beyond this, a single-frame discontinuity is an event, not accumulated drift. */
const JUMP_MS = 200
/**
 * The fit needs this much wall time behind it before its slope means anything.
 *
 * Frames are timed by ARRIVAL, and arrival only equals capture while audio is
 * flowing in real time. Any burst — a reconnect replay, a stalled thread
 * catching up — delivers seconds of audio across milliseconds, which is a
 * perfectly real measurement of arrival and a meaningless one about the clock.
 * Without this guard an integration run reported 25,062,197,486 ppm, which is
 * not a drifting clock, it is a burst.
 */
const MIN_FIT_MS = 5_000
/** Differential/aggregate offset beyond this is worth surfacing. */
export const DRIFT_ALERT_MS = 100

export class DriftMeter {
  private readonly sampleRate: number
  private readonly channels: number
  private points: Array<{ atMs: number; samples: number }> = []
  private cumulativeSamples = 0
  private lastOffsetMs: number | null = null
  private startMs: number | null = null

  constructor(sampleRate: number, channels: number) {
    this.sampleRate = sampleRate
    this.channels = channels
  }

  /**
   * Record a frame. Returns a jump when the cumulative timing error moved by
   * more than `JUMP_MS` since the previous frame — the caller should resync
   * rather than let a controller quietly absorb it.
   */
  onFrame(atMs: number, byteLength: number): DriftJump | null {
    const sampleFrames = byteLength / 2 / this.channels
    // A frame that ARRIVES at `atMs` contains audio captured up to that moment,
    // so the session's audio clock starts one frame duration earlier. Without
    // this the offset reads a constant one-frame-high on a perfect clock, and
    // a metric that is never zero when nothing is wrong is a metric nobody
    // trusts enough to act on.
    if (this.startMs === null) {
      this.startMs = atMs - (sampleFrames / this.sampleRate) * 1000
    }
    this.cumulativeSamples += sampleFrames
    this.points.push({ atMs, samples: this.cumulativeSamples })
    const cutoff = atMs - WINDOW_MS
    while (this.points.length > 0 && this.points[0].atMs < cutoff) this.points.shift()

    const elapsedMs = atMs - this.startMs
    const audioMs = (this.cumulativeSamples / this.sampleRate) * 1000
    const offsetMs = audioMs - elapsedMs
    const previous = this.lastOffsetMs
    this.lastOffsetMs = offsetMs
    if (previous !== null && Math.abs(offsetMs - previous) > JUMP_MS) {
      return { atMs, deltaMs: Math.round(offsetMs - previous) }
    }
    return null
  }

  /** Least-squares fit over the current window. */
  read(): DriftReading {
    const n = this.points.length
    const offsetMs = Math.round(this.lastOffsetMs ?? 0)
    if (n < 2) return { ppm: 0, offsetMs, points: n }
    // A window that spans no time can only produce a slope about delivery, not
    // about the clock. Report nothing rather than something spectacular.
    if (this.points[n - 1].atMs - this.points[0].atMs < MIN_FIT_MS) {
      return { ppm: 0, offsetMs, points: n }
    }

    let sumT = 0
    let sumS = 0
    for (const p of this.points) {
      sumT += p.atMs
      sumS += p.samples
    }
    const meanT = sumT / n
    const meanS = sumS / n
    let num = 0
    let den = 0
    for (const p of this.points) {
      const dt = p.atMs - meanT
      num += dt * (p.samples - meanS)
      den += dt * dt
    }
    if (den === 0) return { ppm: 0, offsetMs, points: n }

    const slope = num / den // samples per ms
    const nominal = this.sampleRate / 1000
    return { ppm: Math.round((slope / nominal - 1) * 1e6), offsetMs, points: n }
  }

  /** After a resync, forget the history — it describes a different clock.
   *  The next frame re-anchors the origin, so no timestamp is needed here. */
  resync(): void {
    this.points = []
    this.cumulativeSamples = 0
    this.lastOffsetMs = null
    // Re-anchored by the next frame, so the same one-frame correction applies.
    this.startMs = null
  }
}
