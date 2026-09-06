// BUG-196, shape (b) — THE BEFORE/AFTER THAT NEEDS NO MODEL.
//
// The live harness could not measure a rule change today: the free models
// fail structured output and rate-limit a burst, so the same rule scored
// 40%, 20%, 27%, 7% on the same fixture (BUG-195). This file measures the
// rule itself, replayed over the REAL proposals the models made in the
// day's runs — captured by the instrument with their claimed scope, category,
// the reason they were refused, and the ground-truth fact they would have
// satisfied (fixtures/bug196-refused-proposals.json, 32 rows from runs 12–19,
// deduplicated per scenario+statement). Deterministic; no provider, no key.
//
// What it pins:
//   1. BEFORE: every one of those rows was refused (that is how they got
//      into the fixture), 19 of them ground truth.
//   2. AFTER: every `client/<rep-or-business category>` row is KEPT as a
//      `client-fact` in the client scope — the 19 ground-truth rows included —
//      and the one `quote-not-in-source` row is still refused (the remap
//      touches scope/category only; quote verification is untouched).
//   3. THE DIRECTION THAT STAYS A DROP: a client-fact the model attributes to
//      the rep or the business, a rep↔business swap, and a client fact with no
//      contact are all still refused — the privacy direction is by
//      construction, and this test is the red check on it.
//   4. The full verifier, end to end, with a quote that verifies: the remap
//      produces a client-scoped `client-fact` carrying the original quote.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveScopeAndCategory, verifyCandidate } from '../extraction'
import { CATEGORY_SCOPE_KIND, MEMORY_CATEGORIES, type MemoryCategory } from '../types'

interface RefusedRow {
  run: number
  scenario: string
  scopeKind: string
  category: string
  statement: string
  reason: string
  wouldHaveHit: string | null
}
const ROWS = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'bug196-refused-proposals.json'), 'utf8')) as RefusedRow[]

describe('BUG-196 shape (b) — replay of the day\'s refused proposals through the new rule', () => {
  it('the fixture is what the instrument captured: 32 refusals, 19 of them ground truth, 31 client-claimed mismatches', () => {
    expect(ROWS).toHaveLength(32)
    expect(ROWS.filter((r) => r.wouldHaveHit).length).toBe(19)
    const mismatches = ROWS.filter((r) => r.reason === 'category-scope-mismatch')
    expect(mismatches).toHaveLength(31)
    expect(mismatches.every((r) => r.scopeKind === 'client')).toBe(true) // the direction, read off the instrument
    expect(ROWS.filter((r) => r.reason === 'quote-not-in-source')).toHaveLength(1)
  })

  it('AFTER: every client-claimed mismatch is kept as client-fact in the client scope — 18 of the 19 ground-truth rows recovered by the rule (the 19th is a quote failure, untouched)', () => {
    const mismatches = ROWS.filter((r) => r.reason === 'category-scope-mismatch')
    let kept = 0
    let groundTruthKept = 0
    for (const r of mismatches) {
      const out = resolveScopeAndCategory(r.scopeKind, r.category as MemoryCategory, 'contact-1')
      expect('rejected' in out, `${r.scenario}: "${r.statement.slice(0, 60)}" [${r.scopeKind}/${r.category}] still refused`).toBe(false)
      if ('rejected' in out) continue
      expect(out.expectedKind).toBe('client')
      expect(out.category).toBe('client-fact')
      expect(out.remappedFrom).toBe(r.category)
      kept++
      if (r.wouldHaveHit) groundTruthKept++
    }
    expect(kept).toBe(31)
    // 19 ground-truth refusals in the fixture; ONE of them was refused as
    // quote-not-in-source, which the remap rightly does not touch — 18 come
    // back by the rule alone
    expect(groundTruthKept).toBe(18)
    const quoteRow = ROWS.find((r) => r.reason === 'quote-not-in-source')
    expect(quoteRow?.wouldHaveHit).toBeTruthy()
  })

  it('BEFORE (the old rule, reconstructed): the same 31 rows were dropped — the number this change moves', () => {
    // the old rule was: expectedKind !== scopeKind → drop, no exceptions
    const oldRule = (scopeKind: string, category: MemoryCategory): boolean => CATEGORY_SCOPE_KIND[category] === scopeKind
    const mismatches = ROWS.filter((r) => r.reason === 'category-scope-mismatch')
    expect(mismatches.filter((r) => oldRule(r.scopeKind, r.category as MemoryCategory))).toHaveLength(0)
  })
})

describe('BUG-196 shape (b) — the direction that STAYS a drop (the privacy red check)', () => {
  it('a client-fact the model attributes to the rep or the business is refused, not remapped', () => {
    expect(resolveScopeAndCategory('rep', 'client-fact', 'contact-1')).toEqual({ rejected: 'category-scope-mismatch' })
    expect(resolveScopeAndCategory('business', 'client-fact', 'contact-1')).toEqual({ rejected: 'category-scope-mismatch' })
  })
  it('a rep↔business swap is refused either way', () => {
    expect(resolveScopeAndCategory('rep', 'pricing-model', 'contact-1')).toEqual({ rejected: 'category-scope-mismatch' })
    expect(resolveScopeAndCategory('business', 'stated-goal', 'contact-1')).toEqual({ rejected: 'category-scope-mismatch' })
  })
  it('a client-claimed fact with no real contact is still refused — never a fabricated scope', () => {
    expect(resolveScopeAndCategory('client', 'stated-goal', null)).toEqual({ rejected: 'client-fact-without-contact' })
    expect(resolveScopeAndCategory('client', 'client-fact', null)).toEqual({ rejected: 'client-fact-without-contact' })
  })
  it('an unknown scope kind is refused', () => {
    expect(resolveScopeAndCategory('team', 'client-fact', 'contact-1')).toEqual({ rejected: 'category-scope-mismatch' })
  })
  it('matching pairs are untouched: every category with its own scope kind passes with no remap', () => {
    for (const category of MEMORY_CATEGORIES) {
      const kind = CATEGORY_SCOPE_KIND[category]
      const out = resolveScopeAndCategory(kind, category, 'contact-1')
      expect(out).toEqual({ expectedKind: kind, category })
    }
  })
})

describe('BUG-196 shape (b) — end to end through verifyCandidate', () => {
  const transcript = 'OTHER PARTY (the client): We have about forty to fifty thousand budgeted for this year.'
  it('a client-claimed budget filed as pricing-model becomes a client-scoped client-fact with its quote', () => {
    const out = verifyCandidate(
      {
        scopeKind: 'client',
        category: 'pricing-model',
        statement: 'The client has a budget of $40k–$50k for the year.',
        quote: 'about forty to fifty thousand budgeted for this year',
        confidence: 0.9,
        importance: 8
      },
      transcript,
      'contact-acme'
    )
    expect('candidate' in out).toBe(true)
    if (!('candidate' in out)) return
    expect(out.candidate.scope).toBe('client:contact-acme')
    expect(out.candidate.category).toBe('client-fact')
    expect(out.remappedFrom).toBe('pricing-model')
    expect(out.candidate.evidence[0]).toMatchObject({ type: 'transcript', quote: 'about forty to fifty thousand budgeted for this year' })
  })
  it('the remap never bypasses quote verification', () => {
    const out = verifyCandidate(
      { scopeKind: 'client', category: 'pricing-model', statement: 'x', quote: 'words that are not in the transcript', confidence: 0.9, importance: 8 },
      transcript,
      'contact-acme'
    )
    expect(out).toEqual({ rejected: 'quote-not-in-source' })
  })
})
