// M36 Stage 3 item 5, step 2 — the window closes when the NEW fact became
// true; historical rows leave the decay loop; a skipped backfill is a
// distinct record. Real db, real consolidation, AI judged by a stub.
//
// The founder's two holds for this step, pinned here:
//   1. the decay exclusion, with its reason IN THE CODE (consolidation.ts,
//      decayMemories) — this file proves the guard fires for an ACTIVE row
//      whose window is closed, independent of the 'invalidated' status that
//      today keeps such rows out of the loop anyway;
//   2. the contradiction path takes the date from the superseder's own
//      evidence `at` (stamped by the caller) — the memory db never reaches
//      into the calls store. Proven by the absence of any calls-store mock:
//      nothing here can read a call, and the July date still arrives.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ai = { contradictsIndex: null as number | null }
vi.mock('../../ai/complete-with-fallback', () => ({
  completeWithFallback: async (req: { tool?: { name?: string } }) => {
    if (req.tool?.name === 'judge_same_fact') return { toolInput: { sameFact: false } }
    return { toolInput: { contradictsIndex: ai.contradictsIndex } }
  },
  AllModelsExhaustedError: class extends Error {}
}))
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
const { getMemoryById, insertMemory, listMemories, promoteToActive, setValidity } = await import('../memories-store')
const { consolidateNewCandidate, decayMemories } = await import('../consolidation')
const { recordTemporalBackfillSkipped, runTemporalBackfill, temporalBackfillRecord, describeTemporalBackfill } =
  await import('../temporal-backfill')
type MemoryCandidate = import('../types').MemoryCandidate

const MARCH = '2026-03-14T10:00:00.000Z'
const JULY = '2026-07-02T15:30:00.000Z'

function fact(statement: string, at?: string, source: MemoryCandidate['source'] = 'auto'): MemoryCandidate {
  return {
    scope: 'client:c-acme',
    category: 'client-fact',
    statement,
    evidence: [{ type: 'transcript', callId: at === JULY ? 'call-july' : 'call-march', quote: statement, ...(at ? { at } : {}) }],
    confidence: 0.9,
    importance: 6,
    source
  }
}

let dir: string
let db: Database.Database
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'temporal-step2-'))
  const path = memoryDbPath(dir)
  db = openMemoryDb(path)
  await migrate(db, path)
  ai.contradictsIndex = null
})
afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

describe('step 2 — a contradiction closes the old window at the NEW fact\'s event time', () => {
  it('learned in September from a July call: the March fact closes in July, not today', async () => {
    // user-confirmed so it is ACTIVE (a lone hypothesis is not eligible for
    // contradiction — CONTRADICTION_MIN_EPISODES_FOR_HYPOTHESIS); the event
    // time on its evidence still wins over the "stated" moment
    await consolidateNewCandidate(db, fact('Budget ceiling is around 40000 dollars', MARCH, 'user_confirmed'))
    const [old] = listMemories(db, { scope: 'client:c-acme' })
    expect(old).toMatchObject({ status: 'active', validFrom: MARCH, validFromSource: 'call', validUntil: undefined })

    ai.contradictsIndex = 0
    await consolidateNewCandidate(db, fact('Budget ceiling was raised to 55000 dollars', JULY))

    const closed = getMemoryById(db, old.id)
    expect(closed?.status).toBe('invalidated')
    expect(closed?.validUntil).toBe(JULY)
    expect(closed?.validUntilSource).toBe('call')
    // system time still says when we NOTICED — today, months after July
    expect(Date.parse(closed!.invalidatedAt!)).toBeGreaterThan(Date.parse(JULY) + 30 * 24 * 3600 * 1000)
    const replacement = getMemoryById(db, closed!.invalidatedBy!)
    expect(replacement).toMatchObject({ validFrom: JULY, validFromSource: 'call', validUntil: undefined })
  })

  it('a superseder with no event time closes the window at the learning moment, MARKED approximate', async () => {
    await consolidateNewCandidate(db, fact('Decision maker is Dana Levy', MARCH, 'user_confirmed'))
    const [old] = listMemories(db, { scope: 'client:c-acme' })
    ai.contradictsIndex = 0
    await consolidateNewCandidate(db, fact('Decision maker is now Priya Nandakumar')) // no `at`
    const closed = getMemoryById(db, old.id)
    const replacement = getMemoryById(db, closed!.invalidatedBy!)
    expect(replacement?.validFromSource).toBe('approx')
    expect(closed?.validUntil).toBe(replacement?.validFrom)
    expect(closed?.validUntilSource).toBe('approx')
  })
})

describe('step 2 — DECAY NEVER ARCHIVES A CLOSED WINDOW (the guard in decayMemories)', () => {
  it('an active row whose valid_until is set survives the decay that archives its twin', () => {
    const embedding = (seed: number) => {
      const v = new Float32Array(384)
      v[seed] = 1
      return v
    }
    const cand = (s: string): MemoryCandidate => ({
      scope: 'rep',
      category: 'selling-pattern',
      statement: s,
      evidence: [{ type: 'transcript', callId: 'c-1', quote: s }],
      confidence: 0.8,
      importance: 5,
      source: 'auto'
    })
    const historical = insertMemory(db, cand('Ran discovery long, true from March to July'), embedding(1))
    const stale = insertMemory(db, cand('Ran discovery long, never reconfirmed'), embedding(2))
    db.prepare('UPDATE memories SET last_confirmed_at = ? WHERE id IN (?, ?)').run('2020-01-01T00:00:00.000Z', historical.id, stale.id)
    // a closed window on an ACTIVE, auto-sourced row (so it is not exempt for
    // any other reason) — the shape a parsed expiry will create
    promoteToActive(db, historical.id)
    setValidity(db, historical.id, { validUntil: JULY, validUntilSource: 'call' })
    expect(getMemoryById(db, historical.id)?.status).toBe('active')

    decayMemories(db, 'rep')

    expect(getMemoryById(db, stale.id)?.status, 'the live-but-neglected twin: archived, as before').toBe('archived')
    expect(getMemoryById(db, historical.id)?.status, 'historical: untouched').toBe('active')
    expect(getMemoryById(db, historical.id)?.confidence).toBe(0.8)
  })
})

describe('step 2 — a skipped backfill is a distinct record, and never blocks the run', () => {
  it('skipped → recorded as skipped; the next run replaces it with a real record; a real record is never overwritten by a skip', () => {
    expect(temporalBackfillRecord(db)).toBeNull()
    recordTemporalBackfillSkipped(db, 'connection replaced during startup')
    const skip = temporalBackfillRecord(db)
    expect(skip).toMatchObject({ status: 'skipped', reason: 'connection replaced during startup' })
    expect(describeTemporalBackfill(skip!)).toContain('SKIPPED')

    const ran = runTemporalBackfill(db, new Map())
    expect(ran).toMatchObject({ status: 'ran', total: 0 }) // a store with nothing in it RAN — that is not a skip
    expect(temporalBackfillRecord(db)).toMatchObject({ status: 'ran' })

    recordTemporalBackfillSkipped(db, 'late skip must not clobber a run')
    expect(temporalBackfillRecord(db)).toMatchObject({ status: 'ran' })
  })
})
