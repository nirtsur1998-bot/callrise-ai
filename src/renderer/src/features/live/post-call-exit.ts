import type { LiveStatus } from './types'

/**
 * BUG-152 — can the rep get off the Live screen?
 *
 * LiveView gates every full-screen state behind `if (!hasTranscript)`:
 *
 *     const hasTranscript = segments.length > 0
 *     if (!hasTranscript) {
 *       if (status === 'idle') return <IdleHero .../>
 *       if (status === 'no-device') return <CenteredState .../>
 *       ...
 *     }
 *
 * Preserving a finished call's transcript is deliberate and right. The defect
 * is that it also swallows every EXIT. Once a transcript exists, a call that
 * ends without the rep pressing Stop — the watchdog firing `onCaptureLost`
 * sets phase `'no-device'`, it does not save-and-navigate the way Stop does —
 * leaves the in-call layout on screen with one control: "Reconnect", which
 * starts a NEW call. There is no way back to the start screen, and the
 * founder's own words for it were "I can't get past it".
 *
 * Extracted as a pure function because this repo cannot test component render
 * output (BUG-140), so the decision has to live somewhere a test can reach.
 */

/** Statuses where the session is over and nothing is being captured. */
const TERMINAL: readonly LiveStatus[] = ['idle', 'no-device', 'error', 'denied', 'no-key']

export function isTerminalStatus(status: LiveStatus): boolean {
  return TERMINAL.includes(status)
}

/**
 * Should the Live screen offer an explicit "Done" exit?
 *
 * Only when the call is genuinely over AND there is a transcript on screen —
 * which is exactly the combination that falls through LiveView's
 * `if (!hasTranscript)` gate and lands in the in-call layout with no way out.
 *
 * With no transcript the full-screen states already render their own actions,
 * so adding a second exit there would be noise.
 */
export function shouldOfferPostCallExit(status: LiveStatus, hasTranscript: boolean): boolean {
  return hasTranscript && isTerminalStatus(status)
}
