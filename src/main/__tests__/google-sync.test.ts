import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyPushError,
  dateStrFromParts,
  httpStatus,
  linkKey,
  toGoogleBody,
  toGoogleEventId
} from '../google-sync'
import type { CalendarEvent } from '../events-fs'

function baseEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'evt-1',
    title: 'Demo call',
    start: '2026-03-10T15:00:00.000Z',
    end: '2026-03-10T16:00:00.000Z',
    allDay: false,
    source: 'local',
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    ...overrides
  }
}

describe('linkKey', () => {
  it('is stable for the same provider + externalId pair', () => {
    expect(linkKey('google:me@x.com', 'abc')).toBe(linkKey('google:me@x.com', 'abc'))
  })

  it('never collides the same externalId across two different providers', () => {
    // The same Google event id could in principle appear on two different
    // calendars — keying on externalId alone would over-match them together.
    expect(linkKey('google:a@x.com', 'evt-1')).not.toBe(linkKey('google:b@x.com', 'evt-1'))
  })

  it('never collides two different externalIds on the same provider', () => {
    expect(linkKey('google:a@x.com', 'evt-1')).not.toBe(linkKey('google:a@x.com', 'evt-2'))
  })
})

describe('toGoogleEventId', () => {
  it('strips hyphens and lowercases a UUID into valid base32hex', () => {
    const id = toGoogleEventId('550E8400-E29B-41D4-A716-446655440000')
    expect(id).toBe('550e8400e29b41d4a716446655440000')
    expect(id).toMatch(/^[a-v0-9]+$/) // Google's allowed alphabet
    expect(id.length).toBeGreaterThanOrEqual(5)
    expect(id.length).toBeLessThanOrEqual(1024)
  })

  it('is deterministic — the same local id always produces the same Google id', () => {
    // The whole point: a retry after a crash reuses the same id so Google 409s
    // instead of creating a duplicate event.
    const a = toGoogleEventId('abc-123-DEF')
    const b = toGoogleEventId('abc-123-DEF')
    expect(a).toBe(b)
  })
})

describe('dateStrFromParts', () => {
  it("reads the LOCAL calendar date, matching Date's own local getters", () => {
    const d = new Date(2026, 2, 5) // March 5, 2026, in whatever TZ the test runs
    expect(dateStrFromParts(d)).toBe('2026-03-05')
  })

  it('pads single-digit months and days', () => {
    const d = new Date(2026, 0, 9) // Jan 9
    expect(dateStrFromParts(d)).toBe('2026-01-09')
  })

  describe('never derives the date from a UTC slice', () => {
    const originalTZ = process.env.TZ

    afterEach(() => {
      process.env.TZ = originalTZ
    })

    it('does not shift a day in a timezone far east of UTC', () => {
      // 23:00 UTC on the 9th is already the 10th in UTC+14. Slicing
      // toISOString() would read the 9th; the local calendar date is the 10th.
      process.env.TZ = 'Pacific/Kiritimati' // UTC+14, no DST
      const d = new Date('2026-03-09T23:00:00.000Z')
      const localDay = d.getDate()
      const sliced = d.toISOString().slice(8, 10)
      // Sanity check that this timezone actually disagrees with a UTC slice —
      // otherwise the test would pass without proving anything.
      expect(String(localDay).padStart(2, '0')).not.toBe(sliced)
      expect(dateStrFromParts(d)).toBe(`2026-03-10`)
    })
  })
})

