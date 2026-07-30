// Cross-talk / echo detection (M19 Task 2, Part A) — the loudspeaker problem.
//
// Per-channel attribution (channel 0 = mic, channel 1 = buyer loopback) is
// only deterministic when the rep wears headphones. On speakers, the buyer's
// voice comes out of the speakers and back in through the mic, so channel 0
// (supposedly "just the rep") can carry real buyer speech too. Deepgram has
// no way to know this happened — it faithfully reports "channel 0" because
// that IS the channel the bytes arrived on; the acoustic leak happened
// upstream, in the room.
//
// What CAN catch it: real audio energy. If Deepgram attributes a stretch of
// speech to channel 0 while channel 1 was ALSO carrying strong energy at the
// exact same moment, that's the acoustic signature of leakage — not proof of
// who actually spoke, but a strong "don't fully trust this attribution"
// signal. This module answers exactly that question from real PCM energy,
// nothing more.
//
// Scope, honestly: Deepgram's `Results` messages in this app are parsed with
// a per-MESSAGE start/duration (see transcription.ts), not true per-word
// timestamps (Deepgram's word objects do carry their own start/end, but this
// pipeline doesn't thread them through yet) — so the window checked here is
// per-message, typically a short utterance, not a single word. A visible
// warning banner (transcription:crossTalkWarning) is what this drives today,
// not a per-word confidence tag on stored segments — that finer-grained
// wiring is a natural next step, not done in this pass. This mirrors the
// same honesty this codebase already applies to windows-capture.md's
// documented, deliberately-not-blind-coded gaps.

import { channelRms } from './channel-test'

export const CROSSTALK_TUNING = {
  /** How much history to keep, in ms. MUST stay comfortably above
   *  HEALTH_TUNING.shedLagSec (5s) and CONNECT_TIMEOUT_MS (8s): the window a
   *  Results message needs (transcription.ts's windowStartMs/windowEndMs) is
   *  reconstructed from the audio's REAL capture time, which trails "now" by
   *  roughly the current lag — so a ring buffer no wider than the lag the
   *  pipeline already tolerates as merely "warn" would have evicted that
   *  exact window before it's ever queried, silently collapsing every
   *  disagreesWithClaim() check to false (via the no-data branch) with no
   *  signal that detection went quiet. 15s matches resetLagSec — beyond that
   *  point the session gets torn down and reconnected anyway, so there's
   *  nothing further to protect. Cheap to keep this large: the buffer only
   *  holds per-frame RMS floats, not raw audio. */
  windowMs: 15_000,
  /** Below this RMS, a channel counts as silent for dominance purposes
   *  (matches queue.ts's silenceRms — the same "is this channel actually
   *  carrying anything" threshold used elsewhere in this pipeline). */
  silenceFloor: 0.01,
  /** channel A must be at least this many times louder than channel B to
   *  count as "dominant" rather than "ambiguous / both present". Comfortably
   *  above 1 so ordinary background noise on the quiet channel doesn't
   *  trigger a false warning. */
  dominanceRatio: 3
} as const

export interface CrossTalkSample {
  atMs: number
  /** Interleaved 16-bit PCM, 2 channels: [mic, buyer]. */
  bytes: ArrayBufferLike
}

export type DominanceVerdict =
  | { state: 'dominant'; channel: 0 | 1; micRms: number; buyerRms: number }
  | { state: 'ambiguous'; micRms: number; buyerRms: number }
  | { state: 'silent'; micRms: number; buyerRms: number }
  | { state: 'no-data' }

/** Pure decision: given average per-channel RMS over a window, which channel
 *  (if either) actually dominates. Separated from the ring buffer below so
 *  the decision logic is trivially unit-testable without synthesizing PCM. */
export function dominantChannel(
  micRms: number,
  buyerRms: number,
  tuning: { silenceFloor: number; dominanceRatio: number } = CROSSTALK_TUNING
): DominanceVerdict {
  const micSilent = micRms < tuning.silenceFloor
  const buyerSilent = buyerRms < tuning.silenceFloor
  if (micSilent && buyerSilent) return { state: 'silent', micRms, buyerRms }
  if (micSilent) return { state: 'dominant', channel: 1, micRms, buyerRms }
  if (buyerSilent) return { state: 'dominant', channel: 0, micRms, buyerRms }
  if (micRms >= buyerRms * tuning.dominanceRatio) return { state: 'dominant', channel: 0, micRms, buyerRms }
  if (buyerRms >= micRms * tuning.dominanceRatio) return { state: 'dominant', channel: 1, micRms, buyerRms }
  return { state: 'ambiguous', micRms, buyerRms }
}

interface Sample {
  atMs: number
  micRms: number
  buyerRms: number
}

/**
 * Rolling per-channel energy history for one multichannel session. Fed every
 * audio frame (ingestAudio() in transcription.ts); queried once per
 * multichannel Results message to check whether Deepgram's claimed channel
 * actually had the energy, or whether the other channel dominated instead
 * (the acoustic-leak signature).
 */
export class CrossTalkGate {
  private samples: Sample[] = []
  private readonly windowMs: number

  constructor(windowMs: number = CROSSTALK_TUNING.windowMs) {
    this.windowMs = windowMs
  }

  /** Feed one interleaved-stereo audio frame. */
  observe(sample: CrossTalkSample): void {
    const [micRms = 0, buyerRms = 0] = channelRms(sample.bytes, 2)
    this.samples.push({ atMs: sample.atMs, micRms, buyerRms })
    const cutoff = sample.atMs - this.windowMs
    // Samples arrive in increasing atMs order (real-time capture), so the
    // stale ones are always a prefix — an index scan beats filtering the
    // whole array every frame.
    let i = 0
    while (i < this.samples.length && this.samples[i].atMs < cutoff) i++
    if (i > 0) this.samples.splice(0, i)
  }

  /** Which channel actually dominated during [startMs, endMs] — the check
   *  run against Deepgram's claimed channel for a given Results message. */
  dominantChannelFor(startMs: number, endMs: number): DominanceVerdict {
    const inWindow = this.samples.filter((s) => s.atMs >= startMs && s.atMs <= endMs)
    if (inWindow.length === 0) return { state: 'no-data' }
    const micRms = inWindow.reduce((sum, s) => sum + s.micRms, 0) / inWindow.length
    const buyerRms = inWindow.reduce((sum, s) => sum + s.buyerRms, 0) / inWindow.length
    return dominantChannel(micRms, buyerRms)
  }

  /** Whether Deepgram's claimed channel disagrees with what the audio
   *  actually shows — the one question transcription.ts needs answered. */
  disagreesWithClaim(claimedChannel: 0 | 1, startMs: number, endMs: number): boolean {
    const verdict = this.dominantChannelFor(startMs, endMs)
    return verdict.state === 'dominant' && verdict.channel !== claimedChannel
  }

  reset(): void {
    this.samples = []
  }
}
