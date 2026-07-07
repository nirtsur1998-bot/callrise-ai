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
  const base: Record<string, unknown> = {
    subject: ev.title,
    body: { contentType: 'text', content: ev.notes ?? '' }
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
