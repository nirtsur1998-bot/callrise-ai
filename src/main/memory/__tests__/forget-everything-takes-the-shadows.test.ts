// BUG-206 — "Forget EVERYTHING Sales Brain has learned" has to mean the copies
// beside the live database too.
//
// It emptied three tables and left complete copies of all of them on the same
// disk, and the app was willing to put one of them back by itself.
// `memory.db.pre-migration-backup` is written before EVERY schema migration of
// a non-empty store, is never cleaned up afterwards even on success, and
// `db.ts` copies it over the live file automatically when a migration fails.
//
// So: the user erases, is told it cannot be undone, and a later update ships a
// migration that fails on their machine. The memories come back. One machine,
// no second device, no old build, no action by the user. That is the same
// composition as the bug itself — three individually correct behaviours — and
// none of the three fix designs caught it.
//
// THE PROPERTY THAT MATTERS HERE is not that the three known suffixes are
// removed. It is that the function ENUMERATES the directory, so a copy left
// under a name nobody has thought of yet is covered the day it appears. That
// is BUG-139's lesson: a deletion test that asserts on the companion filenames
// somebody remembered cannot fail on the one nobody did.
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeBrainShadowCopies } from '../db'

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'brain-shadows-'))
  dbPath = join(dir, 'memory.db')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function put(name: string, body = 'x'): void {
  writeFileSync(join(dir, name), body)
}

describe('forget everything removes every shadow copy of the brain', () => {
  it('removes the three that exist today', () => {
    put('memory.db')
    put('memory.db.pre-migration-backup')
    put('memory.db.upload-snapshot')
    put('memory.db.local-unreadable-2026-09-07T10-00-00-000Z')

    const removed = removeBrainShadowCopies(dbPath)

    expect(removed.sort()).toEqual([
      'memory.db.local-unreadable-2026-09-07T10-00-00-000Z',
      'memory.db.pre-migration-backup',
      'memory.db.upload-snapshot'
    ])
    expect(readdirSync(dir)).toEqual(['memory.db'])
  })

  it('THE POINT: it removes a shadow under a name nobody has thought of', () => {
    // Nothing in the codebase writes this today. If something does next year,
    // the erase covers it without anyone remembering to come back here. A
    // fixed list of suffixes would not.
    put('memory.db')
    put('memory.db.some-future-safety-copy-2027')
    put('memory.db.vacuum-temp')

    removeBrainShadowCopies(dbPath)

    expect(readdirSync(dir)).toEqual(['memory.db'])
  })

  it('NEVER touches the live WAL sidecars — deleting those would undo the wipe', () => {
    // Load-bearing. The DELETE statements that just ran are sitting in the WAL
    // until SQLite checkpoints them. Removing memory.db-wal here would roll the
    // erase back, which is the opposite of the whole function.
    //
    // The hyphen is the entire guard: `memory.db-wal` does not start with
    // `memory.db.`, and this test is what stops someone "tidying" that into a
    // startsWith('memory.db') that silently eats both.
    put('memory.db')
    put('memory.db-wal')
    put('memory.db-shm')
    put('memory.db.pre-migration-backup')

    const removed = removeBrainShadowCopies(dbPath)

    expect(removed).toEqual(['memory.db.pre-migration-backup'])
    expect(existsSync(join(dir, 'memory.db-wal')), 'the WAL was deleted — the wipe is rolled back').toBe(true)
    expect(existsSync(join(dir, 'memory.db-shm'))).toBe(true)
    expect(existsSync(join(dir, 'memory.db')), 'the live database itself was deleted').toBe(true)
  })

  it('leaves every unrelated file in the profile alone', () => {
    // The directory is the whole userData profile, not a private folder, so an
    // over-broad match would delete someone's settings.
    put('memory.db')
    put('memory.db.upload-snapshot')
    put('app-settings.json')
    put('backup-state.json')
    put('memory-other.db')
    put('supabase-auth.json')

    removeBrainShadowCopies(dbPath)

    expect(readdirSync(dir).sort()).toEqual([
      'app-settings.json',
      'backup-state.json',
      'memory-other.db',
      'memory.db',
      'supabase-auth.json'
    ])
  })

  it('is quiet when there is nothing to remove, and when the directory is gone', () => {
    put('memory.db')
    expect(removeBrainShadowCopies(dbPath)).toEqual([])
    // A missing directory must not throw into an erase the user already
    // confirmed: the tables are gone by this point either way.
    expect(removeBrainShadowCopies(join(dir, 'no-such-dir', 'memory.db'))).toEqual([])
  })
})
