import { describe, expect, it } from 'vitest'
import {
  HORIZON_MS,
  liveReminderKeys,
  planReminders,
  providerOwnsReminder,
  reminderNotification
} from '../event-reminders'
import type { CalendarEvent } from '../events-fs'

const NOW = new Date('2026-08-29T09:00:00Z').getTime()

function event(patch: Partial<CalendarEvent> = {}): CalendarEvent {
  const start = new Date(NOW + 60 * 60_000).toISOString() // one hour out
  return {
    id: 'e1',
    title: 'Discovery call',
    start,
    end: new Date(NOW + 90 * 60_000).toISOString(),
    allDay: false,
    source: 'local',
    reminderMinutes: [15],
    createdAt: start,
    updatedAt: start,
    ...patch
  }
}

describe('providerOwnsReminder — the never-double-notify rule', () => {
  it('is true only when sync is on AND the event is linked AND synced', () => {
    expect(
      providerOwnsReminder({ externalId: 'g1', sync: { state: 'synced' } }, true)
    ).toBe(true)
  })

  it('is false when two-way sync is off, even for a previously-synced event', () => {
    expect(
      providerOwnsReminder({ externalId: 'g1', sync: { state: 'synced' } }, false)
    ).toBe(false)
  })

  it('is false for a local-only event (nothing to remind from)', () => {
    expect(providerOwnsReminder({ sync: { state: 'local-only' } }, true)).toBe(false)
  })

  it('is false while a linked event is still dirty/pending — the push has not landed', () => {
    expect(providerOwnsReminder({ externalId: 'g1', sync: { state: 'dirty' } }, true)).toBe(false)
    expect(providerOwnsReminder({ externalId: 'g1', sync: { state: 'error' } }, true)).toBe(false)
  })
})

describe('planReminders', () => {
  it('arms a reminder that falls inside the horizon', () => {
    const plan = planReminders([event()], NOW, false)
    expect(plan).toHaveLength(1)
    expect(plan[0].minutes).toBe(15)
    expect(plan[0].fireAt).toBe(NOW + 45 * 60_000) // 1h out, 15m before
  })

  it('stays silent when the provider owns the reminder', () => {
    const synced = event({ externalId: 'g1', sync: { state: 'synced' } })
    expect(planReminders([synced], NOW, true)).toHaveLength(0)
    // ...but fires it once two-way sync is off, since nothing else will.
    expect(planReminders([synced], NOW, false)).toHaveLength(1)
  })

  it('skips events that already started', () => {
    const past = event({ start: new Date(NOW - 60_000).toISOString() })
    expect(planReminders([past], NOW, false)).toHaveLength(0)
  })

  it('skips a lead time whose moment has already passed', () => {
    // Event is 10 minutes out but asks for a 15-minute warning.
    const soon = event({ start: new Date(NOW + 10 * 60_000).toISOString() })
    expect(planReminders([soon], NOW, false)).toHaveLength(0)
  })

  it('skips all-day events (no meaningful minutes-before moment)', () => {
    expect(planReminders([event({ allDay: true })], NOW, false)).toHaveLength(0)
  })

  it('skips events with no reminders set', () => {
    expect(planReminders([event({ reminderMinutes: undefined })], NOW, false)).toHaveLength(0)
    expect(planReminders([event({ reminderMinutes: [] })], NOW, false)).toHaveLength(0)
  })

  it('defers reminders beyond the horizon rather than arming a multi-hour timer', () => {
    const farOut = event({
      start: new Date(NOW + HORIZON_MS + 60 * 60_000).toISOString(),
      reminderMinutes: [15]
    })
    expect(planReminders([farOut], NOW, false)).toHaveLength(0)
  })

  it('does not re-arm a reminder already delivered', () => {
    const ev = event()
    const first = planReminders([ev], NOW, false)
    expect(first).toHaveLength(1)
    const second = planReminders([ev], NOW, false, new Set([first[0].key]))
    expect(second).toHaveLength(0)
  })

  it('re-arms after an event MOVES, because the key includes its start', () => {
    const original = event()
    const delivered = new Set(planReminders([original], NOW, false).map((p) => p.key))
    const moved = event({ start: new Date(NOW + 120 * 60_000).toISOString() })
    expect(planReminders([moved], NOW, false, delivered)).toHaveLength(1)
  })

  it('arms each lead time on a multi-reminder event independently', () => {
    const multi = event({
      start: new Date(NOW + 60 * 60_000).toISOString(),
      reminderMinutes: [10, 30]
    })
    const plan = planReminders([multi], NOW, false)
    expect(plan.map((p) => p.minutes).sort((a, b) => a - b)).toEqual([10, 30])
  })

  it('ignores an unparseable start date instead of throwing', () => {
    expect(planReminders([event({ start: 'not-a-date' })], NOW, false)).toHaveLength(0)
  })
})

describe('liveReminderKeys', () => {
  it('lists a key per event/lead-time pair, for pruning delivered state', () => {
    const ev = event({ reminderMinutes: [10, 30] })
    expect(liveReminderKeys([ev]).size).toBe(2)
  })

  it('omits events that no longer carry reminders, so their keys get forgotten', () => {
    expect(liveReminderKeys([event({ reminderMinutes: undefined })]).size).toBe(0)
  })
})

describe('reminderNotification', () => {
  it('describes the lead time in minutes under an hour', () => {
    expect(reminderNotification(event(), 15).body).toContain('Starts in 15m')
  })

  it('describes an hour-plus lead time in hours', () => {
    expect(reminderNotification(event(), 60).body).toContain('Starts in 1h')
  })

  it('falls back to a readable title for an untitled event', () => {
    expect(reminderNotification(event({ title: '' }), 15).title).toBe('Untitled event')
  })
})
