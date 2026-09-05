// BUG-169 / BUG-112 — a calendar push that fails must be SEEN.
//
// The push path already records the outcome on the event (`sync.state` is
// 'dirty' for a retryable failure, 'error' otherwise, with a short `lastError`
// code). Nothing ever read it: the renderer's only mention of `sync` was the
// type declaration, and a comment in events.ts argued from a surface that was
// never built. So an event that 403s, hits a dead token, or takes a 500 sat in
// the CallRise calendar looking normal, absent from the rep's real calendar,
// with no reminder — and the rep found out by missing the meeting.
//
// Founder's shape (2026-09-05): surface it ON THE EVENT, ONCE in the Activity
// feed, with a MANUAL retry — never a silent auto-retry. This module is the
// pure part: the words for each failure code, and the once-only rule for the
// Activity row. The wiring lives in events.ts.
//
// The Activity row is a real job of type PUSH_FAILED_JOB_TYPE that FAILS on
// purpose with the reason as its error — that is the feed's own unit, so the
// row looks and behaves like every other failure there. It never pushes: the
// user's retry lives on the event (the dialog's Retry, `events:retryPush`).
// If the row's own Retry is pressed the job re-checks the event and succeeds
// only if the event has since been pushed; it does not push.

export const PUSH_FAILED_JOB_TYPE = 'calendar:push-failed'

/** Failure codes the two sync modules produce (google-sync.ts / outlook-sync.ts
 *  classifyPushError, google.ts / outlook.ts pre-flight). Anything else is an
 *  `http-NNN` code or unknown. The renderer keeps an identical map in
 *  features/calendar/syncFailure.ts — pinned by a lockstep test. */
export const SYNC_FAILURE_TEXT: Readonly<Record<string, string>> = {
  offline: 'you were offline when it was saved',
  auth: 'your sign-in to the calendar expired',
  forbidden: 'the calendar refused it — permission was removed on their side',
  'not-found': 'the calendar or the event no longer exists there',
  server: 'the calendar service had a problem',
  'not-enabled': 'calendar sync is switched off',
  'not-connected': 'no calendar account is connected'
}

export function describeSyncFailure(code: string | undefined, provider?: string): string {
  // The stored provider is 'outlook:<calendarId>' / 'google:<calendarId>',
  // not the bare kind — found by reading the founder's real event files.
  const where = provider?.startsWith('google')
    ? 'Google Calendar'
    : provider?.startsWith('outlook')
      ? 'Outlook'
      : 'your calendar'
  // No code at all: the push never ran to a verdict (the app closed, or the
  // edit is still queued) — say 'not yet', not 'refused'.
  if (!code) return `This event has not reached ${where} yet.`
  const known = SYNC_FAILURE_TEXT[code]
  if (known) return `Not on ${where}: ${known}.`
  const m = /^http-(\d+)$/.exec(code)
  if (m) return `Not on ${where}: the calendar service answered with error ${m[1]}.`
  return `Not on ${where}: ${code}.`
}

/** Once per event: a notice row exists already if a job of this type for the
 *  same event is still queued, running, or failed-and-not-retried. A row that
 *  succeeded (the event was pushed later) does not block a NEW failure's row. */
export function noticeAlreadyShown(
  jobs: readonly { type: string; state: string; input: unknown }[],
  eventId: string
): boolean {
  return jobs.some(
    (j) =>
      j.type === PUSH_FAILED_JOB_TYPE &&
      (j.state === 'queued' || j.state === 'running' || j.state === 'failed') &&
      !!j.input &&
      typeof j.input === 'object' &&
      (j.input as { eventId?: unknown }).eventId === eventId
  )
}

/** Which failed events the post-pull reconcile drain may push WITHOUT the
 *  user asking. Founder's rule: none of the failed PUSHES — a 'dirty' or
 *  'error' event waits for the user's Retry on the event (never a silent
 *  auto-retry). Only a pending DELETE drains: a deleted event has no dialog
 *  left to retry from, and an orphan left on the calendar forever is the
 *  worse harm. Anything else — synced, local-only, absent — is not work. */
export function shouldDrainOnReconcile(
  sync: { state?: string; lastError?: string } | undefined
): boolean {
  return sync?.state === 'deleted'
}

export interface PushFailedNoticeInput {
  eventId: string
  title: string
  code: string
  provider?: string
}
