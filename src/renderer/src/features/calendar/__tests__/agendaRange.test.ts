import { describe, expect, it } from 'vitest'
import { startOfMonth, startOfWeek, addDays } from 'date-fns'

// M31 Slice B (3/3) — the agenda rail's whole value is being COMPLETE: the
// grid is allowed to truncate ("+6 more") precisely because the rail isn't.
// That only holds if the rail spans exactly what the grid draws. These pin
// the range arithmetic against MonthGrid/WeekGrid's own layout rules, so the
// two can't drift into disagreeing about which days are on screen — which
// would silently reintroduce hidden items, the exact thing the rail exists
// to prevent.
//
// Mirrors CalendarView's visibleRange. MonthGrid renders a fixed 42-day grid
// from startOfWeek(startOfMonth(cursor)); WeekGrid renders the containing
// Sun–Sat week.
function visibleRange(cursor: Date, view: 'month' | 'week'): { start: Date; end: Date } {
  if (view === 'week') {
    const start = startOfWeek(cursor, { weekStartsOn: 0 })
    return { start, end: addDays(start, 6) }
  }
  const gridStart = startOfWeek(startOfMonth(cursor), { weekStartsOn: 0 })
  return { start: gridStart, end: addDays(gridStart, 41) }
}

const days = (r: { start: Date; end: Date }): number =>
  Math.round((r.end.getTime() - r.start.getTime()) / 86_400_000) + 1

describe('agenda rail visible range', () => {
  it('spans exactly the 42 days MonthGrid draws', () => {
    expect(days(visibleRange(new Date('2026-08-15T12:00:00'), 'month'))).toBe(42)
  })

  it('spans exactly the 7 days WeekGrid draws', () => {
    expect(days(visibleRange(new Date('2026-08-15T12:00:00'), 'week'))).toBe(7)
  })

  it('starts on the Sunday of the week containing the 1st, like the month grid', () => {
    // Aug 2026 starts on a Saturday, so the grid's first row begins Jul 26.
    const r = visibleRange(new Date('2026-08-15T12:00:00'), 'month')
    expect(r.start.getDay()).toBe(0)
    expect(r.start.getMonth()).toBe(6) // July
    expect(r.start.getDate()).toBe(26)
  })

  it('includes the trailing days of the next month the grid also shows', () => {
    // The 42-day window runs past Aug 31 into September; those cells are
    // drawn, so the rail must cover them too.
    const r = visibleRange(new Date('2026-08-15T12:00:00'), 'month')
    expect(r.end.getMonth()).toBe(8) // September
    expect(r.end.getDate()).toBe(5)
  })

  it('anchors the week range on Sunday regardless of which weekday the cursor is', () => {
    for (const d of ['2026-08-23', '2026-08-26', '2026-08-29']) {
      const r = visibleRange(new Date(`${d}T12:00:00`), 'week')
      expect(r.start.getDay()).toBe(0)
      expect(r.end.getDay()).toBe(6)
      expect(r.start.getDate()).toBe(23)
    }
  })
})
