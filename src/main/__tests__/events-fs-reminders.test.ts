import { describe, expect, it } from 'vitest'
import { sanitizeReminderMinutes } from '../events-fs'

describe('sanitizeReminderMinutes', () => {
  it('keeps only values from the allowed set, sorted ascending', () => {
    expect(sanitizeReminderMinutes([30, 5, 20])).toEqual([5, 20, 30])
  })

  it('drops values outside the allowed set (e.g. hand-edited file, future UI value)', () => {
    expect(sanitizeReminderMinutes([5, 7, 90, 30])).toEqual([5, 30])
  })

  it('dedupes repeated values', () => {
    expect(sanitizeReminderMinutes([10, 10, 10])).toEqual([10])
  })

  it('returns undefined for a non-array input', () => {
    expect(sanitizeReminderMinutes('10')).toBeUndefined()
    expect(sanitizeReminderMinutes(undefined)).toBeUndefined()
    expect(sanitizeReminderMinutes(null)).toBeUndefined()
  })

  it('returns undefined (not an empty array) when nothing survives filtering', () => {
    expect(sanitizeReminderMinutes([])).toBeUndefined()
    expect(sanitizeReminderMinutes([999])).toBeUndefined()
  })
})
