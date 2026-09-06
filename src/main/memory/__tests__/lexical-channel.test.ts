// M36 Stage 3 item 2 — the lexical channel against a REAL database: FTS5
// (migration 5) beside sqlite-vec, through the real store and the real
// rag.ts fusion. The embedding step is stubbed with orthogonal unit vectors
// so every memory sits at L2 √2 ≈ 1.41 from every question — OVER rag.ts's
// 1.3 cut. That makes the vector channel blind by construction, which is
// exactly the proper-noun situation the harness measured (a name has no
// meaning to embed): anything retrieved here was retrieved by string.
//
// Red before the channel existed: searchMemoriesByText did not exist and
// retrieveRelevantMemoriesStructured('Who is Sam Okafor?') returned [].
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'

const runtime = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('../../app-settings', () => ({ isSalesBrainEnabled: () => true }))
vi.mock('../memory-runtime', () => ({
  getMemoryDb: () => runtime.db,
  ensureMemoryDb: async () => ({ db: runtime.db, detail: 'test' })
}))
vi.mock('../embeddings', () => ({ embedText: async () => unit(0) }))

import { openMemoryDb, migrate } from '../db'
import { MIGRATIONS } from '../migrations'
import { insertMemory, searchMemoriesByText, deleteMemory } from '../memories-store'
import { retrieveRelevantMemoriesStructured } from '../rag'
import type { MemoryCandidate, MemoryScope } from '../types'

function unit(axis: number): Float32Array {
  const v = new Float32Array(384)
  v[axis] = 1
  return v
}
function candidate(scope: MemoryScope, statement: string, source: MemoryCandidate['source'] = 'user_confirmed'): MemoryCandidate {
  return {
    scope,
    category: scope === 'rep' ? 'stated-goal' : scope === 'business' ? 'terminology' : 'client-fact',
    statement,
    evidence: [{ type: 'transcript', callId: 'c-1', quote: statement }],
    confidence: 0.9,
    importance: 5,
    source
  }
}

