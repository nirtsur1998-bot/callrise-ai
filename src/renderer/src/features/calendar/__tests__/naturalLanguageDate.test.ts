import { describe, expect, it } from 'vitest'
import { parseEventText } from '../naturalLanguageDate'

// Saturday, so "friday" alone is ambiguous between last week and next week —
// exactly the case forwardDate:true exists to resolve correctly.
const REF = new Date('2026-08-29T09:00:00')

describe('parseEventText', () => {
  it('extracts an explicit date + time and the title around it', () => {
    const r = parseEventText('call Ben tuesday at 2pm', REF)
    expect(r.matched).toBe(true)
    expect(r.hadExplicitTime).toBe(true)
    expect(r.title).toBe('call Ben')
    expect(r.start.getDay()).toBe(2) // Tuesday
    expect(r.start.getHours()).toBe(14)
  })

  it('never resolves a bare weekday into the past (forwardDate)', () => {
    // REF is Saturday 2026-08-29; the most recent Friday is 2026-08-28, one
    // day BEFORE ref. A correct parse must land on 2026-09-04 instead.
    const r = parseEventText('sync with the team friday', REF)
    expect(r.start.getTime()).toBeGreaterThan(REF.getTime())
    expect(r.start.getDay()).toBe(5) // Friday
    expect(r.start.getDate()).toBe(4)
    expect(r.start.getMonth()).toBe(8) // September (0-indexed)
  })

  it('defaults to 9am and flags hadExplicitTime=false when no time is given', () => {
    const r = parseEventText('board meeting next monday', REF)
    expect(r.matched).toBe(true)
    expect(r.hadExplicitTime).toBe(false)
    expect(r.start.getHours()).toBe(9)
    expect(r.start.getMinutes()).toBe(0)
    expect(r.preview).toContain('defaults to 9 AM')
  })

  it('uses a parsed end time for an explicit range instead of the 30-min default', () => {
    const r = parseEventText('demo 2pm to 3pm friday', REF)
    expect(r.end.getHours()).toBe(15)
    expect(r.end.getTime() - r.start.getTime()).toBe(60 * 60 * 1000)
  })

  it('defaults to a 30-minute block when no end/duration is given', () => {
    const r = parseEventText('quick call tuesday at 2pm', REF)
    expect(r.end.getTime() - r.start.getTime()).toBe(30 * 60 * 1000)
  })

  it('falls back to now (rounded up) and keeps the whole text as the title when nothing parses', () => {
    const r = parseEventText('draft the Q3 proposal outline', REF)
    expect(r.matched).toBe(false)
    expect(r.title).toBe('draft the Q3 proposal outline')
    expect(r.start.getTime()).toBeGreaterThanOrEqual(REF.getTime())
    expect(r.start.getMinutes() % 30).toBe(0)
  })

  it('produces an empty title when the input is only a date/time phrase', () => {
    const r = parseEventText('tuesday at 2pm', REF)
    expect(r.title).toBe('')
  })

  it('extracts the title from both sides of a mid-sentence date phrase', () => {
    const r = parseEventText('call Ben tuesday at 2pm about the renewal', REF)
    expect(r.title).toBe('call Ben about the renewal')
  })
})
