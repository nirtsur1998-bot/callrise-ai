// M27 Tier 1 — "Test my microphone": record a few seconds, play it back, and
// (when the engine can run) play the DENOISED take beside it, so a user can
// hear what noise cancellation actually does before a real call depends on it.
//
// This file is the PURE half — buffer accumulation and the decision logic —
// exported for direct unit testing. The Web Audio orchestration (getUserMedia,
// MediaRecorder, AudioBuffer playback) lives in useMicTest.ts and is
// deliberately thin: everything in it that could be WRONG is decided here.

import type { Tier1Status } from '@renderer/features/live/audio/tier1-types'

/** Test length. Long enough to say a sentence over background noise, short
 *  enough that nobody hesitates to press the button. */
export const MIC_TEST_SECONDS = 5

/**
 * Accumulates Float32 PCM frames up to a hard cap, dropping the NEWEST once
 * full (unlike the live ring, which drops oldest: a test take must keep its
 * beginning — "the first thing I said is missing" reads as broken, while a
 * take that simply ends at the cap reads as complete).
 */
export class PcmAccumulator {
  private chunks: Float32Array[] = []
  private total = 0
  droppedSamples = 0

  constructor(private readonly maxSamples: number) {}

  push(frame: Float32Array): void {
    const room = this.maxSamples - this.total
    if (room <= 0) {
      this.droppedSamples += frame.length
      return
    }
    const take = frame.length <= room ? frame : frame.subarray(0, room)
    this.chunks.push(take)
    this.total += take.length
    if (take.length < frame.length) this.droppedSamples += frame.length - take.length
  }

  get sampleCount(): number {
    return this.total
  }

  seconds(sampleRate: number): number {
    return sampleRate > 0 ? this.total / sampleRate : 0
  }

  /** One contiguous buffer, in arrival order. */
  merged(): Float32Array {
    const out = new Float32Array(this.total)
    let pos = 0
    for (const c of this.chunks) {
      out.set(c, pos)
      pos += c.length
    }
    return out
  }
}

export type DenoisedHalfPlan =
  /** Start the engine for the test, capture, and STOP it after. */
  | { run: true; startEngine: true }
  /** Engine already running (a live call owns it): capture the frames that
   *  are already flowing, and DO NOT stop it after — stopping would kill
   *  the call's denoiser mid-sentence. */
  | { run: true; startEngine: false }
  | { run: false; reason: 'engine-unavailable' | 'mic-not-eligible' }

/**
 * Whether — and how — the denoised half of the test can run.
 *
 * THE RULE WITH STAKES: never stop an engine this test did not start. The
 * main process's start() is already a no-op when the engine runs, so the
 * asymmetry lives entirely in who calls stop() — a test that "cleaned up"
 * an engine a live call was using would cut that call's denoising
 * mid-sentence. `startEngine` in the returned plan is therefore also the
 * "may stop it afterwards" bit; the two are one decision on purpose.
 */
export function planDenoisedHalf(
  status: Tier1Status | null,
  resolvedMicName: string | null
): DenoisedHalfPlan {
  if (!status?.engineAvailable) return { run: false, reason: 'engine-unavailable' }
  if (!resolvedMicName) return { run: false, reason: 'mic-not-eligible' }
  return status.engineRunning ? { run: true, startEngine: false } : { run: true, startEngine: true }
}

/**
 * Whether the denoised capture produced enough audio to honestly play back
 * as "this is what cleaning sounds like". Below half a second there is
 * nothing meaningful to compare — and SAYING the engine produced nothing is
 * itself the diagnostic (it is exactly the passthrough/failed-spawn shape),
 * far better than playing a blip and letting the user conclude the feature
 * barely works.
 */
export function denoisedTakeUsable(accumulated: PcmAccumulator, sampleRate: number): boolean {
  return accumulated.seconds(sampleRate) >= 0.5
}
