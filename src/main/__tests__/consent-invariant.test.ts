// The consent invariant, including under "Always record the other party".
//
// The hard rule has not changed and must not: `recordOtherParty` is only ever
// true when `status === 'consented'`, recomputed in the main process on every
// save AND every read. Standing consent changes WHERE a consented record comes
// from (a setting, recorded as method 'pre-agreed') — never whether one is
// required.

import { describe, expect, it } from 'vitest'
import { sanitizeConsent, defaultConsent } from '../calls-fs'

describe('sanitizeConsent invariant', () => {
  it('defaults to the safe record: not asked, two-party, no buyer capture', () => {
    expect(defaultConsent()).toEqual({
      status: 'not-asked',
      jurisdiction: 'two-party',
      recordOtherParty: false
    })
  })

  it('keeps buyer capture on for a genuinely consented record', () => {
    const clean = sanitizeConsent({
      status: 'consented',
      jurisdiction: 'one-party',
      method: 'verbal-on-call',
      recordOtherParty: true
    })
    expect(clean.recordOtherParty).toBe(true)
    expect(clean.method).toBe('verbal-on-call')
  })

  // The standing-consent record produced by the Settings toggle. It must
  // survive sanitisation exactly like a hand-confirmed one — because it IS a
  // consent record, not a bypass.
  it('accepts a standing pre-agreed consent', () => {
    const now = new Date().toISOString()
    const clean = sanitizeConsent({
      status: 'consented',
      jurisdiction: 'two-party',
      method: 'pre-agreed',
      recordOtherParty: true,
      disclosedAt: now,
      decidedAt: now
    })
    expect(clean.recordOtherParty).toBe(true)
    expect(clean.method).toBe('pre-agreed')
    expect(clean.decidedAt).toBe(now)
  })

  // Every one of these is a file someone could hand-edit to try to grant
  // themselves buyer capture without a consent behind it.
  it.each([
    ['not-asked', { status: 'not-asked', recordOtherParty: true }],
    ['disclosed', { status: 'disclosed', recordOtherParty: true }],
    ['declined', { status: 'declined', recordOtherParty: true }],
    ['a bogus status', { status: 'totally-fine', recordOtherParty: true }],
    ['no status at all', { recordOtherParty: true }],
    [
      'a pre-agreed method without consent',
      { status: 'declined', method: 'pre-agreed', recordOtherParty: true }
    ]
  ])('refuses buyer capture for %s', (_label, input) => {
    expect(sanitizeConsent(input).recordOtherParty).toBe(false)
  })

  it('refuses buyer capture when the flag itself is merely truthy', () => {
    expect(sanitizeConsent({ status: 'consented', recordOtherParty: 'yes' }).recordOtherParty).toBe(
      false
    )
    expect(sanitizeConsent({ status: 'consented', recordOtherParty: 1 }).recordOtherParty).toBe(
      false
    )
  })

  it('falls back to two-party for a missing or nonsense jurisdiction', () => {
    expect(sanitizeConsent({}).jurisdiction).toBe('two-party')
    expect(sanitizeConsent({ jurisdiction: 'three-party' }).jurisdiction).toBe('two-party')
  })

  it('drops an unrecognised method rather than storing it', () => {
    expect(sanitizeConsent({ status: 'consented', method: 'telepathy' }).method).toBeUndefined()
  })

  it('drops timestamps that are not real dates', () => {
    const clean = sanitizeConsent({ status: 'consented', disclosedAt: 'yesterday', decidedAt: 42 })
    expect(clean.disclosedAt).toBeUndefined()
    expect(clean.decidedAt).toBeUndefined()
  })

  it('survives being handed nothing at all', () => {
    for (const input of [undefined, null, 'string', 7, []]) {
      expect(sanitizeConsent(input).recordOtherParty).toBe(false)
    }
  })
})
