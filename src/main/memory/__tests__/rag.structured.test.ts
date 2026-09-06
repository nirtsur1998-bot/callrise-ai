// M28 — retrieveRelevantMemoriesStructured: the structured retrieval API the
// Rise assistant's citations and the Phase 2 eval harness both stand on.
// The SQL half (searchMemoriesByVector) has its own suite against a real db;
// what THIS file proves is rag.ts's orchestration: scope fan-out, distance
// filtering, hypothesis opt-in, the foreground ensureMemoryDb retry, the
// foreground embedding timeout, and that the legacy string function is a
// formatter over the same implementation (extended, not forked).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Memory } from '../types'

const mocks = vi.hoisted(() => ({
  enabled: true,
  db: null as object | null,
  ensured: vi.fn(async () => ({ db: null as object | null, detail: 'x' })),
  embed: vi.fn(async () => new Float32Array(384)),
  search: vi.fn(
    (
      _db: unknown,
      _embedding: unknown,
      _opts: { scope: string; limit: number; statuses: string[] }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) => [] as { memory: any; distance: number }[]
  )
}))

vi.mock('../../app-settings', () => ({ isSalesBrainEnabled: () => mocks.enabled }))
vi.mock('../memory-runtime', () => ({
  getMemoryDb: () => mocks.db,
  ensureMemoryDb: mocks.ensured
}))
vi.mock('../embeddings', () => ({ embedText: mocks.embed }))
vi.mock('../memories-store', () => ({ searchMemoriesByVector: mocks.search }))

import { retrieveRelevantMemories, retrieveRelevantMemoriesStructured } from '../rag'

function mem(id: string, statement: string, status: Memory['status'] = 'active'): Memory {
  return {
    id,
    scope: 'rep',
    category: 'selling-pattern',
    statement,
    evidence: [],
    confidence: 0.8,
    importance: 5,
    status,
    source: 'auto',
    pinned: false,
    createdAt: '2026-01-01T00:00:00Z',
    lastConfirmedAt: '2026-01-01T00:00:00Z'
  } as Memory
}

beforeEach(() => {
  mocks.enabled = true
  mocks.db = { fake: 'db' }
  mocks.ensured.mockClear()
  mocks.embed.mockClear()
  mocks.embed.mockImplementation(async () => new Float32Array(384))
  mocks.search.mockReset()
  mocks.search.mockReturnValue([])
})

afterEach(() => {
  vi.useRealTimers()
})

