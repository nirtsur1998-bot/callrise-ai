// Per-channel self-test (§5.1, acceptance criterion 6).
//
// Buyer capture interleaves two mono sources into one stereo stream — mic on
// channel 0, the other party on channel 1 — and everything downstream trusts
// that layout absolutely: "channel 1 said it" is how the app knows the BUYER
// said it. Get the interleaving backwards and nothing errors. The transcript
// simply attributes every one of the rep's own words to the prospect, the
// coaching scorecard grades the wrong person, and the only symptom is that the
// output is quietly, confidently wrong.
//
// So it is checked rather than assumed: put a known tone on one channel and
// silence on the other, run it through the real interleaver, and measure the
// energy that comes out of each. A miswired channel shows up as energy in the
// wrong place, which is unmissable — where a miswired channel in production
// shows up as a coaching report nobody can explain.

/** Per-channel RMS of interleaved 16-bit PCM, normalised 0..1. */
export function channelRms(interleaved: ArrayBufferLike, channels: number): number[] {
  if (channels <= 0) return []
  const samples = new Int16Array(interleaved, 0, Math.floor(interleaved.byteLength / 2))
  const sums = new Array<number>(channels).fill(0)
  const counts = new Array<number>(channels).fill(0)
  for (let i = 0; i < samples.length; i++) {
    const ch = i % channels
    const v = samples[i] / 32768
    sums[ch] += v * v
    counts[ch] += 1
  }
  return sums.map((sum, ch) => (counts[ch] === 0 ? 0 : Math.sqrt(sum / counts[ch])))
}

/**
 * A sine tone as mono 16-bit PCM. Used as the known input for the self-test —
 * a tone rather than noise so a spectrum check could be added later without
 * changing the generator.
 */
export function tone(hz: number, ms: number, sampleRate: number, amplitude = 0.5): Int16Array {
  const frames = Math.max(0, Math.round((ms / 1000) * sampleRate))
  const out = new Int16Array(frames)
  for (let i = 0; i < frames; i++) {
    out[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / sampleRate) * amplitude * 32767)
  }
  return out
}

/** Interleave mono channels into one frame-interleaved buffer. */
export function interleave(channelsData: Int16Array[]): ArrayBufferLike {
  const channels = channelsData.length
  if (channels === 0) return new ArrayBuffer(0)
  const frames = Math.min(...channelsData.map((c) => c.length))
  const out = new Int16Array(frames * channels)
  for (let f = 0; f < frames; f++) {
    for (let ch = 0; ch < channels; ch++) out[f * channels + ch] = channelsData[ch][f]
  }
  return out.buffer
}

export interface ChannelTestResult {
  pass: boolean
  /** Measured RMS per channel, in channel order. */
  rms: number[]
  /** Human-readable outcome for the diagnose report. */
  detail: string
}

/** Energy below this counts as silence; above it, as signal. Comfortably
 *  clear of both a real tone (~0.35 RMS at 0.5 amplitude) and true zero. */
const SIGNAL_FLOOR = 0.05

/**
 * Drive a known tone through one channel at a time and confirm the energy
 * lands where it should.
 *
 * `render` is the real interleaver under test — the point is to exercise the
 * production path, not a copy of it that could agree with a bug.
 */
export function runChannelSelfTest(
  sampleRate: number,
  channels: number,
  render: (perChannel: Int16Array[]) => ArrayBufferLike = interleave
): ChannelTestResult {
  if (channels < 1) return { pass: false, rms: [], detail: 'no channels to test' }

  const problems: string[] = []
  const measured: number[] = []

  for (let target = 0; target < channels; target++) {
    // A different frequency per channel, so a future spectrum check can tell
    // which source it is hearing rather than only that it hears something.
    const signal = tone(440 + target * 220, 500, sampleRate)
    const silent = new Int16Array(signal.length)
    const perChannel = Array.from({ length: channels }, (_, ch) =>
      ch === target ? signal : silent
    )
    const rms = channelRms(render(perChannel), channels)
    measured[target] = rms[target] ?? 0

    if ((rms[target] ?? 0) < SIGNAL_FLOOR) {
      problems.push(`channel ${target} carried no signal when it should have`)
    }
    for (let other = 0; other < channels; other++) {
      if (other === target) continue
      if ((rms[other] ?? 0) >= SIGNAL_FLOOR) {
        problems.push(`channel ${target}'s tone leaked into channel ${other}`)
      }
    }
  }

  return {
    pass: problems.length === 0,
    rms: measured,
    detail: problems.length === 0 ? 'every channel carried its own tone' : problems.join('; ')
  }
}
