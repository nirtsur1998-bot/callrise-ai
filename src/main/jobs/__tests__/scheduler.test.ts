import { describe, expect, it } from 'vitest'
import { isIdleDue, isRecurringDue } from '../scheduler'

describe('isRecurringDue', () => {
  it('is due immediately when it has never run', () => {
    expect(isRecurringDue(60_000, undefined, 0)).toBe(true)
  })

  it('is not due before its interval has elapsed', () => {
    expect(isRecurringDue(60_000, 1_000, 30_000)).toBe(false)
  })

  it('is due exactly at the interval boundary', () => {
    expect(isRecurringDue(60_000, 0, 60_000)).toBe(true)
  })

  it('is due well past the interval (e.g. the app was closed for days)', () => {
    expect(isRecurringDue(60_000, 0, 10 * 24 * 60 * 60_000)).toBe(true)
  })
})

describe('isIdleDue', () => {
  const spec = { idleThresholdSec: 300, minGapMs: 3_600_000 }

  it('is never due while the system is active', () => {
    expect(isIdleDue(spec, undefined, 0, 10)).toBe(false)
  })

  it('is due once idle long enough, on a first run', () => {
    expect(isIdleDue(spec, undefined, 0, 301)).toBe(true)
  })

  it('respects the minimum gap even while idle', () => {
    expect(isIdleDue(spec, 0, 1_800_000, 500)).toBe(false) // only 30 min since last run
  })

  it('fires again once both idle AND the gap have been satisfied', () => {
    expect(isIdleDue(spec, 0, 3_600_000, 500)).toBe(true)
  })

  it('exactly at the idle threshold counts as idle', () => {
    expect(isIdleDue(spec, undefined, 0, 300)).toBe(true)
  })
})
