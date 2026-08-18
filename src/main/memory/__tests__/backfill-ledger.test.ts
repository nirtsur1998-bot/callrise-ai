// M27 — the import remembers what it already tried, so a run cut short by an
// exhausted key resumes instead of restarting.
//
// The reported symptom: "it's only scanning 4 calls then stops every time."
// Not four calls of progress — ZERO. Every run rebuilt the list of 104 and
// started at index 0, the breaker stopped it three failures in, and the next
// run redid the identical four. Pressing the button was provably incapable of
// ever reaching call five.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openMemoryDb, memoryDbPath, migrate } from '../db'
import {
  attemptedCallIds,
  clearAttempts,
  recordAttempt,
  retryFailedAttempts
} from '../backfill-ledger'
import { MIGRATIONS } from '../migrations'

let dir: string
let db: Database.Database

/** A real SQLite file with the real migrations applied — not a hand-written
 *  CREATE TABLE. If migration 003 were missing or malformed, every test here
 *  would fail at setup rather than passing against a table only the test
 *  knows how to build. */
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'callrise-ledger-'))
  // openMemoryDb + migrate, exactly as production does — migration 001 needs
  // the sqlite-vec extension, so a bare `new Database()` cannot run it.
  db = openMemoryDb(memoryDbPath(dir))
  const res = await migrate(db, memoryDbPath(dir))
  if (!res.ok) throw new Error(`migrate failed: ${JSON.stringify(res)}`)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('the resume ledger', () => {
  it('reports nothing attempted on a fresh database', () => {
    expect(attemptedCallIds(db).size).toBe(0)
  })

  it('remembers every attempt, whatever its outcome', () => {
    recordAttempt(db, 'call-1', 'ok')
    recordAttempt(db, 'call-2', 'failed')
    recordAttempt(db, 'call-3', 'skipped')
    expect(attemptedCallIds(db)).toEqual(new Set(['call-1', 'call-2', 'call-3']))
  })

  // THE CENTRAL ONE. A call that yields zero memories is a legitimate result —
  // a voicemail, a two-line call. The cheaper design ("skip calls that already
  // have memories") would retry every one of those forever, burning the exact
  // quota this feature exists to protect. Keying on ATTEMPTED is what makes a
  // zero-yield call stay done.
  it('treats a call that produced nothing as done, not as never-tried', () => {
    recordAttempt(db, 'voicemail', 'ok') // ok, zero candidates — no memory rows anywhere
    expect(attemptedCallIds(db).has('voicemail')).toBe(true)
    retryFailedAttempts(db)
    expect(attemptedCallIds(db).has('voicemail')).toBe(true)
  })

  it('clears failures between runs so an exhausted key gets another chance', () => {
    recordAttempt(db, 'ok-call', 'ok')
    recordAttempt(db, 'rate-limited', 'failed')
    recordAttempt(db, 'no-transcript', 'skipped')

    expect(retryFailedAttempts(db)).toBe(1)

    const left = attemptedCallIds(db)
    expect(left.has('rate-limited')).toBe(false) // will be retried
    expect(left.has('ok-call')).toBe(true) // stays done
    // 'skipped' is a stable property of the call (no transcript, or excluded
    // from Sales Brain), not a transient condition — so it must NOT be retried
    // on every future run.
    expect(left.has('no-transcript')).toBe(true)
  })

  it('lets a retried call overwrite its earlier outcome instead of throwing', () => {
    recordAttempt(db, 'call-1', 'failed')
    expect(() => recordAttempt(db, 'call-1', 'ok')).not.toThrow()
    const row = db.prepare('SELECT outcome FROM backfill_attempts WHERE call_id = ?').get('call-1')
    expect(row).toEqual({ outcome: 'ok' })
  })

  it('wipes everything on an explicit re-scan', () => {
    recordAttempt(db, 'a', 'ok')
    recordAttempt(db, 'b', 'skipped')
    expect(clearAttempts(db)).toBe(2)
    expect(attemptedCallIds(db).size).toBe(0)
  })
})

describe('migration 003', () => {
  it('is additive — an existing database keeps every row it had', async () => {
    // The founder's standing rule: any storage change must be backward
    // compatible with what a shipped version already wrote on real machines.
    // Simulated properly — build a DB at the PREVIOUS schema, put data in it,
    // then apply only the new migration.
    const oldDir = mkdtempSync(join(tmpdir(), 'callrise-ledger-old-'))
    const old = openMemoryDb(memoryDbPath(oldDir))
    // BOTH fields — `overrides` is all-or-nothing, and passing only
    // targetVersion silently falls back to the full migration list, which
    // builds the NEW schema and makes this test prove nothing.
    const res = await migrate(old, memoryDbPath(oldDir), {
      migrations: MIGRATIONS.filter((x) => x.version <= 2),
      targetVersion: 2
    })
    if (!res.ok) throw new Error(`migrate to v2 failed: ${JSON.stringify(res)}`)
    old
      .prepare(
        "INSERT INTO memories (id, scope, category, statement, evidence, confidence, importance, status, source, created_at, last_confirmed_at) VALUES ('m1','self','style','pre-existing fact','[]',0.9,3,'active','call','t','t')"
      )
      .run()

    const before = old.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }
    const m003 = MIGRATIONS.find((x) => x.version === 3)
    expect(m003).toBeDefined()
    old.exec(m003!.sql)
    const after = old.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }

    expect(after.n).toBe(before.n)
    expect(before.n).toBe(1)
    expect(attemptedCallIds(old).size).toBe(0) // new table exists and is empty
    old.close()
    rmSync(oldDir, { recursive: true, force: true })
  })
})
