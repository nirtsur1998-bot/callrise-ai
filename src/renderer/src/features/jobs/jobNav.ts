import type { JobTargetKind } from '../../../../preload/index.d'

/**
 * "Take me to the thing that job was about."
 *
 * Founder-reported, 2026-08-29: *"I want the ability to click on the
 * notification after a background task worked — like coach this call or
 * summarise — and the app will take me back to that page in a click."*
 *
 * Every ingredient already existed and nothing connected them. `Job.targetRef`
 * has carried the call/contact/deal id since M26, with a docblock literally
 * saying "whatever the Activity Center should deep link to" — and the Activity
 * Center never read it. The completion toast's "View" button opened the
 * Activity panel, i.e. a list of the thing you had just been told about.
 *
 * Same single-listener shape as assistantNav.ts and liveCallNav.ts, and for
 * the same reason: MainApp owns `active`, but the Activity Center and the
 * toast host are mounted as SIBLINGS of MainApp (see App.tsx), so they cannot
 * receive its navigation callbacks as props. One module-level slot beats
 * threading a callback through every screen in between.
 *
 * A no-op when MainApp isn't mounted — never throws. That matters here more
 * than for the other two: toasts can fire during sign-in and onboarding, when
 * there is no main app to navigate.
 */
export interface JobNavRequest {
  kind: JobTargetKind
  id: string
}

let listener: ((request: JobNavRequest) => void) | null = null

/** Called once by MainApp in an effect. */
export function setJobNavListener(fn: ((request: JobNavRequest) => void) | null): void {
  listener = fn
}

/** Navigate to the record a finished job was about. */
export function openJobTarget(request: JobNavRequest): void {
  listener?.(request)
}

/** Whether a job can be opened at all — used to decide if a row renders as a
 *  button or as plain text. Both halves are required: a kind with no id (or an
 *  id with no kind) is not navigable, and rendering it as clickable would
 *  promise something the click cannot deliver. */
export function jobTarget(job: {
  targetRef?: string
  targetKind?: JobTargetKind
}): JobNavRequest | null {
  if (!job.targetRef || !job.targetKind) return null
  return { kind: job.targetKind, id: job.targetRef }
}
