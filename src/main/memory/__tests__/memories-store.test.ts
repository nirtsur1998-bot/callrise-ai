import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { memoryDbPath, openMemoryDb, migrate } from '../db'
import {
  insertMemory,
  getMemoryById,
  listMemories,
  searchMemoriesByVector,
  reinforceMemory,
  updateMemoryStatement,
  setMemoryPinned,
  deleteMemory,
  forgetEverything,
  listMemoriesByCallId,
  buildChangelog
} from '../memories-store'
import type { MemoryCandidate, MemoryEvidence } from '../types'

function transcriptEvidence(callId: string, quote: string): MemoryEvidence {
  return { type: 'transcript', callId, quote }
}

let dir: string
let db: Database.Database

function embedding(seed: number): Float32Array {
  // Deterministic, cheap fake embeddings for tests — no reason to load the
  // real ~23MB model just to prove the DB round-trips vectors correctly.
  // Distinct seeds produce distinct (orthogonal-ish) vectors so nearest-
  // neighbor ordering is meaningful and predictable.
  const v = new Float32Array(384)
  v[seed % 384] = 1
  return v
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'callrise-memories-store-'))
  db = openMemoryDb(memoryDbPath(dir))
  await migrate(db, memoryDbPath(dir))
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

function candidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    scope: 'rep',
    category: 'stated-struggle',
    statement: 'Struggles when competitors are brought up mid-call',
    evidence: [transcriptEvidence('call-1', 'they bring up competitors and it throws me off')],
    confidence: 0.9,
    importance: 6,
    source: 'auto',
    ...overrides
  }
}

describe('insertMemory + getMemoryById', () => {
  it('round-trips a memory and its embedding atomically', () => {
    const memory = insertMemory(db, candidate(), embedding(1))
    expect(memory.id).toBeTruthy()
    expect(memory.status).toBe('hypothesis') // auto-sourced starts as hypothesis

    const fetched = getMemoryById(db, memory.id)
    expect(fetched).toEqual(memory)
  })

  it('a user_stated candidate starts as active immediately, not hypothesis', () => {
    const memory = insertMemory(db, candidate({ source: 'user_stated' }), embedding(2))
    expect(memory.status).toBe('active')
  })

  it('preserves evidence as a real array, round-tripped through JSON storage', () => {
    const memory = insertMemory(
      db,
      candidate({ evidence: [transcriptEvidence('call-1', 'a'), transcriptEvidence('call-2', 'b')] }),
      embedding(3)
    )
    const fetched = getMemoryById(db, memory.id)
    expect(fetched?.evidence).toHaveLength(2)
  })
})

describe('listMemories', () => {
  it('filters by scope, status, and category', () => {
    insertMemory(db, candidate({ scope: 'rep', category: 'stated-struggle' }), embedding(1))
    insertMemory(db, candidate({ scope: 'business', category: 'pricing-model', statement: 'Charges per-seat' }), embedding(2))
    insertMemory(
      db,
      candidate({ scope: 'client:c1', category: 'client-fact', statement: 'Uses Salesforce' }),
      embedding(3)
    )

    expect(listMemories(db, { scope: 'rep' })).toHaveLength(1)
    expect(listMemories(db, { scope: 'business' })).toHaveLength(1)
    expect(listMemories(db, { scope: 'client:c1' })).toHaveLength(1)
    expect(listMemories(db, { category: 'pricing-model' })).toHaveLength(1)
    expect(listMemories(db)).toHaveLength(3)
  })

  it('a fresh auto-inserted memory never shows up under an "active" filter', () => {
    insertMemory(db, candidate(), embedding(1))
    expect(listMemories(db, { status: 'active' })).toHaveLength(0)
    expect(listMemories(db, { status: 'hypothesis' })).toHaveLength(1)
  })
})

describe('searchMemoriesByVector', () => {
  it('returns the nearest neighbor first, and only active memories', () => {
    const active = insertMemory(db, candidate({ source: 'user_stated', statement: 'A' }), embedding(0))
    const hypothesis = insertMemory(db, candidate({ source: 'auto', statement: 'B' }), embedding(1))
    void hypothesis

    const results = searchMemoriesByVector(db, embedding(0), { limit: 5 })
    // Only the user_stated (active) one should ever surface — the
    // hypothesis-status one must never be asserted (spec section 5).
    expect(results).toHaveLength(1)
    expect(results[0].memory.id).toBe(active.id)
    expect(results[0].distance).toBe(0)
  })

  it('respects a scope filter', () => {
    insertMemory(db, candidate({ scope: 'rep', source: 'user_stated' }), embedding(5))
    insertMemory(
      db,
      candidate({ scope: 'business', category: 'pricing-model', statement: 'X', source: 'user_stated' }),
      embedding(5)
    )
    const results = searchMemoriesByVector(db, embedding(5), { scope: 'rep' })
    // M27 G — the length assertion is load-bearing, not decoration:
    // `[].every(...)` is trivially true in JavaScript, so without it this
    // passed just as happily if the filter returned NOTHING (taxonomy
    // species 6, the vacuous universal quantifier). Pinning the exact count
    // also proves the other-scope memory was genuinely excluded, rather than
    // "everything that came back happens to be rep-scoped".
    expect(results).toHaveLength(1)
    expect(results.every((r) => r.memory.scope === 'rep')).toBe(true)
  })
})

