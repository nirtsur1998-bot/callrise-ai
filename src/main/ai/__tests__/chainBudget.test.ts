import { describe, expect, it } from 'vitest'
import { CHAIN_BUDGET, LATENCY_POLICY } from '../types'
import { DEFAULT_CATALOG_CHAIN } from '../complete-with-fallback'
import { sanitizeModelAssignments } from '../model-assignments'

// M20's fallback chain walks multiple models sequentially. Without a cap,
// this reintroduces (a worse version of) the exact multi-second dead-air
// regression M9 already fixed once on the live coaching-cue path - each
// chain entry would independently consume the full LATENCY_POLICY timeout
// instead of splitting a shared budget. latencyPolicy.test.ts's maxRetries
// scan cannot catch this class of regression at all (chain length x
// per-entry timeout is a different axis than retries), so this is a
// genuinely new assertion, not a copy of that one.
//
// M24 added 'deal-tier1' as a second live, latency-critical purpose with the
// exact same shape as coaching-cue (see types.ts's CHAIN_BUDGET doc comment)
// - every assertion below is checked for both rather than just coaching-cue.
describe('coaching-cue / deal-tier1 chain-length cap + time budget', () => {
  it('coaching-cue and deal-tier1 have an explicit chain budget, unlike every other purpose', () => {
    expect(CHAIN_BUDGET['coaching-cue']).toBeDefined()
    expect(CHAIN_BUDGET['deal-tier1']).toBeDefined()
    for (const purpose of [
      'summary',
      'scorecard',
      'tasks',
      'other',
      'prep-brief',
      'deal-tier2'
    ] as const) {
      expect(CHAIN_BUDGET[purpose]).toBeUndefined()
    }
  })

  it.each(['coaching-cue', 'deal-tier1'] as const)(
    '%s caps the chain short enough that per-attempt time stays usable',
    (purpose) => {
      // 2 entries max: the purpose's own timeoutMs split 2 ways still leaves
      // each attempt enough time to connect; a longer chain (e.g. 5) would
      // drop per-attempt time below what most providers need just to
      // establish a connection under bad network conditions.
      expect(CHAIN_BUDGET[purpose]!.maxChainLength).toBeLessThanOrEqual(2)
    }
  )

  it.each(['coaching-cue', 'deal-tier1'] as const)(
    '%s total budget never exceeds its own LATENCY_POLICY timeout (the M9 regression guard)',
    (purpose) => {
      expect(CHAIN_BUDGET[purpose]!.totalBudgetMs).toBeLessThanOrEqual(LATENCY_POLICY[purpose].timeoutMs)
    }
  )

  it.each(['coaching-cue', 'deal-tier1'] as const)(
    'the bundled default %s chain respects the cap',
    (purpose) => {
      expect(DEFAULT_CATALOG_CHAIN[purpose].length).toBeLessThanOrEqual(
        CHAIN_BUDGET[purpose]!.maxChainLength
      )
    }
  )

  it.each(['coaching-cue', 'deal-tier1'] as const)(
    'a user-configured %s chain longer than the cap is truncated, not honored as-is',
    (purpose) => {
      const oversized = ['a', 'b', 'c', 'd', 'e']
      const sanitized = sanitizeModelAssignments({ [purpose]: { chain: oversized } })
      expect(sanitized[purpose].chain.length).toBeLessThanOrEqual(CHAIN_BUDGET[purpose]!.maxChainLength)
    }
  )

  it('non-live purposes are NOT chain-length-capped by the settings sanitizer', () => {
    const longChain = ['a', 'b', 'c', 'd', 'e']
    const sanitized = sanitizeModelAssignments({ summary: { chain: longChain } })
    expect(sanitized.summary.chain.length).toBe(longChain.length)
  })
})
