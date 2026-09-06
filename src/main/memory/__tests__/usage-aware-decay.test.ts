// M36 Stage 3, item 4 — usage-aware decay (the founder's decision, 2026-09-06:
// "a fact retrieved every week decaying like one never touched is wrong").
// The measurement on the longitudinal fixture, written BEFORE the column:
// two facts confirmed on the same day years ago; one is retrieved every
// week (touched by the retriever), the other never. After the nightly decay
// the untouched one is archived and the retrieved one is still standing.
// Before the change this file cannot import touchRetrieved — that is the red.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openMemoryDb, migrate } from '../db'
import { insertMemory, getMemoryById, touchRetrieved } from '../memories-store'
import { decayMemories, decayAnchor } from '../consolidation'
import type { MemoryCandidate } from '../types'

function candidate(statement: string): MemoryCandidate {
  return {
    scope: 'rep',
    category: 'selling-pattern',
    statement,
    evidence: [{ type: 'transcript', callId: 'c-1', quote: statement }],
    confidence: 0.8,
    importance: 5,
    source: 'auto'
  }
}
function embedding(seed: number): Float32Array {
  const v = new Float32Array(384)
  v[seed % 384] = 1
  return v
}

describe('usage-aware decay', () => {
  let dir: string
  let db: Database.Database
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'decay-'))
    const path = join(dir, 'memory.db')
    db = openMemoryDb(path)
    await migrate(db, path)
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('the decay clock runs from the LATER of confirmed and retrieved', () => {
    expect(decayAnchor('2020-01-01T00:00:00.000Z', null)).toBe('2020-01-01T00:00:00.000Z')
    expect(decayAnchor('2020-01-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')).toBe('2026-09-01T00:00:00.000Z')
    expect(decayAnchor('2026-09-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')).toBe('2026-09-01T00:00:00.000Z')
  })

  it('a fact retrieved last week survives the nightly decay that archives its never-retrieved twin', () => {
    const touched = insertMemory(db, candidate('Retrieved every week'), embedding(1))
    const untouched = insertMemory(db, candidate('Never retrieved'), embedding(2))
    // both confirmed years ago — the same starting point
    db.prepare('UPDATE memories SET last_confirmed_at = ? WHERE id IN (?, ?)').run('2020-01-01T00:00:00.000Z', touched.id, untouched.id)
    // the retriever surfaced one of them a week ago
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
    touchRetrieved(db, [touched.id], weekAgo)
    expect(getMemoryById(db, touched.id)?.lastRetrievedAt).toBe(weekAgo)

    decayMemories(db, 'rep')

    expect(getMemoryById(db, untouched.id)?.status, 'never retrieved: archived, as before').toBe('archived')
    expect(getMemoryById(db, touched.id)?.status, 'retrieved last week: still standing').not.toBe('archived')
    expect(getMemoryById(db, touched.id)?.confidence).toBe(0.8) // inside the grace period from the touch
  })

  it('touching is idempotent and only moves forward', () => {
    const m = insertMemory(db, candidate('Touched twice'), embedding(3))
    touchRetrieved(db, [m.id], '2026-09-06T10:00:00.000Z')
    touchRetrieved(db, [m.id], '2026-09-05T10:00:00.000Z') // an older touch must not rewind it
    expect(getMemoryById(db, m.id)?.lastRetrievedAt).toBe('2026-09-06T10:00:00.000Z')
    touchRetrieved(db, [], '2026-09-07T10:00:00.000Z') // no ids: no-op, no throw
  })
})
