// M27 D — "Try again in about 3578s" is a number no human should be shown.
//
// It reached a real user in a real error message. The founder's reaction is
// the specification: raw seconds read as a machine talking to itself, and
// they hide the only fact that matters — whether to wait or go away and come
// back. 3578s is an hour; nobody does that conversion in their head.
import { describe, expect, it } from 'vitest'
import { humanWait } from '../complete-with-fallback'

describe('humanWait', () => {
  it('renders the reported case as an hour, not 3578 seconds', () => {
    // The exact number from the field report: the 1h period-exhausted
    // cooldown with ~22s already elapsed.
    expect(humanWait(3578 * 1000)).toBe('about an hour')
  })

  it('keeps seconds while seconds are still worth waiting through', () => {
    expect(humanWait(5_000)).toBe('about 5 seconds')
    expect(humanWait(45_000)).toBe('about 45 seconds')
  })

  it('switches to minutes once counting seconds stops being useful', () => {
    expect(humanWait(120_000)).toBe('about 2 minutes')
    expect(humanWait(600_000)).toBe('about 10 minutes')
  })

  it('handles the singular so it never says "1 minutes"', () => {
    expect(humanWait(92_000)).toBe('about 2 minutes')
    expect(humanWait(90_000)).toBe('about 2 minutes')
  })

  it('reads as hours for a long cooldown, and a day at the 24h cap', () => {
    expect(humanWait(4 * 60 * 60_000)).toBe('about 4 hours') // the structural-break cooldown
    expect(humanWait(24 * 60 * 60_000)).toBe('about a day') // the period-exhausted cap
  })

  it('never claims zero, negative, or ungrammatical time', () => {
    // A cooldown that expired between the check and the message must not
    // render as "about 0 seconds" (reads as broken) or "about 1 seconds"
    // (reads as unfinished). The first draft of this test asserted the
    // latter — documenting the wart instead of fixing it, in the very change
    // whose whole point was that machine-shaped text reaches real users.
    expect(humanWait(0)).toBe('a moment')
    expect(humanWait(-5_000)).toBe('a moment')
    expect(humanWait(1_000)).toBe('a moment')
    expect(humanWait(3_000)).toBe('about 3 seconds')
  })
})
