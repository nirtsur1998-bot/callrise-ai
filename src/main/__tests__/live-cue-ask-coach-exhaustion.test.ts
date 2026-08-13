// BUG-057 Phase 3 — askCoach() (live-cue.ts) calls completeWithFallback()
// the same as every batch consumer, so it can throw AllModelsExhaustedError
// too, but its own friendlyError() never checked for it — confirmed absent
// by direct read, not assumed. An exhaustion fell all the way to the
// generic "Could not reach the coach. Please try again." string, losing
// summarizeExhaustion()'s classified message entirely. Drives the REAL
// askCoach with only completeWithFallback mocked (the claim under test is
// OUR OWN friendlyError routing, not SDK/provider behaviour).
import { describe, expect, it, beforeEach, vi } from 'vitest'

const completeWithFallback = vi.fn()
class FakeAllModelsExhaustedError extends Error {
  constructor(
    readonly purpose: string,
    readonly attempts: { catalogId: string; reason: string }[]
  ) {
    // Stands in for the real summarizeExhaustion()-derived message — the
    // claim under test is that THIS string reaches the caller, not that
    // summarizeExhaustion itself picks the right one (covered separately).
    super('Every configured model rejected this request the same way — this looks like a bug, not a rate limit or a full key. Please report it.')
    this.name = 'AllModelsExhaustedError'
  }
}
vi.mock('../ai/complete-with-fallback', () => ({
  completeWithFallback,
  AllModelsExhaustedError: FakeAllModelsExhaustedError
}))

const { askCoach } = await import('../live-cue')

beforeEach(() => {
  completeWithFallback.mockReset()
})

describe('askCoach — AllModelsExhaustedError surfaces its real message (BUG-057 Phase 3)', () => {
  it('returns the classified exhaustion message, not the generic "Could not reach the coach"', async () => {
    completeWithFallback.mockRejectedValue(new FakeAllModelsExhaustedError('other', []))

    const result = await askCoach({ transcript: 'rep: hello', question: 'what should I say next?' })

    expect(result.ok).toBe(false)
    expect((result as { message?: string }).message).toMatch(/looks like a bug/i)
    expect((result as { message?: string }).message).not.toMatch(/could not reach the coach/i)
  })
})
