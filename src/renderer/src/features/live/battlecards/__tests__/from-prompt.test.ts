import { describe, expect, it } from 'vitest'
import { TRACKER_LIMITS, sanitizeGeneratedTrigger } from '../from-prompt'
import { BattlecardMatcher } from '../match'
import { STARTER_TRIGGERS } from '../library'

const GOOD = {
  label: 'Procurement',
  say: 'Ask how long their process takes and what starts it.',
  category: 'process',
  patterns: ['procurement', 'vendor onboarding', 'supplier review']
}

describe('sanitizeGeneratedTrigger', () => {
  it('accepts a well-formed tracker', () => {
    const r = sanitizeGeneratedTrigger(GOOD)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.trigger.card.label).toBe('Procurement')
      expect(r.trigger.patterns).toEqual(['procurement', 'vendor onboarding', 'supplier review'])
    }
  })

  // The generated trigger has to work in the real matcher, not merely satisfy
  // a shape check — otherwise the validation is theatre.
  it('produces a trigger the real matcher actually fires on', () => {
    const r = sanitizeGeneratedTrigger(GOOD)
    if (!r.ok) throw new Error(r.reason)
    const m = new BattlecardMatcher([r.trigger])
    expect(m.match('it has to go through procurement first', 0)).toHaveLength(1)
  })

  it('namespaces the id so a custom tracker can never shadow a starter card', () => {
    const r = sanitizeGeneratedTrigger({ ...GOOD, label: 'Budget' })
    if (!r.ok) throw new Error(r.reason)
    expect(r.trigger.id.startsWith('custom-')).toBe(true)
    expect(STARTER_TRIGGERS.some((t) => t.id === r.trigger.id)).toBe(false)
  })

  it('de-duplicates against ids that already exist', () => {
    const first = sanitizeGeneratedTrigger(GOOD)
    if (!first.ok) throw new Error(first.reason)
    const second = sanitizeGeneratedTrigger(GOOD, new Set([first.trigger.id]))
    if (!second.ok) throw new Error(second.reason)
    expect(second.trigger.id).not.toBe(first.trigger.id)
  })

  // Held to the SAME standard as the curated library: a custom card that fires
  // on every other sentence trains the rep to ignore the rail, and the curated
  // cards die with it.
  it('drops phrases too short to be specific', () => {
    const r = sanitizeGeneratedTrigger({ ...GOOD, patterns: ['it', 'a', 'procurement'] })
    if (!r.ok) throw new Error(r.reason)
    expect(r.trigger.patterns).toEqual(['procurement'])
  })

  it('refuses a tracker with no usable phrase at all', () => {
    const r = sanitizeGeneratedTrigger({ ...GOOD, patterns: ['a', 'of', 'it'] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('specific enough')
  })

  it('caps how many phrasings one tracker may claim', () => {
    const many = Array.from({ length: 30 }, (_, i) => `phrase number ${i}`)
    const r = sanitizeGeneratedTrigger({ ...GOOD, patterns: many })
    if (!r.ok) throw new Error(r.reason)
    expect(r.trigger.patterns).toHaveLength(TRACKER_LIMITS.maxPatterns)
  })

  it('de-duplicates and lowercases phrases', () => {
    const r = sanitizeGeneratedTrigger({ ...GOOD, patterns: ['Procurement', 'procurement'] })
    if (!r.ok) throw new Error(r.reason)
    expect(r.trigger.patterns).toEqual(['procurement'])
  })

  it('refuses text too long to read mid-call', () => {
    expect(sanitizeGeneratedTrigger({ ...GOOD, label: 'x'.repeat(40) }).ok).toBe(false)
    expect(sanitizeGeneratedTrigger({ ...GOOD, say: 'x'.repeat(200) }).ok).toBe(false)
  })

  it('refuses an unrecognised category rather than inventing one', () => {
    expect(sanitizeGeneratedTrigger({ ...GOOD, category: 'vibes' }).ok).toBe(false)
    expect(sanitizeGeneratedTrigger({ ...GOOD, category: undefined }).ok).toBe(false)
  })

  it('refuses a tracker missing its name or its advice', () => {
    expect(sanitizeGeneratedTrigger({ ...GOOD, label: '  ' }).ok).toBe(false)
    expect(sanitizeGeneratedTrigger({ ...GOOD, say: '' }).ok).toBe(false)
  })

  // Model output shaped by a user's free text is two layers of untrusted.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'procurement'],
    ['a number', 7],
    ['an array', []],
    ['an empty object', {}]
  ])('refuses %s rather than failing open', (_l, input) => {
    expect(sanitizeGeneratedTrigger(input).ok).toBe(false)
  })

  it('always explains the refusal', () => {
    const r = sanitizeGeneratedTrigger({})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(8)
  })
})
