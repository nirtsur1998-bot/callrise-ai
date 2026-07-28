// The bounded send queue and its shed policy (§1.3).
//
// Three decisions here are load-bearing, and two of them are counter-intuitive:
//
//  1. The bound is SECONDS OF AUDIO, not bytes. Bytes silently change meaning
//     when the channel count or sample rate does; seconds never do.
//
//  2. Overflow drops from the HEAD (oldest), not the tail. Dropping the newest
//     frame is the intuitive choice and it is wrong: it keeps the pipeline
//     permanently behind, transcribing stale audio forever. Dropping the oldest
//     costs you the words you already missed and returns you to the live edge.
//
//  3. Silence is evicted before speech. A backlog in a real sales call is
//     mostly gaps between turns, so an energy-gated eviction usually clears the
//     whole overflow without losing a single word.

import { HEALTH_TUNING } from './types'

export interface AudioFrame {
  bytes: ArrayBuffer
  /** Duration of this frame in seconds — the unit the queue is bounded in. */
  seconds: number
  /** Normalized RMS 0..1. Cheap VAD gate for silence-first eviction. */
  rms: number
}

export interface ShedSummary {
  /** Seconds removed without being sent. */
  droppedSec: number
  /** How many of the dropped frames were silence (i.e. cost no words). */
  silentFrames: number
  /** How many carried actual speech energy (i.e. cost words). */
  voicedFrames: number
}

const EMPTY_SHED: ShedSummary = { droppedSec: 0, silentFrames: 0, voicedFrames: 0 }

/**
 * Slack on every cap comparison. `bufferedSec` is a running sum of floats, so
 * ten 0.1s frames total 0.9999999999999999 and three total 0.30000000000000004
 * — without this, a queue sitting exactly AT its cap sheds a frame it did not
 * need to. A microsecond is far below any real frame (~40ms) and far above the
 * accumulated error, so it can only ever forgive rounding.
 */
const EPSILON_SEC = 1e-6

/**
 * Normalized RMS of interleaved 16-bit PCM. Runs per frame on the main process
 * (a ~2048-sample scan, microseconds) — cheap enough to do unconditionally,
 * and it is the same measurement §1.6's liveness probe and §3.4's Teams
 * auto-switch heuristic both need.
 */
export function frameRms(bytes: ArrayBuffer): number {
  // A frame whose length isn't a whole number of 16-bit samples is malformed;
  // scanning the truncated view is still safe and still representative.
  const samples = new Int16Array(bytes, 0, Math.floor(bytes.byteLength / 2))
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] / 32768
    sum += v * v
  }
  return Math.sqrt(sum / samples.length)
}

export function isSilent(rms: number): boolean {
  return rms < HEALTH_TUNING.silenceRms
}

export class AudioQueue {
  private frames: AudioFrame[] = []
  private bufferedSec = 0
  private shedTotalSec = 0
  private readonly capSec: number

  constructor(capSec: number = HEALTH_TUNING.queueCapSec) {
    this.capSec = capSec
  }

  get queuedSeconds(): number {
    return this.bufferedSec
  }

  get length(): number {
    return this.frames.length
  }

  get shedSeconds(): number {
    return this.shedTotalSec
  }

  /** Enqueue a frame, shedding from the head if that puts us over the cap. */
  push(frame: AudioFrame): ShedSummary {
    this.frames.push(frame)
    this.bufferedSec += frame.seconds
    return this.enforceCap()
  }

  /** Oldest frame, or null when empty. */
  shift(): AudioFrame | null {
    const frame = this.frames.shift()
    if (!frame) return null
    this.bufferedSec = Math.max(0, this.bufferedSec - frame.seconds)
    return frame
  }

  peek(): AudioFrame | null {
    return this.frames[0] ?? null
  }

  /**
   * Bring the queue back under its cap: silence first (oldest silent frame
   * each pass), then oldest-overall once no silence is left.
   */
  private enforceCap(): ShedSummary {
    if (this.bufferedSec <= this.capSec + EPSILON_SEC) return EMPTY_SHED
    const summary: ShedSummary = { droppedSec: 0, silentFrames: 0, voicedFrames: 0 }
    while (this.bufferedSec > this.capSec + EPSILON_SEC && this.frames.length > 0) {
      let index = this.frames.findIndex((f) => isSilent(f.rms))
      // No silence to spare — fall back to the head. Never the tail.
      if (index === -1) index = 0
      const [dropped] = this.frames.splice(index, 1)
      this.bufferedSec = Math.max(0, this.bufferedSec - dropped.seconds)
      summary.droppedSec += dropped.seconds
      if (isSilent(dropped.rms)) summary.silentFrames++
      else summary.voicedFrames++
    }
    this.shedTotalSec += summary.droppedSec
    return summary
  }

  /**
   * Discard everything and report what was lost — used when resuming at the
   * live edge after a reset or a sleep.
   */
  clear(): ShedSummary {
    const summary: ShedSummary = { droppedSec: 0, silentFrames: 0, voicedFrames: 0 }
    for (const frame of this.frames) {
      summary.droppedSec += frame.seconds
      if (isSilent(frame.rms)) summary.silentFrames++
      else summary.voicedFrames++
    }
    this.frames = []
    this.bufferedSec = 0
    this.shedTotalSec += summary.droppedSec
    return summary
  }

  /**
   * Post-disconnect policy: replay only a small tail, discard the rest.
   *
   * Deepgram's own documentation recommends buffering audio while
   * disconnected. Followed literally, that recommendation IS the 90-second bug:
   * ingest is capped at 1.25x realtime, so a 30-second replay buffer arrives
   * 30 seconds behind and can only claw back 0.25x per second — six minutes of
   * perfect conditions to recover, assuming nothing else goes wrong.
   *
   * So: keep at most `replayCapSec` of the NEWEST audio (that tail is genuinely
   * useful — it is the word the buyer was mid-way through), drop everything
   * older, and let the caller emit a gap marker for what was dropped.
   */
  trimToReplayCap(capSec: number = HEALTH_TUNING.replayCapSec): ShedSummary {
    const summary: ShedSummary = { droppedSec: 0, silentFrames: 0, voicedFrames: 0 }
    while (this.bufferedSec > capSec + EPSILON_SEC && this.frames.length > 0) {
      const dropped = this.frames.shift()
      if (!dropped) break
      this.bufferedSec = Math.max(0, this.bufferedSec - dropped.seconds)
      summary.droppedSec += dropped.seconds
      if (isSilent(dropped.rms)) summary.silentFrames++
      else summary.voicedFrames++
    }
    this.shedTotalSec += summary.droppedSec
    return summary
  }
}

/** Seconds of audio in a linear16 frame. The one place this maths lives. */
export function frameSeconds(byteLength: number, channels: number, sampleRate: number): number {
  if (channels <= 0 || sampleRate <= 0) return 0
  return byteLength / 2 / channels / sampleRate
}
