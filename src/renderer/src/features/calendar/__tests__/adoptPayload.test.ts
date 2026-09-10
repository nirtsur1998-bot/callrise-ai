// M39 Stage 0 — the provider→local crossing, which had no test at all.
//
// Adoption is the ONLY moment a Google/Outlook invitee list can become a local
// record: a provider event otherwise lives in its own cache and never enters
// the local store. So this one payload is the whole supply of `attendees` to
// everything M39 builds on top of it, and until now the line that carries it
// could have been deleted with the entire suite still green.
//
// The null-vs-undefined rule below is older and has its own history: falling
// back to the source on a NULL would silently revert a Google event's notes
// being cleared. Both rules now live in a pure function that can be asserted.
import { describe, expect, it } from 'vitest'
import { adoptPayload } from '../useCalendar'
import type { CalendarEvent } from '../types'

const INVITEES = [{ email: 'sarah.chen@acme-example.com', name: 'Sarah Chen' }]

const googleEvent = {
  id: 'goog-1',
  title: 'Renewal call',
  start: '2026-09-10T10:00:00.000Z',
  end: '2026-09-10T10:30:00.000Z',
  allDay: false,
  source: 'google',
  provider: 'google:nir@example.com',
  externalId: 'goog-1',
  notes: 'Bring the pricing sheet',
  attendees: INVITEES
} as CalendarEvent

describe('M39 — an adoption carries the invitee list across', () => {
  it('sends attendees to main, so the local record can be born with them', () => {
    expect(adoptPayload(googleEvent, {}).attendees).toEqual(INVITEES)
  })

  it('sends them even when the edit touches something else entirely', () => {
    // The realistic case: the rep retitles a Google meeting. The adoption is a
    // side effect they never asked for, and it must not cost them the invitees.
    const payload = adoptPayload(googleEvent, { title: 'Renewal call — moved' })
    expect(payload.title).toBe('Renewal call — moved')
    expect(payload.attendees).toEqual(INVITEES)
  })

  it('sends nothing when the source event has none, rather than an empty list', () => {
    const solo = { ...googleEvent, attendees: undefined } as CalendarEvent
    expect(adoptPayload(solo, {}).attendees).toBeUndefined()
  })

  it('keeps the provider link, or the adoption would insert a DUPLICATE event', () => {
    const payload = adoptPayload(googleEvent, {})
    expect(payload.externalId).toBe('goog-1')
    expect(payload.provider).toBe('google:nir@example.com')
  })
})

describe('M39 — and the older absent-vs-null rule still holds', () => {
  it('falls back to the source only when a field is ABSENT', () => {
    expect(adoptPayload(googleEvent, {}).notes).toBe('Bring the pricing sheet')
  })

  it('lets an intentional null through — clearing notes must not be reverted', () => {
    expect(adoptPayload(googleEvent, { notes: null }).notes).toBeNull()
  })

  it('lets an intentional null through for the contact link too', () => {
    const linked = { ...googleEvent, contactId: 'contact-1' } as CalendarEvent
    expect(adoptPayload(linked, {}).contactId).toBe('contact-1')
    expect(adoptPayload(linked, { contactId: null }).contactId).toBeNull()
  })
})
