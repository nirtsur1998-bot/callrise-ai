// M27 C1 — the wrong-memory bug the founder saw with their own eyes.
//
// Contradiction detection only ever compared a new candidate against ACTIVE
// memories. But EVERY auto-extracted memory starts as a hypothesis, so two
// flatly contradictory statements — "don't chase this yet" and, later,
// "they're ready to move now" — were never compared at all. The similarity
// check correctly declines to merge them (they're opposites, not
// restatements), so both were simply stored, and both then fed the compiled
// profile and retrieval: the AI could be told both things about one client.
//
// These drive the REAL consolidateNewCandidate against a REAL SQLite DB —
// only the two AI judgment calls are mocked, and they're mocked to answer
// the way a competent model actually would for these statements (not the
// way that makes the test pass). Everything else — status transitions,
// invalidation links, episode counting — is genuine.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** The two AI judgments consolidateNewCandidate makes, controlled per-test.
 *  `sameFact` is asked first (is this a restatement?), `contradictsIndex`
 *  second (does it contradict one of these?). */
const ai = {
  sameFact: false,
  contradictsIndex: null as number | null,
  contradictionPrompts: [] as string[]
}

vi.mock('../../ai/complete-with-fallback', () => ({
  completeWithFallback: async (req: { tool?: { name?: string }; messages: Array<{ content: string }> }) => {
    if (req.tool?.name === 'judge_same_fact') return { toolInput: { sameFact: ai.sameFact } }
    ai.contradictionPrompts.push(req.messages[0].content)
    return { toolInput: { contradictsIndex: ai.contradictsIndex } }
  },
  AllModelsExhaustedError: class extends Error {}
}))

// Deterministic, unique-per-statement embeddings: every pair is far apart, so
// the vector pre-filter never short-circuits the contradiction path. That
// isolates what's under test — a merge-by-similarity would be a DIFFERENT
// (already-working) branch.
vi.mock('../embeddings', () => ({
  embedText: async (s: string) => {
    const v = new Float32Array(384)
    let h = 0
    for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0
    v[h % 384] = 1
    return v
  },
  EMBEDDING_DIMENSIONS: 384
}))

const { memoryDbPath, openMemoryDb, migrate } = await import('../db')
const { getMemoryById, listMemories } = await import('../memories-store')
const { consolidateNewCandidate } = await import('../consolidation')
type MemoryCandidate = import('../types').MemoryCandidate

let dir: string
let db: Database.Database

function candidate(statement: string, callIds: string[]): MemoryCandidate {
  return {
    scope: 'client:acme',
    category: 'client-fact',
    statement,
    evidence: callIds.map((callId) => ({ type: 'transcript', callId, quote: statement })),
    confidence: 0.9,
    importance: 7,
    source: 'auto'
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'callrise-c1-'))
  db = openMemoryDb(memoryDbPath(dir))
  await migrate(db, memoryDbPath(dir))
  ai.sameFact = false
  ai.contradictsIndex = null
  ai.contradictionPrompts = []
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

describe('M27 C1 — a hypothesis can now be contradicted, not just an active memory', () => {
  it('supersedes an older twice-seen hypothesis when a contradicting fact arrives', async () => {
    // The exact scenario: "don't chase yet" heard on two separate calls (so
    // it's a restated fact, not a one-off), then the situation genuinely
    // changes weeks later.
    const older = await consolidateNewCandidate(
      db,
      candidate("They don't want to be chased on this yet", ['call-1', 'call-2'])
    )
    expect(older).toBe('created')
    const olderId = listMemories(db, { scope: 'client:acme' })[0].id
    expect(getMemoryById(db, olderId)?.status).toBe('hypothesis') // never auto-trusted

    ai.contradictsIndex = 0 // the model recognises the reversal
    const newer = await consolidateNewCandidate(
      db,
      candidate('They are ready to move forward now', ['call-9'])
    )
    expect(newer).toBe('created')

    // The older one is SUPERSEDED, not deleted — it keeps its statement and
    // gains a forward link to whatever replaced it, so Memory Center can
    // still show it and explain why it stopped counting.
    const supersededOlder = getMemoryById(db, olderId)
    expect(supersededOlder).not.toBeNull()
    expect(supersededOlder?.status).toBe('invalidated')
    expect(supersededOlder?.statement).toBe("They don't want to be chased on this yet")

    const newerStored = listMemories(db, { scope: 'client:acme' }).find((m) => m.id !== olderId)
    expect(supersededOlder?.invalidatedBy).toBe(newerStored?.id)
    expect(newerStored?.status).toBe('hypothesis')
  })

  it('does NOT spend a contradiction check on a single-mention hypothesis', async () => {
    // The cost mitigation: one unconfirmed mention stays cheap and silent
    // until it earns a second episode. Asserted by the AI call NOT being
    // made at all, not merely by the outcome.
    await consolidateNewCandidate(db, candidate('Budget is around 40k', ['call-1']))
    expect(ai.contradictionPrompts).toEqual([])

    await consolidateNewCandidate(db, candidate('Budget is actually 90k', ['call-2']))
    // Still nothing to compare against: the only prior memory has one episode.
    expect(ai.contradictionPrompts).toEqual([])
    expect(listMemories(db, { scope: 'client:acme' })).toHaveLength(2)
  })

  it('includes a twice-seen hypothesis in the statements the model is shown', async () => {
    // Proves the widened query actually reaches the prompt, rather than the
    // outcome coincidentally matching.
    await consolidateNewCandidate(db, candidate('They want a Q3 start', ['call-1', 'call-2']))
    await consolidateNewCandidate(db, candidate('They want a Q4 start', ['call-3']))

    expect(ai.contradictionPrompts).toHaveLength(1)
    expect(ai.contradictionPrompts[0]).toContain('They want a Q3 start')
  })

  it('leaves both in place when the model says they do not contradict', async () => {
    // The check must not become "any two statements about one client fight."
    // Two genuinely compatible facts coexist exactly as before.
    await consolidateNewCandidate(db, candidate('They want a Q3 start', ['call-1', 'call-2']))
    ai.contradictsIndex = null
    await consolidateNewCandidate(db, candidate('Legal review takes two weeks', ['call-3']))

    const all = listMemories(db, { scope: 'client:acme' })
    expect(all).toHaveLength(2)
    expect(all.every((m) => m.status === 'hypothesis')).toBe(true)
  })

  it('still contradicts an ACTIVE memory exactly as before — unchanged behaviour', async () => {
    // Regression guard: widening the query must not have altered the case
    // that already worked.
    await consolidateNewCandidate(db, candidate('They want a Q3 start', ['call-1', 'call-2', 'call-3']))
    const first = listMemories(db, { scope: 'client:acme' })[0]
    // Force it active the way promotion would.
    const { promoteToActive } = await import('../memories-store')
    promoteToActive(db, first.id)
    expect(getMemoryById(db, first.id)?.status).toBe('active')

    ai.contradictsIndex = 0
    await consolidateNewCandidate(db, candidate('They pushed the start to next year', ['call-4']))
    expect(getMemoryById(db, first.id)?.status).toBe('invalidated')
  })
})
