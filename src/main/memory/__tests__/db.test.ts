import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { memoryDbPath, openMemoryDb, migrate } from '../db'
import { MIGRATIONS, LATEST_SCHEMA_VERSION, type Migration } from '../migrations'

let dir: string
let dbPath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'callrise-memory-db-'))
  dbPath = memoryDbPath(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('migrate — the migration drill', () => {
  it('migrates a brand-new file from version 0 to the latest schema', async () => {
    const db = openMemoryDb(dbPath)
    const result = await migrate(db, dbPath)
    expect(result).toEqual({ ok: true, migrated: true, fromVersion: 0, toVersion: LATEST_SCHEMA_VERSION })

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'")
      .all()
    expect(tables).toHaveLength(1)
    db.close()
  })

  it('is a fast no-op on an already-migrated file, and never writes a backup for it', async () => {
    const db = openMemoryDb(dbPath)
    await migrate(db, dbPath)

    const result = await migrate(db, dbPath)
    expect(result).toEqual({
      ok: true,
      migrated: false,
      fromVersion: LATEST_SCHEMA_VERSION,
      toVersion: LATEST_SCHEMA_VERSION
    })
    expect(existsSync(`${dbPath}.pre-migration-backup`)).toBe(false)
    db.close()
  })

  it('refuses to touch a file whose version is NEWER than this app knows about', async () => {
    const db = openMemoryDb(dbPath)
    await migrate(db, dbPath)
    // Simulate "a future app version already upgraded this file" by hand-
    // bumping user_version past what MIGRATIONS actually defines.
    db.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 1}`)

    const result = await migrate(db, dbPath)
    expect(result).toEqual({
      ok: false,
      reason: 'newer-than-app',
      fileVersion: LATEST_SCHEMA_VERSION + 1,
      appVersion: LATEST_SCHEMA_VERSION
    })
    // Refusing to touch it means the file's version must be untouched too.
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION + 1)
    db.close()
  })

  it('a failed migration leaves prior data completely intact — the real safety guarantee', async () => {
    // Step 1: get to a real, populated database at exactly v1 — pinned via
    // an override (not the real MIGRATIONS/LATEST_SCHEMA_VERSION) so this
    // drill's premise ("start at some known-good version, then a LATER
    // migration breaks") stays valid regardless of how many real migrations
    // exist by the time this test runs.
    let db = openMemoryDb(dbPath)
    await migrate(db, dbPath, { migrations: [MIGRATIONS[0]], targetVersion: 1 })
    db.exec(
      `INSERT INTO memories (id, scope, category, statement, evidence, confidence, importance, source, created_at, last_confirmed_at)
       VALUES ('mem-1', 'rep', 'selling-pattern', 'Talks fast when nervous', '[]', 0.8, 5, 'auto', '2026-01-01', '2026-01-01')`
    )
    const before = db.prepare('SELECT * FROM memories').all()
    expect(before).toHaveLength(1)
    db.close()

    // Step 2: reopen and attempt to migrate to a deliberately-broken v2 —
    // this is the actual migration-failure path, not a mock of it.
    db = openMemoryDb(dbPath)
    const brokenMigrations: Migration[] = [
      MIGRATIONS[0],
      { version: 2, description: 'deliberately broken for the drill', sql: 'THIS IS NOT VALID SQL;' }
    ]
    const result = await migrate(db, dbPath, { migrations: brokenMigrations, targetVersion: 2 })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('migration-failed')
    }

    // Step 3: the pre-migration backup must exist (proves the backup step
    // ran before the broken migration was attempted).
    expect(existsSync(`${dbPath}.pre-migration-backup`)).toBe(true)

    // Step 4: reopen the ACTUAL file on disk (not the closed handle) and
    // confirm the schema is still v1, and the data from Step 1 is still
    // there — this is the real "no data loss, no brick" proof, not a
    // reasoning-about-the-code claim.
    const reopened = new Database(dbPath)
    expect(reopened.pragma('user_version', { simple: true })).toBe(1)
    const after = reopened.prepare('SELECT * FROM memories').all()
    expect(after).toEqual(before)
    reopened.close()
  })

  it('skips the backup step for a fresh (version-0) file with nothing to protect', async () => {
    const db = openMemoryDb(dbPath)
    const brokenMigrations: Migration[] = [
      { version: 1, description: 'deliberately broken for the drill', sql: 'THIS IS NOT VALID SQL;' }
    ]
    const result = await migrate(db, dbPath, { migrations: brokenMigrations, targetVersion: 1 })

    expect(result.ok).toBe(false)
    // No prior data existed, so there is genuinely nothing a backup would
    // have protected — this asserts the "skip pointless backups" behavior
    // rather than just leaving it unverified.
    expect(existsSync(`${dbPath}.pre-migration-backup`)).toBe(false)
  })
})
