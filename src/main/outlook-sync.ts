// Pure, network-free transforms for pushing local events OUT to Microsoft
// Graph (Outlook Calendar). Mirrors google-sync.ts's role: kept separate from
// outlook.ts (which needs Electron + MSAL) so this logic is unit-testable in
// isolation.
import type { CalendarEvent } from './events-fs'
import { dateStrFromParts } from './google-sync'

export type { PushResult, DeleteResult } from './google-sync'
export { linkKey } from './google-sync'

/**
 * Build the Graph event body from a local event. Graph's all-day convention
 * matches Google's: `end.dateTime` is midnight of the day AFTER the last
 * (inclusive) day, so all-day dates are rebuilt from LOCAL calendar parts —
 * never a UTC string slice, which would shift the day in any timezone east
 * of UTC.
 */
export function toGraphBody(ev: CalendarEvent): Record<string, unknown> {
  // Graph only carries ONE reminder value (unlike Google's array of
  // overrides) — use the soonest (earliest, most-advance-warning) requested
  // lead time so the user is never reminded later than they asked for.
  // "Soonest" here means minutes-BEFORE-start, which is inversely related to
  // real time: a LARGER minutes value fires EARLIER (BUG-025/reminder fix —
  // this used to take the minimum, which picks the value that fires closest
  // to the event, i.e. latest, the opposite of what "soonest" and this
  // file's own invariant promise).
  const minutes = ev.reminderMinutes ?? []
  const reminderMinutesBeforeStart = minutes.length ? Math.max(...minutes) : 0
  const base: Record<string, unknown> = {
    subject: ev.title,
    body: { contentType: 'text', content: ev.notes ?? '' },
    isReminderOn: minutes.length > 0,
    reminderMinutesBeforeStart
  }
  if (ev.allDay) {
    const s = new Date(ev.start)
    const e = new Date(ev.end)
    const startDate = dateStrFromParts(s)
    let endExclusive = new Date(e.getFullYear(), e.getMonth(), e.getDate() + 1)
    if (dateStrFromParts(endExclusive) <= startDate) {
      endExclusive = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1)
    }
    return {
      ...base,
      isAllDay: true,
      start: { dateTime: `${startDate}T00:00:00`, timeZone: 'UTC' },
      end: { dateTime: `${dateStrFromParts(endExclusive)}T00:00:00`, timeZone: 'UTC' }
    }
  }
  return {
    ...base,
    isAllDay: false,
    start: { dateTime: ev.start, timeZone: 'UTC' },
    end: { dateTime: ev.end, timeZone: 'UTC' }
  }
}

/**
 * BUG-025 — idempotent create for Outlook, which (unlike Google) doesn't
 * accept a client-supplied event id. A deterministic token stamped as a
 * Graph "single value extended property" lets a retry after ANY retryable
 * push failure (429/5xx/offline — not just a crash, which is what the
 * original design assumed) detect a prior attempt that actually succeeded
 * server-side, instead of blindly creating a second event. Mirrors Google's
 * "POST with a deterministic id, treat 409 as success" pattern the only way
 * Graph allows: search first, by this token, since Graph won't reject a
 * second create with a client-side conflict signal the way Google does.
 */
const CLIENT_TOKEN_PROPERTY_ID = 'String {66f5a359-4659-4830-9070-00047ec6ac6e} Name CallRiseClientToken'

/** A Graph-safe token derived from the local id — same trick as
 *  toGoogleEventId (hex-only, no characters that need OData escaping). */
export function toOutlookClientToken(localId: string): string {
  return localId.replace(/-/g, '').toLowerCase()
}

/** The extended-property entry to stamp onto a newly-created event. */
export function clientTokenProperty(token: string): { id: string; value: string } {
  return { id: CLIENT_TOKEN_PROPERTY_ID, value: token }
}

/** The $filter value to find an event previously created with this token. */
export function clientTokenFilter(token: string): string {
  return `singleValueExtendedProperties/Any(ep: ep/id eq '${CLIENT_TOKEN_PROPERTY_ID}' and ep/value eq '${token}')`
}

/** Thrown by outlook.ts's graphFetch on any non-2xx Graph response. */
export class GraphHttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function httpStatus(e: unknown): number | null {
  return e instanceof GraphHttpError ? e.status : null
}

/** Map a push failure to a stable code + whether a later retry could succeed.
 *  Mirrors google-sync.ts's classifyPushError; Graph's status codes carry the
 *  same meaning (401 expired token, 403 permission denial, 404/410 gone,
 *  429/5xx transient). */
export function classifyPushError(e: unknown): { ok: false; error: string; retryable: boolean } {
  const s = httpStatus(e)
  if (s === 401) return { ok: false, error: 'auth', retryable: true }
  if (s === 403) return { ok: false, error: 'forbidden', retryable: false }
  if (s === 404 || s === 410) return { ok: false, error: 'not-found', retryable: false }
  if (s === 429 || (s !== null && s >= 500)) return { ok: false, error: 'server', retryable: true }
  if (s === null) return { ok: false, error: 'offline', retryable: true }
  return { ok: false, error: `http-${s}`, retryable: false }
}
