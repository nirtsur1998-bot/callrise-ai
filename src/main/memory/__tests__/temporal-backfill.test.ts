// M36 Stage 3 item 5, step 1 — the backfill, the founder's "risky step".
// A store built at schema version 5 (every existing user's shape) with rows
// written the old way, migrated to 6, then dated by the job against a calls
// store with some calls present and some gone. What is pinned:
//   - the SOURCE of every date (evidence call → 'call'; user's own words →
//     'stated'; nothing recoverable → learning time marked 'approx')
//   - the earliest of several evidence calls wins
//   - a superseded row closes at its superseder's valid_from with the
//     superseder's source, or at invalidated_at marked approx
//   - counts before (0 dated) and after, exactly
//   - the job runs once; a second call returns the record and changes nothing
//   - the insert rule for NEW rows (validityAtInsert)
// Red before the code: temporal-backfill.ts did not exist.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openMemoryDb, migrate } from '../db'
import { MIGRATIONS } from '../migrations'
import { getMemoryById, insertMemory, validityAtInsert } from '../memories-store'
import {
  describeTemporalBackfill,
  runTemporalBackfill,
  temporalBackfillRecord,
  TEMPORAL_BACKFILL_META_KEY
} from '../temporal-backfill'
import type { MemoryEvidence } from '../types'

const CALLS = new Map<string, string>([
  ['call-march', '2026-03-14T10:00:00.000Z'],
  ['call-feb', '2026-02-01T09:00:00.000Z'],
  ['call-july', '2026-07-02T15:30:00.000Z']
])

/** A row written the way every pre-migration-6 build wrote it: no validity
 *  columns exist yet, so this goes through raw SQL at schema version 5. */
function rawInsert(
  db: Database.Database,
  row: {
    id: string
    source: string
    createdAt: string
    evidence: MemoryEvidence[]
    status?: string
    invalidatedBy?: string
    invalidatedAt?: string
  }
): void {
  db.prepare(
    `INSERT INTO memories (id, scope, category, statement, evidence, confidence, importance, status, source, pinned, invalidated_by, created_at, last_confirmed_at, invalidated_at)
     VALUES (@id, 'rep', 'stated-goal', @statement, @evidence, 0.9, 5, @status, @source, 0, @invalidatedBy, @createdAt, @createdAt, @invalidatedAt)`
  ).run({
    id: row.id,
    statement: `fact ${row.id}`,
    evidence: JSON.stringify(row.evidence),
    status: row.status ?? 'active',
    source: row.source,
    invalidatedBy: row.invalidatedBy ?? null,
    createdAt: row.createdAt,
    invalidatedAt: row.invalidatedAt ?? null
  })
  const rowid = db.prepare('SELECT rowid_pk FROM memories WHERE id = ?').get(row.id) as { rowid_pk: number }
  db.prepare('INSERT INTO vec_memories(rowid, embedding) VALUES (?, ?)').run(
    BigInt(rowid.rowid_pk),
    Buffer.from(new Float32Array(384).buffer)
  )
}
const t = (callId: string): MemoryEvidence => ({ type: 'transcript', callId, quote: 'q' })

