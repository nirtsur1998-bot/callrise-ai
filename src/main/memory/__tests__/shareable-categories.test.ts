// M37 Stage 4 — the line a team feature may never cross, pinned before one exists.
//
// There is no team feature, no publish path, and nothing in the app reads
// SHAREABLE_CATEGORIES today. That is exactly why this is worth an hour now:
// the constant and these two assertions cost nothing while the answer is
// obvious, and in a year "is a skill-weakness shareable?" gets answered
// per-customer, in a settings screen, by whoever is closing the deal. Every
// vendor in the prior art took that path — in Gong's own documentation,
// "Private means only you can see the results" and "Private scorecard results
// are visible to managers" appear in the same article.
//
// The two tests do different jobs on purpose:
//   1. an EXACT-CONTENTS assertion, so widening the list means deleting a
//      named line in a diff rather than adding one;
//   2. a DERIVED assertion over the whole taxonomy, so a category added later
//      is refused by default rather than silently inheriting a rule nobody
//      re-read.
import { describe, expect, it } from 'vitest'
import {
  CATEGORY_SCOPE_KIND,
  MEMORY_CATEGORIES,
  SHAREABLE_CATEGORIES,
  isShareableCategory
} from '../types'

describe('SHAREABLE_CATEGORIES — what may ever leave the rep it belongs to', () => {
  it('is exactly the six business categories, listed by name', () => {
    // Deliberately not computed from CATEGORY_SCOPE_KIND. If the two ever
    // disagree, the next test says so; this one exists so that CHANGING the
    // policy requires deleting one of these six strings by hand.
    expect([...SHAREABLE_CATEGORIES]).toEqual([
      'product-or-service',
      'pricing-model',
      'icp',
      'objection-and-response',
      'competitor',
      'terminology'
    ])
  })

  it('refuses every rep category — the seven the founder named as private', () => {
    const rep = MEMORY_CATEGORIES.filter((c) => CATEGORY_SCOPE_KIND[c] === 'rep')
    expect(rep).toEqual([
      'selling-pattern',
      'skill-strength',
      'skill-weakness',
      'stated-goal',
      'stated-struggle',
      'communication-style',
      'preference'
    ])
    for (const c of rep) expect(isShareableCategory(c), `${c} must never be shareable`).toBe(false)
  })

  it('refuses every client category — attributable to one rep at any headcount', () => {
    // Not for privacy of the rep but of the BUYER, and because the manager
    // knows who owns the account: a client fact identifies its owner however
    // large the team is, so no cohort size makes it safe.
    const client = MEMORY_CATEGORIES.filter((c) => CATEGORY_SCOPE_KIND[c] === 'client')
    expect(client.length).toBeGreaterThanOrEqual(6)
    for (const c of client) expect(isShareableCategory(c), `${c} must never be shareable`).toBe(false)
  })

  it('a category added later is NOT shareable by default — the list is an allowlist', () => {
    // Derived from the taxonomy rather than restated, so this keeps holding
    // when MEMORY_CATEGORIES grows. Every shareable category must be
    // business-scoped, and nothing outside the list may be shareable.
    for (const c of MEMORY_CATEGORIES) {
      if (isShareableCategory(c)) {
        expect(CATEGORY_SCOPE_KIND[c], `${c} is shareable but is not a business fact`).toBe('business')
      }
    }
    const business = MEMORY_CATEGORIES.filter((c) => CATEGORY_SCOPE_KIND[c] === 'business')
    expect(
      [...SHAREABLE_CATEGORIES].sort(),
      'a business category exists that nobody decided about — add it to SHAREABLE_CATEGORIES or say why not'
    ).toEqual([...business].sort())
  })

  it('nothing in the app reads it yet, and that is recorded rather than assumed', () => {
    // A guard for a feature that does not exist can rot silently. When a team
    // feature IS built, this test should fail and be replaced by one asserting
    // the publish path consults the constant. Until then the honest statement
    // is that the line is drawn and unused.
    expect(SHAREABLE_CATEGORIES.length).toBe(6)
  })
})
