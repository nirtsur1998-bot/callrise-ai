import { describe, expect, it } from 'vitest'
import { findOverlappingAttendees, bestOneOnOneMatch, nameFromEmailLocalPart } from '../calendar-match'

const HOUR = 60 * 60 * 1000

type EventArg = Parameters<typeof findOverlappingAttendees>[1][number]

function event(overrides: Partial<EventArg> = {}): EventArg {
  return {
    title: 'Q3 renewal call',
    start: new Date(2026, 0, 15, 10, 0, 0).toISOString(),
    end: new Date(2026, 0, 15, 10, 30, 0).toISOString(),
    allDay: false,
    attendees: [{ email: 'sarah.chen@acme.com', name: 'Sarah Chen' }],
    ...overrides
  }
}

describe('findOverlappingAttendees', () => {
  it('matches a call that overlaps the event window', () => {
    const callStart = new Date(2026, 0, 15, 10, 2, 0).getTime()
    const matches = findOverlappingAttendees({ startedAtMs: callStart, durationMs: 20 * 60_000 }, [event()])
    expect(matches).toHaveLength(1)
    expect(matches[0].attendee.email).toBe('sarah.chen@acme.com')
    expect(matches[0].isOneOnOne).toBe(true)
  })

  it('does not match a call far outside the event window plus buffer', () => {
    const callStart = new Date(2026, 0, 15, 14, 0, 0).getTime() // 4h later
    const matches = findOverlappingAttendees({ startedAtMs: callStart, durationMs: 20 * 60_000 }, [event()])
    expect(matches).toHaveLength(0)
  })

  it('matches within the buffer even without literal time overlap', () => {
    // Call starts 10 minutes before the event's start — outside the event's
    // own window, but within the default 15-minute buffer.
    const callStart = new Date(2026, 0, 15, 9, 50, 0).getTime()
    const matches = findOverlappingAttendees({ startedAtMs: callStart, durationMs: 5 * 60_000 }, [event()])
    expect(matches).toHaveLength(1)
  })

  it('skips all-day events', () => {
    const callStart = new Date(2026, 0, 15, 10, 2, 0).getTime()
    const matches = findOverlappingAttendees(
      { startedAtMs: callStart, durationMs: 20 * 60_000 },
      [event({ allDay: true })]
    )
    expect(matches).toHaveLength(0)
  })

  it('skips events with no attendees', () => {
    const callStart = new Date(2026, 0, 15, 10, 2, 0).getTime()
    const matches = findOverlappingAttendees(
      { startedAtMs: callStart, durationMs: 20 * 60_000 },
      [event({ attendees: [] })]
    )
    expect(matches).toHaveLength(0)
  })

  it('flags a group meeting as not one-on-one', () => {
    const callStart = new Date(2026, 0, 15, 10, 2, 0).getTime()
    const matches = findOverlappingAttendees(
      { startedAtMs: callStart, durationMs: 20 * 60_000 },
      [
        event({
          attendees: [
            { email: 'sarah.chen@acme.com', name: 'Sarah Chen' },
            { email: 'bob@acme.com', name: 'Bob' }
          ]
        })
      ]
    )
    expect(matches.every((m) => !m.isOneOnOne)).toBe(true)
  })

  it('dedupes by email, keeping the closest event first', () => {
    const callStart = new Date(2026, 0, 15, 10, 2, 0).getTime()
    const closeEvent = event()
    const farEvent = event({
      start: new Date(2026, 0, 15, 10, 25, 0).toISOString(),
      end: new Date(2026, 0, 15, 10, 55, 0).toISOString()
    })
    const matches = findOverlappingAttendees(
      { startedAtMs: callStart, durationMs: 20 * 60_000 },
      [farEvent, closeEvent]
    )
    expect(matches).toHaveLength(1)
    expect(matches[0].eventStart).toBe(closeEvent.start)
  })

  it('returns nothing for a NaN call start', () => {
    const matches = findOverlappingAttendees({ startedAtMs: NaN, durationMs: 0 }, [event()])
    expect(matches).toEqual([])
  })
})

describe('bestOneOnOneMatch', () => {
  it('returns the 1:1 attendee', () => {
    const callStart = new Date(2026, 0, 15, 10, 2, 0).getTime()
    const match = bestOneOnOneMatch({ startedAtMs: callStart, durationMs: 20 * 60_000 }, [event()])
    expect(match?.attendee.name).toBe('Sarah Chen')
  })

  it('returns null for a group meeting — never guesses which attendee', () => {
    const callStart = new Date(2026, 0, 15, 10, 2, 0).getTime()
    const match = bestOneOnOneMatch(
      { startedAtMs: callStart, durationMs: 20 * 60_000 },
      [
        event({
          attendees: [
            { email: 'a@acme.com', name: 'A' },
            { email: 'b@acme.com', name: 'B' }
          ]
        })
      ]
    )
    expect(match).toBeNull()
  })

  it('returns null with no overlapping event at all', () => {
    const callStart = new Date(2026, 0, 15, 20, 0, 0).getTime()
    const match = bestOneOnOneMatch({ startedAtMs: callStart, durationMs: HOUR }, [event()])
    expect(match).toBeNull()
  })
})

describe('nameFromEmailLocalPart', () => {
  it('title-cases a dotted local part', () => {
    expect(nameFromEmailLocalPart('sarah.chen@acme.com')).toBe('Sarah Chen')
  })

  it('handles underscores and hyphens', () => {
    expect(nameFromEmailLocalPart('jane_doe@acme.com')).toBe('Jane Doe')
    expect(nameFromEmailLocalPart('john-smith@acme.com')).toBe('John Smith')
  })

  it('drops purely numeric parts (ids, not name parts)', () => {
    expect(nameFromEmailLocalPart('bob.12345@acme.com')).toBe('Bob')
  })

  it('returns undefined for an all-numeric local part', () => {
    expect(nameFromEmailLocalPart('12345@acme.com')).toBeUndefined()
  })

  it('handles a single-word local part', () => {
    expect(nameFromEmailLocalPart('sarah@acme.com')).toBe('Sarah')
  })
})