describe('temporal backfill (step 1)', () => {
  let dir: string
  let path: string
  let db: Database.Database
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'temporal-'))
    path = join(dir, 'memory.db')
    db = openMemoryDb(path)
    const to5 = await migrate(db, path, { migrations: MIGRATIONS.filter((m) => m.version <= 5), targetVersion: 5 })
    expect(to5).toMatchObject({ ok: true, toVersion: 5 })
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('dates every existing row from its evidence call, its own words, or — marked approximate — the learning time; measures before and after', async () => {
    // learned in September; the facts are older
    const learned = '2026-09-01T12:00:00.000Z'
    rawInsert(db, { id: 'from-call', source: 'auto', createdAt: learned, evidence: [t('call-march')] })
    rawInsert(db, { id: 'earliest-of-two', source: 'auto', createdAt: learned, evidence: [t('call-march'), t('call-feb')] })
    rawInsert(db, { id: 'call-gone', source: 'auto', createdAt: learned, evidence: [t('call-deleted-long-ago')] })
    rawInsert(db, { id: 'stated', source: 'user_stated', createdAt: learned, evidence: [t('onboarding:goals')] })
    rawInsert(db, { id: 'imported', source: 'user_confirmed', createdAt: learned, evidence: [t('backfill:contact:c1')] })
    // superseded in July by a fact learned from the July call; the old fact came from the March call
    rawInsert(db, { id: 'old-budget', source: 'auto', createdAt: '2026-03-15T00:00:00.000Z', evidence: [t('call-march')], status: 'invalidated', invalidatedBy: 'new-budget', invalidatedAt: '2026-07-03T00:00:00.000Z' })
    rawInsert(db, { id: 'new-budget', source: 'auto', createdAt: '2026-07-03T00:00:00.000Z', evidence: [t('call-july')] })
    // superseded, but the superseder is gone (deleted by the user) — only the learning time is left
    rawInsert(db, { id: 'orphan-old', source: 'auto', createdAt: '2026-04-01T00:00:00.000Z', evidence: [t('call-deleted-long-ago')], status: 'invalidated', invalidatedBy: 'deleted-superseder', invalidatedAt: '2026-05-05T00:00:00.000Z' })

    const to6 = await migrate(db, path)
    expect(to6).toMatchObject({ ok: true, fromVersion: 5, toVersion: 6 })
    expect(temporalBackfillRecord(db)).toBeNull()
    expect(db.prepare('SELECT COUNT(*) n FROM memories WHERE valid_from IS NOT NULL').get()).toEqual({ n: 0 })

    const counts = runTemporalBackfill(db, CALLS)

    // the source of every date
    expect(getMemoryById(db, 'from-call')).toMatchObject({ validFrom: '2026-03-14T10:00:00.000Z', validFromSource: 'call' })
    expect(getMemoryById(db, 'earliest-of-two')).toMatchObject({ validFrom: '2026-02-01T09:00:00.000Z', validFromSource: 'call' })
    expect(getMemoryById(db, 'call-gone')).toMatchObject({ validFrom: learned, validFromSource: 'approx' })
    expect(getMemoryById(db, 'stated')).toMatchObject({ validFrom: learned, validFromSource: 'stated' })
    expect(getMemoryById(db, 'imported')).toMatchObject({ validFrom: learned, validFromSource: 'stated' })
    // a superseded fact closes when the NEW fact became true (the July call), not when we noticed (July 3rd)
    expect(getMemoryById(db, 'old-budget')).toMatchObject({
      validFrom: '2026-03-14T10:00:00.000Z',
      validFromSource: 'call',
      validUntil: '2026-07-02T15:30:00.000Z',
      validUntilSource: 'call'
    })
    expect(getMemoryById(db, 'new-budget')).toMatchObject({ validFrom: '2026-07-02T15:30:00.000Z', validUntil: undefined })
    expect(getMemoryById(db, 'orphan-old')).toMatchObject({ validUntil: '2026-05-05T00:00:00.000Z', validUntilSource: 'approx' })

    // the counts, exactly
    expect(counts).toMatchObject({
      total: 8,
      datedBefore: 0,
      validFrom: { call: 4, stated: 2, approx: 2 },
      validUntil: { call: 1, stated: 0, approx: 1, none: 0 },
      callsReferenced: 6, // march, feb, july, the deleted one, onboarding:goals, backfill:contact:c1
      callsResolved: 3
    })
    expect(db.prepare('SELECT COUNT(*) n FROM memories WHERE valid_from IS NULL').get()).toEqual({ n: 0 })
    expect(temporalBackfillRecord(db)).toMatchObject({ total: 8 })
    expect(db.prepare('SELECT key FROM memory_meta').all()).toEqual([{ key: TEMPORAL_BACKFILL_META_KEY }])
    expect(describeTemporalBackfill(counts)).toContain('4 from evidence calls (real), 2 user-stated (exact), 2 from learning time (APPROXIMATE)')
  })

  it('runs once: the second call returns the record and touches no row', async () => {
    rawInsert(db, { id: 'a', source: 'auto', createdAt: '2026-09-01T00:00:00.000Z', evidence: [t('call-march')] })
    await migrate(db, path)
    const first = runTemporalBackfill(db, CALLS)
    // a later hand edit must survive a re-run
    db.prepare("UPDATE memories SET valid_from = '2025-01-01T00:00:00.000Z' WHERE id = 'a'").run()
    const second = runTemporalBackfill(db, new Map())
    expect(second).toEqual(first)
    expect(getMemoryById(db, 'a')?.validFrom).toBe('2025-01-01T00:00:00.000Z')
  })

  it('a row inserted AFTER migration 6 is born dated and is counted as "dated before" by a later backfill', async () => {
    await migrate(db, path)
    const m = insertMemory(
      db,
      { scope: 'rep', category: 'stated-goal', statement: 'born dated', evidence: [{ type: 'transcript', callId: 'call-march', quote: 'q', at: '2026-03-14T10:00:00.000Z' }], confidence: 0.9, importance: 5, source: 'auto' },
      new Float32Array(384)
    )
    expect(getMemoryById(db, m.id)).toMatchObject({ validFrom: '2026-03-14T10:00:00.000Z', validFromSource: 'call' })
    const counts = runTemporalBackfill(db, CALLS)
    expect(counts).toMatchObject({ total: 1, datedBefore: 1, validFrom: { call: 0, stated: 0, approx: 0 } })
  })
})

describe('validityAtInsert — the rule a new memory is born with', () => {
  const now = '2026-09-06T08:00:00.000Z'
  it('earliest evidence event time wins → call', () => {
    expect(
      validityAtInsert(
        { source: 'auto', evidence: [{ type: 'transcript', callId: 'x', quote: 'q', at: '2026-05-01T00:00:00.000Z' }, { type: 'transcript', callId: 'y', quote: 'q', at: '2026-04-01T00:00:00.000Z' }] },
        now
      )
    ).toEqual({ validFrom: '2026-04-01T00:00:00.000Z', validFromSource: 'call' })
  })
  it('no event time, user said it → stated, at the learning moment', () => {
    expect(validityAtInsert({ source: 'user_stated', evidence: [{ type: 'transcript', callId: 'onboarding:x', quote: 'q' }] }, now)).toEqual({ validFrom: now, validFromSource: 'stated' })
    expect(validityAtInsert({ source: 'user_confirmed', evidence: [] }, now)).toEqual({ validFrom: now, validFromSource: 'stated' })
  })
  it('no event time, extracted → approx, never silently a date', () => {
    expect(validityAtInsert({ source: 'auto', evidence: [{ type: 'transcript', callId: 'x', quote: 'q' }] }, now)).toEqual({ validFrom: now, validFromSource: 'approx' })
    expect(validityAtInsert({ source: 'auto', evidence: [{ type: 'transcript', callId: 'x', quote: 'q', at: 'not a date' }] }, now)).toEqual({ validFrom: now, validFromSource: 'approx' })
  })
})
