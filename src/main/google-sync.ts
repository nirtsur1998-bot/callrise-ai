// Pure, network-free transforms for pushing local events OUT to Google Calendar
// (M14 two-way sync). Deliberately kept separate from google.ts — which needs
// Electron + OAuth and can't run under a plain Node test — so this logic is
// unit-testable in isolation (see the timezone round-trip proof).
import type { CalendarEvent } from './events-fs'

export type PushResult =
  | { ok: true; externalId: string; provider: string; remoteUpdatedAt?: string }
  | { ok: false; error: string; retryable: boolean }

export type DeleteResult = { ok: true } | { ok: false; error: string; retryable: boolean }

/** The identity of a linked event: the (provider, externalId) PAIR, JSON-encoded
 *  so it can't collide. The same Google event id can appear on two calendars, so
 *  keying on externalId alone would over-match — always use both. */
export function linkKey(provider: string, externalId: string): string {
  return JSON.stringify([provider, externalId])
}

/**
 * A Google-legal event id derived from the local id. A UUID minus its hyphens
 * is 32 lowercase hex chars — valid base32hex (Google allows a-v + 0-9, length
 * 5–1024). Being deterministic is the point: a retry after a crash reuses the
 * SAME id, so Google 409s ("already exists") instead of creating a duplicate.
 */
export function toGoogleEventId(localId: string): string {
  return localId.replace(/-/g, '').toLowerCase()
}

/** YYYY-MM-DD from a Date's LOCAL calendar parts. Never slice a UTC ISO string
 *  for this — that shifts all-day dates by a day in any timezone east of UTC. */
export function dateStrFromParts(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Build the Google event body from a local event. All-day dates are rebuilt
 * from LOCAL calendar parts (never a UTC string slice) so an all-day event
 * can't shift a day. Google's all-day `end.date` is EXCLUSIVE — the day AFTER
 * the stored (inclusive) end.
 */
export function toGoogleBody(ev: CalendarEvent): Record<string, unknown> {
  // Always sent explicitly (even empty) so a reminder removed in CallRise is
  // actually cleared on Google too, rather than leaving Google's own default
  // reminders in place from a prior PATCH that omitted this field.
  const reminders = {
    useDefault: false,
    overrides: (ev.reminderMinutes ?? []).map((minutes) => ({ method: 'popup', minutes }))
  }
  const base: Record<string, unknown> = {
    summary: ev.title,
    description: ev.notes ?? '',
    reminders
  }
  if (ev.allDay) {
    const s = new Date(ev.start)
    const e = new Date(ev.end)
    const startDate = dateStrFromParts(s)
    let endExclusive = new Date(e.getFullYear(), e.getMonth(), e.getDate() + 1)
    // End must be strictly after start (Google rejects an empty date range).
    if (dateStrFromParts(endExclusive) <= startDate) {
      endExclusive = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1)
    }
    return { ...base, start: { date: startDate }, end: { date: dateStrFromParts(endExclusive) } }
  }
  return { ...base, start: { dateTime: ev.start }, end: { dateTime: ev.end } }
}

/** The HTTP status from a google-auth-library GaxiosError, or null (no response
 *  = a network/offline error). */
export function httpStatus(e: unknown): number | null {
  const status = (e as { response?: { status?: number } })?.response?.status
  return typeof status === 'number' ? status : null
}

/** Map a push failure to a stable code + whether a later retry could succeed.
 *  (A 409 is handled by the caller as success, so it's not represented here.) */
export function classifyPushError(e: unknown): { ok: false; error: string; retryable: boolean } {
  const s = httpStatus(e)
  if (s === 401) return { ok: false, error: 'auth', retryable: true } // token expired → refresh & retry
  if (s === 403) return { ok: false, error: 'forbidden', retryable: false } // genuine permission denial
  if (s === 404 || s === 410) return { ok: false, error: 'not-found', retryable: false }
  if (s === 429 || (s !== null && s >= 500)) return { ok: false, error: 'server', retryable: true }
  if (s === null) return { ok: false, error: 'offline', retryable: true } // no HTTP response
  return { ok: false, error: `http-${s}`, retryable: false }
}