describe('lexical channel (real FTS5 + sqlite-vec)', () => {
  let dir: string
  let path: string
  let db: Database.Database
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lexical-'))
    path = join(dir, 'memory.db')
    db = openMemoryDb(path)
    const result = await migrate(db, path)
    if (!result.ok) throw new Error(JSON.stringify(result))
    runtime.db = db
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('finds a memory by a name in it, with its real vector distance; an unrelated scope and a longer name do not match', () => {
    insertMemory(db, candidate('client:eval-globex', 'Sam Okafor is the internal champion and reports to the COO'), unit(1))
    insertMemory(db, candidate('client:eval-acme', 'Priya Nandakumar wants the SOC 2 report by the end of Q1'), unit(2))
    const hits = searchMemoriesByText(db, ['okafor'], unit(0), { scope: 'client:eval-globex' })
    expect(hits.map((h) => h.memory.statement)).toEqual(['Sam Okafor is the internal champion and reports to the COO'])
    expect(hits[0].matchedTerms).toEqual(['okafor'])
    expect(hits[0].distance).toBeCloseTo(Math.SQRT2, 5) // orthogonal unit vectors: the TRUE L2, not a placeholder
    expect(hits[0].score).toBeLessThan(0) // bm25: lower is better, always negative
    // scope is a filter, not a hint
    expect(searchMemoriesByText(db, ['okafor'], unit(0), { scope: 'client:eval-acme' })).toEqual([])
    // "priya" is a whole token in the statement — found; "priyanka" is not — nothing (no prefix matching either way)
    expect(searchMemoriesByText(db, ['priya'], unit(0), { scope: 'client:eval-acme' })).toHaveLength(1)
    expect(searchMemoriesByText(db, ['priyanka'], unit(0), { scope: 'client:eval-acme' })).toEqual([])
    expect(searchMemoriesByText(db, ['pri'], unit(0), { scope: 'client:eval-acme' })).toEqual([])
    // no terms: nothing, and the db is not consulted
    expect(searchMemoriesByText(db, [], unit(0), { scope: 'client:eval-acme' })).toEqual([])
  })

  it('respects status like the vector channel: a hypothesis is invisible unless asked for', () => {
    insertMemory(db, candidate('rep', 'Bramwell Prep is the pre-call template', 'auto'), unit(1)) // auto → hypothesis
    expect(searchMemoriesByText(db, ['bramwell'], unit(0), { scope: 'rep' })).toEqual([])
    expect(searchMemoriesByText(db, ['bramwell'], unit(0), { scope: 'rep', statuses: ['active', 'hypothesis'] })).toHaveLength(1)
  })

  it('the index follows the row: a deleted memory stops matching', () => {
    const m = insertMemory(db, candidate('business', 'Support tickets live in Zendesk'), unit(1))
    expect(searchMemoriesByText(db, ['zendesk'], unit(0), { scope: 'business' })).toHaveLength(1)
    deleteMemory(db, m.id)
    expect(searchMemoriesByText(db, ['zendesk'], unit(0), { scope: 'business' })).toEqual([])
  })

  it('accent-insensitive, case-insensitive: "jose" finds "José"', () => {
    insertMemory(db, candidate('client:eval-acme', 'José Álvarez signs off on procurement'), unit(1))
    expect(searchMemoriesByText(db, ['jose', 'alvarez'], unit(0), { scope: 'client:eval-acme' })).toHaveLength(1)
  })

  it('an FTS5 operator or a quote in the question is a word, never syntax', () => {
    insertMemory(db, candidate('business', 'The NEAR programme is not a competitor'), unit(1))
    expect(searchMemoriesByText(db, ['near', 'not', 'a"b'], unit(0), { scope: 'business' })).toHaveLength(1)
  })

  it('END TO END through rag.ts: with the vector channel blind (every distance 1.41 > 1.3), "Who is Sam Okafor?" still finds him, by string, in the bound client only', async () => {
    insertMemory(db, candidate('client:eval-globex', 'Sam Okafor is the internal champion and reports to the COO'), unit(1))
    insertMemory(db, candidate('client:eval-globex', 'Wants a pilot phase before committing'), unit(2))
    insertMemory(db, candidate('client:eval-acme', 'Sam Okafor also advises Acme on the side'), unit(3))
    const results = await retrieveRelevantMemoriesStructured('Who is Sam Okafor?', { contactId: 'eval-globex' })
    expect(results.map((r) => r.memory.statement)).toEqual(['Sam Okafor is the internal champion and reports to the COO'])
    expect(results[0].via).toBe('lexical')
    expect(results[0].matchedTerms).toEqual(['sam', 'okafor'])
    expect(results[0].distance).toBeGreaterThan(1.3)
    // the control: the same name in a client this conversation is not bound to stays unreachable
    expect(results.some((r) => r.memory.scope === 'client:eval-acme')).toBe(false)
    // and a question naming nobody in the store gets nothing — the channel does not fire on "rollout"
    expect(await retrieveRelevantMemoriesStructured('What did Henrik say about the Oslo rollout?', { contactId: 'eval-globex' })).toEqual([])
  })

  it('MIGRATION BACKFILL: memories written before migration 5 are searchable by string the moment it runs', async () => {
    // a second file, frozen at version 4 — the shape every existing user's memory.db has today
    const oldPath = join(dir, 'old.db')
    const old = openMemoryDb(oldPath)
    const to4 = await migrate(old, oldPath, { migrations: MIGRATIONS.filter((m) => m.version <= 4), targetVersion: 4 })
    expect(to4).toMatchObject({ ok: true, toVersion: 4 })
    insertMemory(old, candidate('client:eval-globex', 'Sam Okafor is the internal champion'), unit(1))
    expect(old.prepare("SELECT name FROM sqlite_master WHERE name = 'memories_fts'").all()).toEqual([])

    const to5 = await migrate(old, oldPath)
    expect(to5).toMatchObject({ ok: true, migrated: true, fromVersion: 4, toVersion: 5 })
    expect(searchMemoriesByText(old, ['okafor'], unit(0), { scope: 'client:eval-globex' })).toHaveLength(1)
    old.close()
  })
})
