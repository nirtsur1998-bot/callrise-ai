// BUG-167 (rest) — the outcome the brain never had.
//
// Every candidate was forced into rep, business or client by
// CATEGORY_SCOPE_KIND, so anything the model found interesting became a claim
// about the user or their company. There was no way to say "not relevant"
// other than returning nothing at all, and a model does not reach for nothing.
//
// What that produced in the founder's real store, at confidence 1.0:
//   [rep/communication-style]     "Speaker 0 speaks first."
//   [business/product-or-service] "The deal intelligence panel sits on top of
//                                  the transcript."
// The second is the app learning a bug report about ITSELF as a fact about
// the founder's product.
//
// Founder's decision, 2026-09-02: "the brain should be allowed to say 'not
// relevant'. Add that outcome."
import { describe, expect, it, beforeEach, vi } from 'vitest'

const completeWithFallback = vi.fn()
vi.mock('../../ai/complete-with-fallback', () => ({
  completeWithFallback,
  AllModelsExhaustedError: class extends Error {}
}))

const { extractMemoriesFromCall, verifyAndBuild } = await import('../extraction')

const seg = (speaker: number, channel: number, text: string): never =>
  ({ speaker, channel, text, startMs: speaker * 1000 }) as never

const SOURCE_SEGS = [
  seg(0, 0, 'I always open with a short discovery question before talking about price at all.'),
  seg(1, 1, 'Our procurement team needs three competing bids for anything over fifty thousand.')
]

const toolSchema = (): Record<string, unknown> => {
  const call = completeWithFallback.mock.calls[0]
  return call?.[0]?.tool?.inputSchema ?? {}
}

beforeEach(() => {
  completeWithFallback.mockReset()
  completeWithFallback.mockResolvedValue({ toolInput: { candidates: [] } })
})

describe('BUG-167 — the model can decline instead of misfiling', () => {
  it('offers "not-relevant" in the category ENUM, not merely in its description', async () => {
    await extractMemoriesFromCall(SOURCE_SEGS, 'call-1', null)
    const schema = toolSchema() as Record<string, never>
    // Reach the actual enum array. An earlier version of this test stringified
    // the whole schema and matched "not-relevant" anywhere — which the category
    // DESCRIPTION also contains, so deleting the enum entry left it green.
    // Species 69: the assertion answered a neighbouring question.
    const props = (schema.properties as Record<string, never>)?.candidates as Record<string, never>
    const item = (props?.items as Record<string, never>)?.properties as Record<string, never>
    const categoryEnum = (item?.category as Record<string, never>)?.enum as unknown as string[]
    expect(Array.isArray(categoryEnum), 'could not reach the category enum in the schema').toBe(true)
    expect(categoryEnum).toContain('not-relevant')
    // and the storable categories are still all there
    expect(categoryEnum).toContain('selling-pattern')
    expect(categoryEnum).toContain('client-fact')
  })

  it('tells the model in the prompt that declining is a real answer', async () => {
    await extractMemoriesFromCall(SOURCE_SEGS, 'call-2', null)
    const prompt = String(completeWithFallback.mock.calls[0]?.[0]?.messages?.[0]?.content ?? '')
    expect(prompt).toContain('not-relevant')
    expect(prompt.toLowerCase()).toContain('declining is a real answer')
  })

  // The outcome has to actually DROP the candidate, not store it under a new
  // name. not-relevant is deliberately absent from MEMORY_CATEGORIES.
  it('a candidate marked not-relevant is dropped, never stored', () => {
    const out = verifyAndBuild(
      {
        statement: 'The deal intelligence panel sits on top of the transcript.',
        quote: 'the deal intelligence panel sits on top of the transcript',
        category: 'not-relevant',
        scopeKind: 'business',
        confidence: 1,
        importance: 5
      },
      'the deal intelligence panel sits on top of the transcript',
      null
    )
    expect(out).toBeNull()
  })

  // CONTROL — without this the change could be "reject everything".
  it('CONTROL — a real selling-pattern fact still stores', () => {
    const src = 'I always open with a short discovery question before talking about price at all.'
    const out = verifyAndBuild(
      {
        statement: 'The rep opens with a discovery question before discussing price.',
        quote: 'I always open with a short discovery question before talking about price',
        category: 'selling-pattern',
        scopeKind: 'rep',
        confidence: 1,
        importance: 5
      },
      src,
      null
    )
    expect(out).not.toBeNull()
    expect(out?.scope).toBe('rep')
  })
})
