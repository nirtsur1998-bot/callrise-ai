// BUG-057 Phase 2 — deal-risk.ts's friendlyError() had NO AllModelsExhaustedError
// branch at all (confirmed by direct read: no import of it existed), unlike
// every other batch consumer (coach.ts, summarize.ts, generate-tasks.ts,
// objection-mining.ts). A fully diagnosable "every model failed" exhaustion
// fell to the generic "Something went wrong" string.
import { describe, expect, it, vi } from 'vitest'

const completeWithFallback = vi.fn()
class FakeAllModelsExhaustedError extends Error {
  constructor(
    readonly purpose: string,
    readonly attempts: { catalogId: string; reason: string }[]
  ) {
    super(`Every configured model for "${purpose}" failed: ${attempts.map((a) => a.reason).join('; ')}`)
    this.name = 'AllModelsExhaustedError'
  }
}
vi.mock('../ai/complete-with-fallback', () => ({
  completeWithFallback,
  AllModelsExhaustedError: FakeAllModelsExhaustedError
}))

const { assessDealRisk } = await import('../deal-risk')

describe('deal-risk.ts — AllModelsExhaustedError is no longer swallowed into a generic string', () => {
  it('surfaces the real exhaustion message, not "Something went wrong"', async () => {
    completeWithFallback.mockRejectedValue(
      new FakeAllModelsExhaustedError('other', [{ catalogId: 'groq-x', reason: 'rate-limit' }])
    )

    const result = await assessDealRisk({
      title: 'Acme deal',
      stageLabel: 'Discovery',
      createdAt: '2026-01-01T00:00:00.000Z',
      calls: []
    })

    expect(result.ok).toBe(false)
    expect((result as { message?: string }).message).toContain('Every configured model for "other" failed')
    expect((result as { message?: string }).message).not.toContain('Something went wrong')
  })
})
