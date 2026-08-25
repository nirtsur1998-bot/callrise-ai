// BUG-080 — the retrieval relevance threshold was written in cosine-distance
// terms (0.6) but vec0 returns EUCLIDEAN distances, where a natural-language
// paraphrase of a stored fact lands around L2 1.0–1.25 on MiniLM's unit
// vectors. Result: question-scoped retrieval returned NOTHING for real
// questions since M25 (measured 0/14 recall on M28's retrieval-quality
// harness; verbatim probes score distance 0.0000 and rank correctly, so only
// the cut-off units were wrong).
//
// The discriminating case: a memory at distance 1.0 — squarely inside the
// realistic paraphrase band — MUST be retrievable. Red on the shipped 0.6
// threshold, green at the harness-chosen 1.3.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  search: vi.fn(
    (_db: unknown, _emb: unknown, _opts: { scope: string; limit: number }) =>
      [] as { memory: Record<string, unknown>; distance: number }[]
  )
}))

vi.mock('../../app-settings', () => ({ isSalesBrainEnabled: () => true }))
vi.mock('../memory-runtime', () => ({ getMemoryDb: () => ({ fake: 'db' }) }))
vi.mock('../embeddings', () => ({ embedText: async () => new Float32Array(384) }))
vi.mock('../memories-store', () => ({ searchMemoriesByVector: mocks.search }))

import { retrieveRelevantMemories } from '../rag'

function mem(statement: string): Record<string, unknown> {
  return { id: 'm-1', scope: 'rep', statement, confidence: 0.8, status: 'active' }
}

beforeEach(() => {
  mocks.search.mockReset()
  mocks.search.mockReturnValue([])
})

describe('BUG-080 — L2 distance units', () => {
  it('a memory at L2 distance 1.0 (a realistic paraphrase) IS retrieved', async () => {
    mocks.search.mockImplementation((_d, _e, opts) =>
      opts.scope === 'rep'
        ? [{ memory: mem('Pricing is per seat at 49 dollars a month'), distance: 1.0 }]
        : []
    )
    const text = await retrieveRelevantMemories('what do we charge?', null)
    expect(text).toContain('Pricing is per seat at 49 dollars a month')
  })

  it('control: a genuinely far memory (L2 1.9) is still filtered out', async () => {
    mocks.search.mockImplementation((_d, _e, opts) =>
      opts.scope === 'rep' ? [{ memory: mem('Unrelated fact'), distance: 1.9 }] : []
    )
    expect(await retrieveRelevantMemories('what do we charge?', null)).toBe('')
  })

  it('control: verbatim-near matches (L2 0.1) keep working as before', async () => {
    mocks.search.mockImplementation((_d, _e, opts) =>
      opts.scope === 'rep' ? [{ memory: mem('Near-identical fact'), distance: 0.1 }] : []
    )
    expect(await retrieveRelevantMemories('near identical fact', null)).toContain(
      'Near-identical fact'
    )
  })
})
