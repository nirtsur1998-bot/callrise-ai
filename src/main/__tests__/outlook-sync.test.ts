import { describe, expect, it } from 'vitest'
import { toGraphBody } from '../outlook-sync'
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
  it('turns the reminder on and uses the SOONEST of several selected minutes', () => {
    // Graph carries only one reminderMinutesBeforeStart value, unlike
    // Google's array of overrides — pick the minimum so the user is never
    // reminded later than the earliest lead time they asked for.
    const body = toGraphBody(baseEvent({ reminderMinutes: [30, 10, 20] }))
    expect(body.isReminderOn).toBe(true)
    expect(body.reminderMinutesBeforeStart).toBe(10)
  })

  it('turns the reminder off when no minutes are selected', () => {
    const body = toGraphBody(baseEvent())
    expect(body.isReminderOn).toBe(false)
    expect(body.reminderMinutesBeforeStart).toBe(0)
  })
})