describe('toGoogleBody', () => {
  it('builds a timed event from dateTime, not date', () => {
    const body = toGoogleBody(baseEvent())
    expect(body).toMatchObject({
      summary: 'Demo call',
      start: { dateTime: '2026-03-10T15:00:00.000Z' },
      end: { dateTime: '2026-03-10T16:00:00.000Z' }
    })
  })

  it('defaults a missing notes field to an empty description rather than undefined', () => {
    const body = toGoogleBody(baseEvent())
    expect(body.description).toBe('')
  })

  it('builds a single-day all-day event with an EXCLUSIVE end one day after start', () => {
    const ev = baseEvent({
      allDay: true,
      start: '2026-03-10T00:00:00.000Z',
      end: '2026-03-10T00:00:00.000Z'
    })
    const body = toGoogleBody(ev) as { start: { date: string }; end: { date: string } }
    expect(body.start.date).toBe('2026-03-10')
    expect(body.end.date).toBe('2026-03-11') // day AFTER the inclusive end
  })

  it('builds a multi-day all-day event spanning the stored inclusive range', () => {
    const ev = baseEvent({
      allDay: true,
      start: '2026-03-10T00:00:00.000Z',
      end: '2026-03-12T00:00:00.000Z' // inclusive: 10th, 11th, 12th
    })
    const body = toGoogleBody(ev) as { start: { date: string }; end: { date: string } }
    expect(body.start.date).toBe('2026-03-10')
    expect(body.end.date).toBe('2026-03-13') // exclusive: the day after the 12th
  })

  it('never produces an empty or inverted date range even if start/end collapse', () => {
    // Google rejects an empty range; a malformed same-instant all-day event
    // must still round-trip to a valid one-day span rather than erroring.
    const ev = baseEvent({
      allDay: true,
      start: '2026-03-10T00:00:00.000Z',
      end: '2026-03-09T00:00:00.000Z' // end before start — shouldn't happen, but don't crash
    })
    const body = toGoogleBody(ev) as { start: { date: string }; end: { date: string } }
    expect(body.end.date > body.start.date).toBe(true)
  })
})

describe('toGoogleBody reminders', () => {
  it('sends useDefault:false with popup overrides for each selected minute', () => {
    const body = toGoogleBody(baseEvent({ reminderMinutes: [10, 30] })) as {
      reminders: { useDefault: boolean; overrides: { method: string; minutes: number }[] }
    }
    expect(body.reminders).toEqual({
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 10 },
        { method: 'popup', minutes: 30 }
      ]
    })
  })

  it('still sends an explicit empty overrides list when no reminders are set', () => {
    // Must be explicit (not omitted) so a PATCH actually clears reminders
    // previously set, rather than leaving Google's prior value in place.
    const body = toGoogleBody(baseEvent()) as { reminders: { useDefault: boolean; overrides: unknown[] } }
    expect(body.reminders).toEqual({ useDefault: false, overrides: [] })
  })
})

describe('httpStatus', () => {
  it('extracts the status from a GaxiosError-shaped response', () => {
    expect(httpStatus({ response: { status: 404 } })).toBe(404)
  })

  it('returns null when there is no response (offline/network error)', () => {
    expect(httpStatus({})).toBeNull()
    expect(httpStatus(new Error('network fail'))).toBeNull()
    expect(httpStatus(null)).toBeNull()
  })
})

describe('classifyPushError', () => {
  it('maps 401 to a retryable auth error (token refresh path)', () => {
    expect(classifyPushError({ response: { status: 401 } })).toEqual({
      ok: false,
      error: 'auth',
      retryable: true
    })
  })

  it('maps 403 to a non-retryable permission denial', () => {
    expect(classifyPushError({ response: { status: 403 } })).toEqual({
      ok: false,
      error: 'forbidden',
      retryable: false
    })
  })

  it('maps 404 and 410 to non-retryable not-found', () => {
    expect(classifyPushError({ response: { status: 404 } }).error).toBe('not-found')
    expect(classifyPushError({ response: { status: 410 } }).error).toBe('not-found')
    expect(classifyPushError({ response: { status: 404 } }).retryable).toBe(false)
  })

  it('maps 429 and 5xx to a retryable server error', () => {
    expect(classifyPushError({ response: { status: 429 } })).toEqual({
      ok: false,
      error: 'server',
      retryable: true
    })
    expect(classifyPushError({ response: { status: 503 } })).toEqual({
      ok: false,
      error: 'server',
      retryable: true
    })
  })

  it('maps no response at all to a retryable offline error', () => {
    expect(classifyPushError({})).toEqual({ ok: false, error: 'offline', retryable: true })
  })

  it('falls back to a labeled, non-retryable error for an unmapped status', () => {
    expect(classifyPushError({ response: { status: 418 } })).toEqual({
      ok: false,
      error: 'http-418',
      retryable: false
    })
  })
})
