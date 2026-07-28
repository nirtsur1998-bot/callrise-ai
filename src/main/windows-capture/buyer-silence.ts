// A zero-native-code mitigation for the Windows endpoint bug (see
// docs/windows-capture.md), shippable today while the native addon that fixes
// it properly stays blocked on repo write access for Windows CI.
//
// The bug (Correction 1): Windows keeps separate default render endpoints per
// role. The single most common headset setup — headset as Default
// Communication Device, speakers as Default Device — makes those two
// different physical devices. VoIP calls render to the communications
// endpoint; our current capture (system-wide `getDisplayMedia` loopback, the
// path actually shipped today, not the unbuilt per-process addon) follows
// whichever endpoint Chromium treats as "the system audio", which in that
// setup is the wrong one. The rep hears the call through their headset; we
// capture the speakers, which are correctly, silently, playing nothing.
//
// A native fix means enumerating both endpoints and mixing them — real work,
// genuinely blocked right now. But the SYMPTOM needs no native code at all:
// the mic channel carries real speech (the rep is on a call) while the buyer
// channel is bit-exact digital silence for the whole call. That is not a
// quiet prospect — nobody sits through a sales call in total silence — it is
// the specific, nameable shape of this specific bug. Turning that shape into
// one sentence and a Settings deep-link converts an unexplainable "the buyer
// side isn't working" into a one-step fix, today, on every existing install.

import { channelRms } from '../session-health/channel-test'
import { isSilent } from '../session-health/queue'

export const BUYER_SILENCE_TUNING = {
  /**
   * How long the buyer channel must be silent, with the mic genuinely
   * talking, before this counts as the endpoint bug rather than a prospect
   * who hasn't said anything yet. Long enough that a normal quiet stretch (the
   * rep mid-pitch, prospect listening) can't trigger it; short enough that the
   * rep gets the fix before the call is over.
   */
  sustainedMs: 45_000,
  /**
   * Minimum fraction of frames in the window where the MIC was speaking.
   * Silence on both channels simultaneously is dead air, not a broken buyer
   * path — the tell is specifically "we hear one side and not the other".
   */
  minMicSpeechRatio: 0.15
} as const

export interface SilenceSample {
  atMs: number
  /** Interleaved PCM for this frame, 2 channels: [mic, buyer]. */
  bytes: ArrayBufferLike
}

export interface SilenceVerdict {
  /** True on the single sample where the warning should first be shown. */
  shouldWarn: boolean
  reason: string
}

/**
 * Watches a multichannel session for "mic live, buyer bit-silent" and flags
 * it once the shape is unambiguous.
 *
 * One-shot per call: once it has fired, it stays fired (see `reset`) rather
 * than re-firing every tick — the rep only needs to be told once, and a
 * banner that reappears every few seconds trains itself to be ignored.
 */
export class BuyerSilenceWatcher {
  private windowStartMs: number | null = null
  private micSpeechFrames = 0
  private totalFrames = 0
  private fired = false

  /** Feed one multichannel audio frame. Returns a verdict every call; only
   *  act on `shouldWarn`. */
  observe(sample: SilenceSample): SilenceVerdict {
    if (this.fired) {
      return { shouldWarn: false, reason: 'already warned this call' }
    }

    const [micRms = 0, buyerRms = 0] = channelRms(sample.bytes, 2)
    const buyerSilent = isSilent(buyerRms)
    const micSpeaking = !isSilent(micRms)

    if (!buyerSilent) {
      // Any real buyer audio at all proves the path works. Clear everything.
      this.windowStartMs = null
      this.micSpeechFrames = 0
      this.totalFrames = 0
      return { shouldWarn: false, reason: 'buyer channel has audio' }
    }

    if (this.windowStartMs === null) this.windowStartMs = sample.atMs
    this.totalFrames++
    if (micSpeaking) this.micSpeechFrames++

    const heldMs = sample.atMs - this.windowStartMs
    if (heldMs < BUYER_SILENCE_TUNING.sustainedMs) {
      return { shouldWarn: false, reason: `buyer silent for ${Math.round(heldMs)}ms — watching` }
    }

    const speechRatio = this.totalFrames === 0 ? 0 : this.micSpeechFrames / this.totalFrames
    if (speechRatio < BUYER_SILENCE_TUNING.minMicSpeechRatio) {
      // Both sides quiet this whole stretch — dead air, not a broken path.
      // Keep the window open rather than resetting it: the mic may start
      // speaking any moment and the buyer-silence clock genuinely has run
      // this long either way.
      return {
        shouldWarn: false,
        reason: `silent throughout (mic speech ratio ${speechRatio.toFixed(2)}) — not the bug`
      }
    }

    this.fired = true
    return {
      shouldWarn: true,
      reason:
        `buyer channel silent for ${Math.round(heldMs)}ms while the mic carried speech ` +
        `${Math.round(speechRatio * 100)}% of the time — looks like the Windows endpoint bug`
    }
  }

  /** A new call: the warning should be able to fire again. */
  reset(): void {
    this.windowStartMs = null
    this.micSpeechFrames = 0
    this.totalFrames = 0
    this.fired = false
  }
}
