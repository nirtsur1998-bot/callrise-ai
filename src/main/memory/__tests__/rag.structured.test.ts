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
  ),
  // M36 Stage 3 item 2 — the lexical channel, quiet unless a test speaks.
  lexical: vi.fn(
    (
      _db: unknown,
      _terms: ReadonlyArray<string>,
      _embedding: unknown,
      _opts: { scope: string; limit: number; statuses: string[] }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) => [] as { memory: any; distance: number; score: number; matchedTerms: string[] }[]
  )
}))

vi.mock('../../app-settings', () => ({ isSalesBrainEnabled: () => mocks.enabled }))
vi.mock('../memory-runtime', () => ({
  getMemoryDb: () => mocks.db,
  ensureMemoryDb: mocks.ensured
}))
vi.mock('../embeddings', () => ({ embedText: mocks.embed }))
vi.mock('../memories-store', () => ({
  searchMemoriesByVector: mocks.search,
  searchMemoriesByText: mocks.lexical,
  touchRetrieved: vi.fn()
}))

import { fuseChannels, retrieveRelevantMemories, retrieveRelevantMemoriesStructured } from '../rag'

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
  mocks.lexical.mockReset()
  mocks.lexical.mockReturnValue([])
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

// M36 Stage 3 item 2 — the lexical channel, at the orchestration level. The
// real FTS5 behaviour (a name found by string, "Priyanka" not matching
// "Priya", scope respected, migration backfill) is proven against a real db
// in lexical-channel.test.ts; what THIS block pins is how rag.ts fuses the
// two channels and that the invariant covers both.
describe('lexical channel fusion', () => {
  const lex = (id: string, statement: string, distance: number, score: number, terms: string[], scope = 'rep') => ({
    memory: { ...mem(id, statement), scope: scope as Memory['scope'] },
    distance,
    score,
    matchedTerms: terms
  })

  it('a name the vector channel cannot see surfaces from the lexical channel, with its REAL distance and via: lexical', async () => {
    mocks.lexical.mockImplementation((_db, terms, _e, opts) =>
      opts.scope === 'client:c-globex' && terms.includes('okafor')
        ? [lex('okafor', 'Sam Okafor is the internal champion', 1.41, -1.2, ['okafor', 'sam'], 'client:c-globex')]
        : []
    )
    const results = await retrieveRelevantMemoriesStructured('Who is Sam Okafor?', { contactId: 'c-globex' })
    expect(results.map((r) => r.memory.id)).toEqual(['okafor'])
    expect(results[0].via).toBe('lexical')
    expect(results[0].distance).toBe(1.41) // over MAX_DISTANCE — exactly why the vector channel missed it
    expect(results[0].matchedTerms).toEqual(['okafor', 'sam'])
    // the terms handed to the store are the question minus its function words
    expect(mocks.lexical.mock.calls[0][1]).toEqual(['sam', 'okafor'])
  })

  it('a question made only of function words never touches the lexical channel', async () => {
    await retrieveRelevantMemoriesStructured('what is it?', { contactId: null })
    expect(mocks.lexical).not.toHaveBeenCalled()
    expect(mocks.search).toHaveBeenCalled()
  })

  it('the lexical channel searches exactly the scopes the vector channel does, and a cross-scope lexical result THROWS', async () => {
    mocks.lexical.mockImplementation((_db, _t, _e, opts) =>
      opts.scope === 'business' ? [lex('leak', 'Okafor at another client', 0.9, -1, ['okafor'], 'client:c-other')] : []
    )
    await expect(retrieveRelevantMemoriesStructured('Who is Okafor?', { contactId: 'c-1' })).rejects.toThrow(
      /cross-scope result refused: memory leak/
    )
    const scopes = mocks.lexical.mock.calls.map((c) => (c[3] as { scope: string }).scope)
    expect(scopes).toEqual(['rep', 'business', 'client:c-1'])
  })

  it('fuseChannels: agreement outranks either channel alone; ties break on distance; the cap holds', () => {
    const v = [
      { memory: mem('a', 'a'), distance: 0.5 },
      { memory: mem('b', 'b'), distance: 0.6 },
      { memory: mem('c', 'c'), distance: 0.7 }
    ]
    const l = [lex('b', 'b', 0.6, -2, ['x']), lex('d', 'd', 1.5, -1, ['x'])]
    const fused = fuseChannels(v, l, 3)
    // b: 1/62 + 1/61 (both) > a: 1/61 (vector #1) = d: 1/62 (lexical #2)... a beats d on rank; c: 1/63
    expect(fused.map((r) => `${r.memory.id}:${r.via}`)).toEqual(['b:both', 'a:vector', 'd:lexical'])
    expect(fused.find((r) => r.memory.id === 'b')?.matchedTerms).toEqual(['x'])
  })

  it('fuseChannels with an empty lexical list is exactly the old behaviour: by distance, capped', () => {
    const v = [
      { memory: mem('a', 'a'), distance: 0.5 },
      { memory: mem('b', 'b'), distance: 0.6 }
    ]
    expect(fuseChannels(v, [], 1).map((r) => r.memory.id)).toEqual(['a'])
    expect(fuseChannels(v, [], 5).every((r) => r.via === 'vector')).toBe(true)
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