describe('retrieveRelevantMemoriesStructured', () => {
  it('fans out per scope, filters by distance, sorts, and caps', async () => {
    mocks.search.mockImplementation((_db: unknown, _emb: unknown, opts: { scope: string }) => {
      if (opts.scope === 'rep') {
        return [
          { memory: mem('near', 'near fact'), distance: 0.1 },
          { memory: mem('far', 'far fact'), distance: 1.9 } // over MAX_DISTANCE (L2 = 1.3)
        ]
      }
      if (opts.scope === 'business') return [{ memory: mem('mid', 'mid fact'), distance: 0.3 }]
      return [{ memory: mem('client', 'client fact'), distance: 0.2 }]
    })
    const results = await retrieveRelevantMemoriesStructured('q', { contactId: 'c-1' })
    expect(results.map((r) => r.memory.id)).toEqual(['near', 'client', 'mid'])
    // Three scopes searched: rep, business, client:c-1.
    const scopes = mocks.search.mock.calls.map((c) => (c[2] as { scope: string }).scope)
    expect(scopes).toEqual(['rep', 'business', 'client:c-1'])
  })

  // M36 Stage 3 — option B, switched on by the founder under three conditions.
  it('unbound + inferredClientIds: fans out to rep, business and each NAMED client, in order', async () => {
    await retrieveRelevantMemoriesStructured('what did Dana say?', {
      contactId: null,
      inferredClientIds: ['c-acme', 'c-globex']
    })
    const scopes = mocks.search.mock.calls.map((c) => (c[2] as { scope: string }).scope)
    expect(scopes).toEqual(['rep', 'business', 'client:c-acme', 'client:c-globex'])
  })
  it('bound: inferredClientIds is ignored — a scoped chat searches its own client and no other', async () => {
    await retrieveRelevantMemoriesStructured('q', { contactId: 'c-1', inferredClientIds: ['c-acme'] })
    const scopes = mocks.search.mock.calls.map((c) => (c[2] as { scope: string }).scope)
    expect(scopes).toEqual(['rep', 'business', 'client:c-1'])
  })
  it('unbound with nothing inferred: rep and business only (a question that names nobody stays unscoped)', async () => {
    await retrieveRelevantMemoriesStructured('do they need SOC 2?', { contactId: null, inferredClientIds: [] })
    const scopes = mocks.search.mock.calls.map((c) => (c[2] as { scope: string }).scope)
    expect(scopes).toEqual(['rep', 'business'])
  })
  it('THE INVARIANT: a result from a scope this call did not ask for THROWS — it is never filtered quietly', async () => {
    mocks.search.mockImplementation((_db, _e, opts) =>
      opts.scope === 'business'
        ? [{ memory: { ...mem('leak', 'other client secret'), scope: 'client:c-other' }, distance: 0.2 }]
        : []
    )
    await expect(retrieveRelevantMemoriesStructured('q', { contactId: null })).rejects.toThrow(
      /cross-scope result refused: memory leak is in scope "client:c-other"/
    )
  })

  it('defaults to active-only; includeHypotheses widens the status filter', async () => {
    await retrieveRelevantMemoriesStructured('q')
    expect((mocks.search.mock.calls[0][2] as { statuses: string[] }).statuses).toEqual(['active'])
    mocks.search.mockClear()
    await retrieveRelevantMemoriesStructured('q', { includeHypotheses: true })
    expect((mocks.search.mock.calls[0][2] as { statuses: string[] }).statuses).toEqual([
      'active',
      'hypothesis'
    ])
  })

  it('background path: null db returns [] WITHOUT the ensureMemoryDb retry', async () => {
    mocks.db = null
    expect(await retrieveRelevantMemoriesStructured('q')).toEqual([])
    expect(mocks.ensured).not.toHaveBeenCalled()
  })

  it('foreground path: null db retries through ensureMemoryDb and uses its db', async () => {
    mocks.db = null
    mocks.ensured.mockResolvedValueOnce({ db: { recovered: true }, detail: 'ok' })
    mocks.search.mockImplementation((_d: unknown, _e: unknown, opts: { scope: string }) =>
      opts.scope === 'rep' ? [{ memory: mem('m1', 's'), distance: 0.1 }] : []
    )
    const results = await retrieveRelevantMemoriesStructured('q', { foreground: true })
    expect(mocks.ensured).toHaveBeenCalledOnce()
    expect(results).toHaveLength(1)
    expect(mocks.search.mock.calls[0][0]).toEqual({ recovered: true })
  })

  it('foreground path: a hung embedding times out to [] instead of hanging the turn', async () => {
    vi.useFakeTimers()
    mocks.embed.mockImplementation(() => new Promise(() => {})) // never resolves
    const pending = retrieveRelevantMemoriesStructured('q', { foreground: true })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await pending).toEqual([])
    expect(mocks.search).not.toHaveBeenCalled()
  })

  it('background path keeps waiting on the embedding (no timeout for hooks)', async () => {
    vi.useFakeTimers()
    let resolveEmbed: (v: Float32Array<ArrayBuffer>) => void = () => {}
    mocks.embed.mockImplementation(
      () => new Promise<Float32Array<ArrayBuffer>>((r) => (resolveEmbed = r))
    )
    mocks.search.mockImplementation((_d: unknown, _e: unknown, opts: { scope: string }) =>
      opts.scope === 'rep' ? [{ memory: mem('m1', 's'), distance: 0.1 }] : []
    )
    const pending = retrieveRelevantMemoriesStructured('q')
    await vi.advanceTimersByTimeAsync(60_000) // way past the foreground cap
    resolveEmbed(new Float32Array(384))
    expect(await pending).toHaveLength(1)
  })

  it('Sales Brain off or blank query short-circuits before touching anything', async () => {
    mocks.enabled = false
    expect(await retrieveRelevantMemoriesStructured('q')).toEqual([])
    mocks.enabled = true
    expect(await retrieveRelevantMemoriesStructured('   ')).toEqual([])
    expect(mocks.embed).not.toHaveBeenCalled()
  })
})

describe('retrieveRelevantMemories (legacy string shape)', () => {
  it('formats the structured results — same section header, confidence visible', async () => {
    mocks.search.mockImplementation((_d: unknown, _e: unknown, opts: { scope: string }) =>
      opts.scope === 'rep' ? [{ memory: mem('m1', 'Discovery calls run long'), distance: 0.1 }] : []
    )
    const text = await retrieveRelevantMemories('q', null)
    expect(text).toContain('--- MEMORIES RELEVANT TO THIS QUESTION (Sales Brain) ---')
    expect(text).toContain('- Discovery calls run long (confidence: 80%)')
  })

  it('returns the empty string when nothing crosses the bar', async () => {
    expect(await retrieveRelevantMemories('q', null)).toBe('')
  })
})
