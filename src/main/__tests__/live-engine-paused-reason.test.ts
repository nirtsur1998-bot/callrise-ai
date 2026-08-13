// BUG-057 Phase 2 — live-cue.ts/deal-tier1.ts/deal-tier2.ts used to have
// exactly one non-generic catch branch (AllModelsExhaustedError -> paused).
// A HARD_CEILING_MS timeout and an "every model cooling down" rate-limit
// both fell through to the generic branch with NO pausedReason at all — the
// renderer's own strict-equality check then silently read that as "not
// paused." These tests drive the REAL live-cue/deal-tier1/deal-tier2
// functions with only completeWithFallback mocked (legitimate here: the
// claim under test is OUR OWN catch-block routing, not SDK behaviour).
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { AIProviderError } from '../ai/types'

const completeWithFallback = vi.fn()
vi.mock('../ai/complete-with-fallback', () => ({
  completeWithFallback,
  AllModelsExhaustedError: class extends Error {
    constructor(
      readonly purpose: string,
      readonly attempts: { catalogId: string; reason: string }[]
    ) {
      super('exhausted')
    }
  }
}))
vi.mock('../app-settings', () => ({
  isSelfIntroExtractionAllowed: () => false,
  isSalesBrainEnabled: () => false
}))
vi.mock('../consent-gate', () => ({ consentPermitsCapture: () => true }))

const { liveCue } = await import('../live-cue')
const { analyzeDealTier1 } = await import('../deal-tier1')
const { analyzeDealTier2 } = await import('../deal-tier2')

beforeEach(() => {
  completeWithFallback.mockReset()
})

const WINDOW = 'Speaker 0: thanks for joining today\nSpeaker 1: happy to be here, tell me about pricing'
const LONG_TEXT =
  'Rep: thanks for taking the time today, I wanted to walk through pricing. Buyer: sure, go ahead.'

describe('live-cue.ts — pausedReason routing (BUG-057 Phase 2)', () => {
  it('a HARD_CEILING_MS timeout is reported as pausedReason: timed-out, not silence', async () => {
    completeWithFallback.mockRejectedValue(
      new AIProviderError('timeout', 'This took too long and was stopped after 6s.')
    )
    const result = await liveCue({ transcript: WINDOW, repSpeaker: 0 })
    expect(result).toMatchObject({ ok: false, pausedReason: 'timed-out' })
  })

  it('every model cooling down is reported as pausedReason: all-models-unavailable, not silence', async () => {
    completeWithFallback.mockRejectedValue(
      new AIProviderError('rate-limit', 'Every model set up for this is rate-limited right now. Try again in about 45s.')
    )
    const result = await liveCue({ transcript: WINDOW, repSpeaker: 0 })
    expect(result).toMatchObject({ ok: false, pausedReason: 'all-models-unavailable' })
  })

  it('an ordinary one-off failure still reports no pausedReason at all (unchanged)', async () => {
    completeWithFallback.mockRejectedValue(new AIProviderError('failed', 'malformed response'))
    const result = await liveCue({ transcript: WINDOW, repSpeaker: 0 })
    expect(result.ok).toBe(false)
    expect((result as { pausedReason?: unknown }).pausedReason).toBeUndefined()
  })
})

describe('deal-tier1.ts — pausedReason routing (BUG-057 Phase 2)', () => {
  it('a HARD_CEILING_MS timeout is reported as pausedReason: timed-out', async () => {
    completeWithFallback.mockRejectedValue(new AIProviderError('timeout', 'took too long'))
    const result = await analyzeDealTier1({ transcriptDelta: LONG_TEXT, compactState: '' })
    expect(result).toMatchObject({ ok: false, pausedReason: 'timed-out' })
  })

  it('every model cooling down is reported as pausedReason: all-models-unavailable', async () => {
    completeWithFallback.mockRejectedValue(new AIProviderError('rate-limit', 'rate-limited right now'))
    const result = await analyzeDealTier1({ transcriptDelta: LONG_TEXT, compactState: '' })
    expect(result).toMatchObject({ ok: false, pausedReason: 'all-models-unavailable' })
  })
})

describe('deal-tier2.ts — pausedReason routing (BUG-057 Phase 2)', () => {
  it('a HARD_CEILING_MS timeout is reported as pausedReason: timed-out', async () => {
    completeWithFallback.mockRejectedValue(new AIProviderError('timeout', 'took too long'))
    const result = await analyzeDealTier2({ transcriptDelta: LONG_TEXT, compactState: '' })
    expect(result).toMatchObject({ ok: false, pausedReason: 'timed-out' })
  })

  it('every model cooling down is reported as pausedReason: all-models-unavailable', async () => {
    completeWithFallback.mockRejectedValue(new AIProviderError('rate-limit', 'rate-limited right now'))
    const result = await analyzeDealTier2({ transcriptDelta: LONG_TEXT, compactState: '' })
    expect(result).toMatchObject({ ok: false, pausedReason: 'all-models-unavailable' })
  })
})
