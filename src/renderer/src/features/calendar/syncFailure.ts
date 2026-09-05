// BUG-169 — the renderer's view of a failed calendar push.
//
// A SECOND, INDEPENDENT copy of main's SYNC_FAILURE_TEXT (main/events-sync-
// failure.ts) — the renderer cannot import main. Pinned by
// `syncFailure.lockstep.test.ts`, which reads both files as text and fails if
// the code lists diverge; the same discipline as the deal-stage unions.
import type { CalendarEvent } from './types'

export const SYNC_FAILURE_TEXT: Readonly<Record<string, string>> = {
  offline: 'you were offline when it was saved',
  auth: 'your sign-in to the calendar expired',
  forbidden: 'the calendar refused it — permission was removed on their side',
  'not-found': 'the calendar or the event no longer exists there',
  server: 'the calendar service had a problem',
  'not-enabled': 'calendar sync is switched off',
  'not-connected': 'no calendar account is connected'
}

export interface SyncFailure {
  /** The short code the push recorded (`offline`, `auth`, `http-500`, …). */
  code?: string
  /** One sentence a rep can act on. */
  reason: string
  /** 'dirty' = the push path called it retryable; 'error' = it did not. Both
   *  are retried only by the user — never silently (founder's rule). */
  state: 'dirty' | 'error'
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

/** The failure an event carries, or null when it is synced, local-only, or
 *  not ours to push. Absent → nothing rendered; never a placeholder. */
export function syncFailureOf(event: Pick<CalendarEvent, 'sync' | 'provider'> | undefined): SyncFailure | null {
  const s = event?.sync
  if (!s) return null
  if (s.state !== 'dirty' && s.state !== 'error') return null
  return { code: s.lastError, reason: describeSyncFailure(s.lastError, event?.provider), state: s.state }
}

/** The dialog's informational line for an orphaned event — not a warning, no
 *  Retry: there is nothing to retry into. Mirrors main's orphanNote. */
export function orphanNoteOf(event: { orphaned?: { provider: string; at: string } } | null | undefined): string | null {
  const o = event?.orphaned
  if (!o) return null
  const where = o.provider.startsWith('google') ? 'Google Calendar' : o.provider.startsWith('outlook') ? 'Outlook' : 'your calendar'
  return `Kept here only: the ${where} calendar it was on no longer exists (since ${o.at.slice(0, 10)}).`
}
