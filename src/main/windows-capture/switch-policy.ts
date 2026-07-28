// The Windows capture auto-switch heuristic (§3.4).
//
// Windows needs TWO capture paths, and neither one covers every case:
//
//   process loopback  — endpoint-agnostic, so it is immune to the
//                       "call plays to the headset, we recorded the speakers"
//                       problem. But it records SILENCE from Microsoft Teams,
//                       a documented and still-open Microsoft bug
//                       (Windows-classic-samples#414). Both INCLUDE and
//                       EXCLUDE tree modes fail; the root cause was never
//                       identified.
//
//   device loopback   — captures Teams correctly, but is tied to a specific
//                       render endpoint, which is where the whole
//                       wrong-endpoint class of bug comes from.
//
// Commercial vendors did not solve the choice automatically — StreamVox ships
// a manual "use only if Teams/Zoom is silent" toggle, which asks the user to
// diagnose an audio-stack bug. We can do better, because Windows will tell us
// the truth if we ask two questions at once:
//
//   "is the app producing sound?"     → IAudioMeterInformation peak, non-zero
//   "are we receiving any of it?"     → RMS of the PCM we actually got, zero
//
// Both true together is not a quiet meeting — it is a broken capture path, and
// it is the only signal that distinguishes the two. Note this is the same
// measurement as the liveness probe in session-health: audio arriving that is
// pure digital silence. There it is a symptom to surface; here it is a
// decision to act on.

import { isSilent } from '../session-health/queue'

export type CapturePath = 'process-loopback' | 'device-loopback'

export const SWITCH_TUNING = {
  /**
   * How long silence-with-a-live-meter must persist before switching. Long
   * enough that a momentary buffer hiccup can't trigger a path change, short
   * enough that the rep loses only the first couple of seconds of the call.
   */
  sustainedMs: 2_000,
  /**
   * Session peak above this counts as "the app is genuinely playing audio".
   * Deliberately just off the floor: Windows reports a real, small peak for
   * quiet speech, and requiring a loud peak would make the detector miss the
   * exact case it exists for.
   */
  livePeak: 0.005
} as const

export interface CaptureSample {
  /** Monotonic ms. */
  atMs: number
  /** Normalized RMS (0..1) of the PCM this path actually delivered. */
  rms: number
  /**
   * IAudioMeterInformation peak (0..1) for the render session we are trying to
   * capture. `null` when it could not be read — which is NOT evidence of
   * anything, and is treated as such.
   */
  sessionPeak: number | null
}

export interface SwitchVerdict {
  /** The path that should be in use after this sample. */
  path: CapturePath
  /** True on the single sample where the decision flips. */
  switched: boolean
  /** Human-readable justification, for the log line and --diagnose. */
  reason: string
}

/**
 * Watches one capture session and decides when the primary path has silently
 * failed.
 *
 * Deliberately one-way: once switched to device loopback we never switch back.
 * Device loopback captures everything process loopback does, so a return trip
 * buys nothing and risks oscillating between two paths mid-call — which would
 * be a far worse experience than the bug being worked around.
 */
export class CapturePathSupervisor {
  private path: CapturePath
  /** When the current run of silence-with-a-live-meter began. */
  private suspectSinceMs: number | null = null
  private switchedAtMs: number | null = null

  constructor(initial: CapturePath = 'process-loopback') {
    this.path = initial
  }

  get currentPath(): CapturePath {
    return this.path
  }

  /** When the switch happened, for the diagnose report. Null if it never did. */
  get switchedAt(): number | null {
    return this.switchedAtMs
  }

  observe(sample: CaptureSample): SwitchVerdict {
    // Device loopback is the terminal state — nothing it observes can move it.
    if (this.path === 'device-loopback') {
      return { path: this.path, switched: false, reason: 'already on device loopback' }
    }

    const receivingNothing = isSilent(sample.rms)
    const appIsPlaying = sample.sessionPeak !== null && sample.sessionPeak > SWITCH_TUNING.livePeak

    // Either question answered "no" clears the suspicion. A quiet app is not a
    // broken path, and audio we DID receive proves the path works.
    if (!receivingNothing || !appIsPlaying) {
      this.suspectSinceMs = null
      return {
        path: this.path,
        switched: false,
        reason: receivingNothing ? 'silent, but the app is not playing either' : 'capturing audio'
      }
    }

    if (this.suspectSinceMs === null) {
      this.suspectSinceMs = sample.atMs
      return { path: this.path, switched: false, reason: 'silence with a live meter — watching' }
    }

    const heldMs = sample.atMs - this.suspectSinceMs
    if (heldMs < SWITCH_TUNING.sustainedMs) {
      return {
        path: this.path,
        switched: false,
        reason: `silence with a live meter for ${Math.round(heldMs)}ms`
      }
    }

    this.path = 'device-loopback'
    this.switchedAtMs = sample.atMs
    this.suspectSinceMs = null
    return {
      path: this.path,
      switched: true,
      reason:
        `process loopback delivered silence for ${Math.round(heldMs)}ms while the render ` +
        `session peaked at ${sample.sessionPeak?.toFixed(3)} — switching to device loopback`
    }
  }

  /** A new call: start over on the primary path. */
  reset(initial: CapturePath = 'process-loopback'): void {
    this.path = initial
    this.suspectSinceMs = null
    this.switchedAtMs = null
  }
}
