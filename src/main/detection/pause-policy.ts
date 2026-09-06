// BUG-118 — pausing detection MID-CAPTURE must not orphan the capture.
//
// pauseDetection() used to call detector.stop() unconditionally: unsubscribe
// from the adapter, stop it, clear the poll timer. Fine from 'idle'. From
// 'capturing' it froze the FSM in place: no more ticks, so the detector never
// noticed the call end, never emitted `capture-ended`, and the mic + Deepgram
// session kept running until someone pressed Stop (or the 5-minute idle
// timer did). The "you closed the window" path already handled this; pause
// was never given the same check.
//
// The rule is one function so it can be tested without Electron: while a
// capture is live (or ending), a pause request is DEFERRED — the detector
// keeps ticking, new candidates are simply not offered, and the pause takes
// effect the moment the capture ends.
import type { DetectorState } from './types'

/** States in which stopping the detector would strand a live capture. */
export function shouldDeferPause(state: DetectorState['name']): boolean {
  return state === 'capturing' || state === 'capturing-with-pending' || state === 'ending'
}
