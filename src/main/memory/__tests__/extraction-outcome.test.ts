// BUG-057 — extraction must distinguish "the AI call failed" from "the AI
// call worked and there was nothing worth keeping."
//
// Those were the same value (a bare `[]`) for the entire life of the feature,
// which is exactly how 205 failed extractions read as healthy "nothing to
// learn" runs for two days, all the way up through a green "Import complete."
// These drive the REAL extractMemoriesFromCall / extractMemoriesFromChatMessage
// with only the network-bound AI call mocked.
import { describe, expect, it, beforeEach, vi } from 'vitest'

const completeWithFallback = vi.fn()
vi.mock('../../ai/complete-with-fallback', () => ({
  completeWithFallback: (req: unknown) => completeWithFallback(req)
}))

const { extractMemoriesFromCall, extractMemoriesFromChatMessage } = await import('../extraction')

const SEGMENTS = [
  { speaker: 0, text: 'We are moving off Salesforce next quarter because it is too expensive.', startMs: 0, endMs: 5000 }
]

beforeEach(() => {
  completeWithFallback.mockReset()
})

describe('extractMemoriesFromCall — failure is reported, not erased', () => {
  it('a thrown AI call yields aiFailed: true and carries the reason', async () => {
    completeWithFallback.mockRejectedValue(new Error('Gemini is rate-limiting requests right now.'))

    const outcome = await extractMemoriesFromCall(SEGMENTS, 'call-1', null)

    expect(outcome.aiFailed).toBe(true)
    expect(outcome.candidates).toEqual([])
    expect(outcome.failureReason).toMatch(/rate-limiting/i)
  })

  it('still never throws into its fire-and-forget caller', async () => {
    completeWithFallback.mockRejectedValue(new Error('boom'))
    await expect(extractMemoriesFromCall(SEGMENTS, 'call-1', null)).resolves.toBeDefined()
  })

  it('a SUCCESSFUL call that finds nothing is aiFailed: false — the distinction that did not exist', async () => {
    completeWithFallback.mockResolvedValue({ toolInput: { candidates: [] } })

    const outcome = await extractMemoriesFromCall(SEGMENTS, 'call-1', null)

    expect(outcome.aiFailed).toBe(false)
    expect(outcome.candidates).toEqual([])
  })

  it('an empty transcript is not a failure — nothing was attempted', async () => {
    const outcome = await extractMemoriesFromCall([], 'call-1', null)

    expect(outcome.aiFailed).toBe(false)
    expect(completeWithFallback).not.toHaveBeenCalled()
  })

  it('a successful extraction returns its candidates with aiFailed: false', async () => {
    completeWithFallback.mockResolvedValue({
      toolInput: {
        candidates: [
          {
            scopeKind: 'client', // must match CATEGORY_SCOPE_KIND['client-fact'] or it's dropped
            category: 'client-fact',
            statement: 'Moving off Salesforce next quarter',
            quote: 'We are moving off Salesforce next quarter',
            confidence: 0.9,
            importance: 7
          }
        ]
      }
    })

    const outcome = await extractMemoriesFromCall(SEGMENTS, 'call-1', 'contact-1')

    expect(outcome.aiFailed).toBe(false)
    expect(outcome.candidates.length).toBeGreaterThan(0)
    // Provenance still stamped — the mechanism BUG-056's diagnostic relied on.
    // MemoryEvidence is a discriminated union (transcript | reflection) —
    // extraction from a call always produces 'transcript' evidence, but the
    // type itself doesn't know that, so narrow explicitly rather than
    // reaching for .callId on the union directly.
    expect(outcome.candidates[0].evidence[0]).toMatchObject({ type: 'transcript', callId: 'call-1' })
  })
})

describe('extractMemoriesFromChatMessage — same contract', () => {
  it('reports failure rather than an empty array', async () => {
    completeWithFallback.mockRejectedValue(new Error('no key'))

    const outcome = await extractMemoriesFromChatMessage('some message', 'call-1', 'msg-1', null)

    expect(outcome.aiFailed).toBe(true)
    expect(outcome.failureReason).toMatch(/no key/i)
  })

  it('an empty message is not a failure', async () => {
    const outcome = await extractMemoriesFromChatMessage('   ', 'call-1', 'msg-1', null)

    expect(outcome.aiFailed).toBe(false)
    expect(completeWithFallback).not.toHaveBeenCalled()
  })
})