describe('reinforceMemory', () => {
  it('appends evidence and refreshes last_confirmed_at without touching the original statement', () => {
    const memory = insertMemory(db, candidate(), embedding(1))
    const updated = reinforceMemory(db, memory.id, transcriptEvidence('call-2', 'confirmed again'))
    expect(updated?.evidence).toHaveLength(2)
    expect(updated?.statement).toBe(memory.statement)
    expect(new Date(updated!.lastConfirmedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(memory.lastConfirmedAt).getTime()
    )
  })

  it('returns null for a memory that does not exist', () => {
    expect(reinforceMemory(db, 'nonexistent', transcriptEvidence('x', 'y'))).toBeNull()
  })
})

describe('updateMemoryStatement (Memory Center rep edit)', () => {
  it('rewrites the statement and treats the edit as a full confirmation (active, confidence 1)', () => {
    const memory = insertMemory(db, candidate({ confidence: 0.3 }), embedding(1))
    const updated = updateMemoryStatement(db, memory.id, 'A corrected statement', embedding(9))
    expect(updated?.statement).toBe('A corrected statement')
    expect(updated?.status).toBe('active')
    expect(updated?.confidence).toBe(1)

    const reread = getMemoryById(db, memory.id)
    expect(reread?.statement).toBe('A corrected statement')
  })

  it('the new embedding actually takes effect for vector search', () => {
    const memory = insertMemory(db, candidate({ source: 'user_stated' }), embedding(1))
    updateMemoryStatement(db, memory.id, 'Something else entirely', embedding(50))
    const results = searchMemoriesByVector(db, embedding(50), { scope: 'rep' })
    expect(results[0]?.memory.id).toBe(memory.id)
    expect(results[0]?.distance).toBe(0)
  })

  it('returns null for a memory that does not exist', () => {
    expect(updateMemoryStatement(db, 'nonexistent', 'x', embedding(1))).toBeNull()
  })
})

describe('setMemoryPinned', () => {
  it('toggles pinned on and off', () => {
    const memory = insertMemory(db, candidate(), embedding(1))
    expect(memory.pinned).toBe(false)
    setMemoryPinned(db, memory.id, true)
    expect(getMemoryById(db, memory.id)?.pinned).toBe(true)
    setMemoryPinned(db, memory.id, false)
    expect(getMemoryById(db, memory.id)?.pinned).toBe(false)
  })
})

describe('deleteMemory', () => {
  it('removes the memory and its embedding atomically, never leaving an orphan vector row', () => {
    const memory = insertMemory(db, candidate({ source: 'user_stated' }), embedding(1))
    expect(deleteMemory(db, memory.id)).toBe(true)
    expect(getMemoryById(db, memory.id)).toBeNull()
    // No orphaned vec_memories row left behind — a search that would have
    // matched it returns nothing.
    expect(searchMemoriesByVector(db, embedding(1), { scope: 'rep' })).toHaveLength(0)
  })

  it('returns false for a memory that does not exist', () => {
    expect(deleteMemory(db, 'nonexistent')).toBe(false)
  })
})

describe('forgetEverything', () => {
  it('wipes every memory across every scope, and any compiled profile', () => {
    insertMemory(db, candidate({ scope: 'rep' }), embedding(1))
    insertMemory(db, candidate({ scope: 'business', category: 'pricing-model', statement: 'X' }), embedding(2))
    insertMemory(db, candidate({ scope: 'client:c1', category: 'client-fact', statement: 'Y' }), embedding(3))
    expect(listMemories(db)).toHaveLength(3)

    forgetEverything(db)

    expect(listMemories(db)).toHaveLength(0)
    expect(db.prepare('SELECT COUNT(*) as n FROM vec_memories').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) as n FROM compiled_profiles').get()).toEqual({ n: 0 })
  })
})

describe('listMemoriesByCallId (post-call review)', () => {
  it('finds only memories whose evidence references the given call', () => {
    insertMemory(db, candidate({ evidence: [transcriptEvidence('call-A', 'x')] }), embedding(1))
    insertMemory(
      db,
      candidate({ statement: 'Other', evidence: [transcriptEvidence('call-B', 'y')] }),
      embedding(2)
    )
    const results = listMemoriesByCallId(db, 'call-A')
    expect(results).toHaveLength(1)
    expect(results[0].evidence.some((e) => e.type === 'transcript' && e.callId === 'call-A')).toBe(true)
  })

  it('returns an empty array when nothing references that call', () => {
    expect(listMemoriesByCallId(db, 'nonexistent-call')).toHaveLength(0)
  })
})

describe('buildChangelog', () => {
  it('includes a "created" entry for every memory', () => {
    insertMemory(db, candidate(), embedding(1))
    const log = buildChangelog(db)
    expect(log.some((e) => e.kind === 'created')).toBe(true)
  })

  it('includes a "reinforced" entry only when last_confirmed_at actually moved past created_at', () => {
    const memory = insertMemory(db, candidate(), embedding(1))
    expect(buildChangelog(db).filter((e) => e.memoryId === memory.id)).toHaveLength(1) // just 'created'

    reinforceMemory(db, memory.id, transcriptEvidence('call-2', 'again'))
    const afterReinforce = buildChangelog(db).filter((e) => e.memoryId === memory.id)
    expect(afterReinforce.some((e) => e.kind === 'reinforced')).toBe(true)
  })

  it('respects a scope filter', () => {
    insertMemory(db, candidate({ scope: 'rep' }), embedding(1))
    insertMemory(db, candidate({ scope: 'business', category: 'pricing-model', statement: 'X' }), embedding(2))
    const log = buildChangelog(db, 'rep')
    // M27 G — see the identical note in searchMemoriesByVector's scope-filter
    // test above: `[].every(...)` is trivially true, so a filter that
    // returned nothing at all would have passed this unchanged.
    expect(log.length).toBeGreaterThan(0)
    expect(log.every((e) => e.scope === 'rep')).toBe(true)
  })
})
