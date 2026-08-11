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
describe('coaching-cue chain-length cap + time budget', () => {
  it('has an explicit chain budget, unlike every other purpose', () => {
    expect(CHAIN_BUDGET['coaching-cue']).toBeDefined()
    for (const purpose of ['summary', 'scorecard', 'tasks', 'other', 'prep-brief'] as const) {
      expect(CHAIN_BUDGET[purpose]).toBeUndefined()
    }
  })

  it('caps the chain short enough that per-attempt time stays usable', () => {
    // 2 entries max: LATENCY_POLICY['coaching-cue'].timeoutMs split 2 ways
    // still leaves each attempt enough time to connect; a longer chain
    // (e.g. 5) would drop per-attempt time below what most providers need
    // just to establish a connection under bad network conditions.
    expect(CHAIN_BUDGET['coaching-cue']!.maxChainLength).toBeLessThanOrEqual(2)
  })

  it('total budget never exceeds the existing coaching-cue timeout (the M9 regression guard)', () => {
    expect(CHAIN_BUDGET['coaching-cue']!.totalBudgetMs).toBeLessThanOrEqual(
      LATENCY_POLICY['coaching-cue'].timeoutMs
    )
  })

  it('the bundled default coaching-cue chain respects the cap', () => {
    expect(DEFAULT_CATALOG_CHAIN['coaching-cue'].length).toBeLessThanOrEqual(
      CHAIN_BUDGET['coaching-cue']!.maxChainLength
    )
  })

  it('a user-configured chain longer than the cap is truncated, not honored as-is', () => {
    const oversized = ['a', 'b', 'c', 'd', 'e']
    const sanitized = sanitizeModelAssignments({ 'coaching-cue': { chain: oversized } })
    expect(sanitized['coaching-cue'].chain.length).toBeLessThanOrEqual(
      CHAIN_BUDGET['coaching-cue']!.maxChainLength
    )
  })

  it('non-live purposes are NOT chain-length-capped by the settings sanitizer', () => {
    const longChain = ['a', 'b', 'c', 'd', 'e']
    const sanitized = sanitizeModelAssignments({ summary: { chain: longChain } })
    expect(sanitized.summary.chain.length).toBe(longChain.length)
  })
})
