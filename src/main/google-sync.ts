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

// ── BUG-209 — the account address stops leaving the device ──────────────────
//
// A Google event's `provider` is `google:<calendarId>`, and for an event on the
// user's own calendar that id IS their Google account address. `eventPayload`
// deleted only `payload.sync`, so the address was upserted into Supabase on
// every event row, every sync cycle, in the push that has no toggle — while the
// Backup card said "Your Google Calendar connection — stays only on this
// device". The credential did. The identity did not.
//
// WHY A PLACEHOLDER AND NOT A STRIP, which was the first proposal. The full
// provider string is load-bearing in two places, and both say so themselves:
//   • `linkKey` above keys on the PAIR because "the same Google event id can
//     appear on two calendars, so keying on externalId alone would over-match".
//   • google.ts stamps the concrete id rather than the `primary` alias "so
//     their (provider, externalId) match key equals what the pull produces, and
//     the dedup drops the echoed copy instead of showing it twice".
// A bare `google` would collapse both. So the address is replaced by a token
// that is resolved back on the way in, leaving the local record carrying the
// concrete id exactly as before.
//
// SCOPE, narrowed by measurement rather than assumed (see BUG-209):
//   • Outlook providers are opaque 144-char calendar ids — no address. Untouched.
//   • A NON-primary Google calendar is `…@group.calendar.google.com`: it has an
//     `@` but is not the user's identity. Untouched.
//   • `externalId` is a UUID-derived or opaque event id, and `iCalUID` — the
//     field that does carry a domain — is never stored anywhere in src/.
// Exactly one value leaks, and this replaces exactly that one.
export const PRIMARY_CALENDAR_PLACEHOLDER = 'google:@primary'

/**
 * This device's own primary calendar id, cached by google.ts after the one API
 * call that learns it. Held HERE rather than in google.ts so the two readers
 * (the backup payload, the restore importer) do not have to depend on the whole
 * Google client module to ask one question.
 */
let cachedPrimaryCalendarId: string | null = null

export function setPrimaryCalendarId(id: string | null): void {
  cachedPrimaryCalendarId = id
}

export function getPrimaryCalendarId(): string | null {
  return cachedPrimaryCalendarId
}

/**
 * Outbound: replace the account address with the placeholder. Pure, so the
 * decision is testable without a Google client.
 *
 * Returns the provider UNCHANGED whenever it cannot be sure — an unknown
 * primary id, a different provider, a non-primary calendar. Failing toward
 * "unchanged" keeps a working sync working; the alternative is guessing which
 * calendar ids are addresses, which is how a dedupe gets broken silently.
 */
export function scrubProviderForEgress(
  provider: string | undefined,
  primaryId: string | null = getPrimaryCalendarId()
): string | undefined {
  if (!provider || !primaryId) return provider
  return provider === `google:${primaryId}` ? PRIMARY_CALENDAR_PLACEHOLDER : provider
}

/**
 * Inbound: resolve the placeholder back to THIS device's primary calendar id.
 *
 * It is the user's own backup, so the same account resolves to the same
 * address — which is what makes `linkKey` match the value a pull produces and
 * the dedupe keep working.
 *
 * If the id is not known yet (Google not connected at import time) the
 * placeholder is LEFT IN PLACE rather than guessed at. That is a bounded,
 * self-healing failure: `calendarIdFromProvider` maps the placeholder to
 * Google's own `primary` alias, so pushes still reach the right calendar, and
 * only the dedupe key differs until the next resolve. It fails toward a working
 * sync rather than toward duplicate events.
 */
export function resolveProviderFromEgress(
  provider: string | undefined,
  primaryId: string | null = getPrimaryCalendarId()
): string | undefined {
  if (provider !== PRIMARY_CALENDAR_PLACEHOLDER) return provider
  return primaryId ? `google:${primaryId}` : provider
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
