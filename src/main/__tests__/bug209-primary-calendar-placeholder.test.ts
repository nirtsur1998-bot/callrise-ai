// BUG-209 — the user's Google account address stopped leaving the device.
//
// `provider` on a Google event is `google:<calendarId>`, and for an event on
// the user's own calendar that id IS their account address. `eventPayload`
// deleted only `payload.sync`, so the address was upserted into Supabase on
// every event row, every cycle, in the core push that has no toggle — under a
// Backup card reading "Your Google Calendar connection — stays only on this
// device".
//
// WHY A PLACEHOLDER AND NOT A STRIP. Both halves of the sync depend on the
// FULL provider string and both say so in their own comments: `linkKey` keys on
// the (provider, externalId) PAIR because "the same Google event id can appear
// on two calendars", and google.ts stamps the concrete id rather than the
// `primary` alias so "their (provider, externalId) match key equals what the
// pull produces, and the dedup drops the echoed copy instead of showing it
// twice". A bare `google` collapses both — the event would show twice on a
// fresh device and an edit would patch the wrong calendar.
//
// SO THE TEST THAT MATTERS IS THE ROUND TRIP, not the substitution: what leaves
// carries no address, and what arrives is byte-identical to what left home.
import { describe, expect, it, beforeEach } from 'vitest'
import {
  PRIMARY_CALENDAR_PLACEHOLDER,
  scrubProviderForEgress,
  resolveProviderFromEgress,
  setPrimaryCalendarId,
  getPrimaryCalendarId,
  linkKey
} from '../google-sync'

const ADDRESS = 'dana.whitfield@example.com'
const OWN = `google:${ADDRESS}`
const GROUP = 'google:c_9a3f7b21@group.calendar.google.com'
const OUTLOOK =
  'outlook:AQMkADAwATNiZmYAZS9kNzBiLTYxNzAtMDACLTAwCgBGAAADULAGkbAaa9OWJWMEaa9TaaaALPaa'

beforeEach(() => setPrimaryCalendarId(null))

describe('BUG-209 — what leaves the device', () => {
  it('replaces the account address, and ONLY the account address', () => {
    setPrimaryCalendarId(ADDRESS)
    expect(scrubProviderForEgress(OWN)).toBe(PRIMARY_CALENDAR_PLACEHOLDER)
    expect(scrubProviderForEgress(OWN)).not.toContain(ADDRESS)
  })

  it('leaves a NON-primary Google calendar alone even though it contains an @', () => {
    // Measured on real data: `…@group.calendar.google.com` has an `@` and is
    // not the user's identity. A rule that scrubbed "anything with an @" would
    // break these for no benefit.
    setPrimaryCalendarId(ADDRESS)
    expect(scrubProviderForEgress(GROUP)).toBe(GROUP)
  })

  it('leaves Outlook alone', () => {
    // Measured: Outlook providers are opaque 144-char calendar ids, 0 of 2
    // containing an @ or an email pattern.
    setPrimaryCalendarId(ADDRESS)
    expect(scrubProviderForEgress(OUTLOOK)).toBe(OUTLOOK)
  })

  it('changes NOTHING when the primary id is unknown', () => {
    // Fails toward a working sync. Guessing which calendar ids are addresses is
    // how the dedupe gets broken silently.
    expect(getPrimaryCalendarId()).toBeNull()
    expect(scrubProviderForEgress(OWN)).toBe(OWN)
  })

  it('passes an absent provider through as absent', () => {
    setPrimaryCalendarId(ADDRESS)
    expect(scrubProviderForEgress(undefined)).toBeUndefined()
  })
})

describe('BUG-209 — what arrives, and the dedupe that depends on it', () => {
  it('ROUND TRIPS: what the importer writes equals what the device had', () => {
    setPrimaryCalendarId(ADDRESS)
    const wire = scrubProviderForEgress(OWN)
    expect(wire).not.toContain(ADDRESS) // nothing identifying on the wire
    expect(resolveProviderFromEgress(wire)).toBe(OWN) // and nothing lost on the way in
  })

  it('keeps linkKey matching what a PULL produces — the whole reason for the round trip', () => {
    // A pull always carries the concrete id. If the restored record carried the
    // placeholder instead, its key would differ and the pulled copy would NOT
    // dedupe — the event shows twice, which is exactly what google.ts's comment
    // says the concrete id exists to prevent.
    setPrimaryCalendarId(ADDRESS)
    const restored = resolveProviderFromEgress(scrubProviderForEgress(OWN))!
    const fromPull = OWN
    expect(linkKey(restored, 'evt-1')).toBe(linkKey(fromPull, 'evt-1'))
  })

  it('does NOT invent an id when Google is not connected — the placeholder survives', () => {
    // Bounded and self-healing: better a key that differs until the next
    // resolve than a fabricated address written onto a local record.
    expect(resolveProviderFromEgress(PRIMARY_CALENDAR_PLACEHOLDER)).toBe(
      PRIMARY_CALENDAR_PLACEHOLDER
    )
  })

  it('leaves every other provider untouched on the way in', () => {
    setPrimaryCalendarId(ADDRESS)
    expect(resolveProviderFromEgress(GROUP)).toBe(GROUP)
    expect(resolveProviderFromEgress(OUTLOOK)).toBe(OUTLOOK)
    expect(resolveProviderFromEgress(undefined)).toBeUndefined()
  })

  it('still distinguishes two calendars, which is what keying on the PAIR is for', () => {
    setPrimaryCalendarId(ADDRESS)
    const own = resolveProviderFromEgress(scrubProviderForEgress(OWN))!
    expect(linkKey(own, 'same-event-id')).not.toBe(linkKey(GROUP, 'same-event-id'))
  })
})

describe('BUG-209 — the cache is not allowed to outlive the connection', () => {
  it('clears to null, and a cleared cache scrubs nothing', () => {
    setPrimaryCalendarId(ADDRESS)
    expect(scrubProviderForEgress(OWN)).toBe(PRIMARY_CALENDAR_PLACEHOLDER)
    setPrimaryCalendarId(null) // what disconnectGoogle does
    expect(scrubProviderForEgress(OWN)).toBe(OWN)
  })
})
