import { describe, expect, it } from 'vitest'
import {
  toGraphBody,
  toOutlookClientToken,
  clientTokenProperty,
  clientTokenFilter
} from '../outlook-sync'
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

describe('toGraphBody reminders', () => {
  it('turns the reminder on and uses the SOONEST (earliest, largest lead time) of several selected minutes', () => {
    // Graph carries only one reminderMinutesBeforeStart value, unlike
    // Google's array of overrides. "Soonest" means most advance warning —
    // the LARGEST minutes-before-start value, since that one fires earliest
    // in real time. Bug (fixed): this used to take Math.min, which picks the
    // value that fires LATEST (closest to the event), the opposite of the
    // promise made in EventDialog.tsx's own copy ("the soonest picked is
    // used") and this function's own former comment.
    const body = toGraphBody(baseEvent({ reminderMinutes: [30, 10, 20] }))
    expect(body.isReminderOn).toBe(true)
    expect(body.reminderMinutesBeforeStart).toBe(30)
  })

  it('turns the reminder off when no minutes are selected', () => {
    const body = toGraphBody(baseEvent())
    expect(body.isReminderOn).toBe(false)
    expect(body.reminderMinutesBeforeStart).toBe(0)
  })
})

// BUG-025 — idempotent create for Outlook. Graph won't accept a client-
// supplied event id (unlike Google), so a retry after a 429/5xx/offline
// failure needs another way to recognize "a prior attempt already succeeded"
// instead of creating a duplicate event.
describe('Outlook idempotency token', () => {
  it('derives a deterministic, Graph-filter-safe token from the local id', () => {
    expect(toOutlookClientToken('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(
      'a1b2c3d4e5f67890abcdef1234567890'
    )
    // Same input, same token — a retry can find what an earlier attempt created.
    expect(toOutlookClientToken('evt-1')).toBe(toOutlookClientToken('evt-1'))
    // Different events never collide.
    expect(toOutlookClientToken('evt-1')).not.toBe(toOutlookClientToken('evt-2'))
  })

  it('builds the extended-property entry stamped onto a newly-created event', () => {
    const prop = clientTokenProperty('abc123')
    expect(prop.value).toBe('abc123')
    expect(prop.id).toContain('Name CallRiseClientToken')
  })

  it('builds a $filter that searches on the SAME property id used to stamp the token', () => {
    const prop = clientTokenProperty('abc123')
    const filter = clientTokenFilter('abc123')
    expect(filter).toContain(prop.id)
    expect(filter).toContain("ep/value eq 'abc123'")
  })
})
