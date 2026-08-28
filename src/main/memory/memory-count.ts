// BUG-092 — "does this local memory.db actually hold anything?"
//
// The Sales Brain restore guard used to be an EXISTENCE test
// (`await fs.access(dbPath); return`), and that is not the same question.
// `openMemoryDb` creates the file with `new DatabaseCtor(dbPath)` BEFORE
// anything can fail, so a failed init leaves a husk behind; and a
// freshly-enabled Sales Brain is schema-only anyway. Measured on this machine:
//
//   new Database(path)            -> file exists immediately, 0 bytes
//   + WAL pragma + create table   -> 8192 bytes, zero `memories` rows
//
// Both read as "local truth worth protecting" to an existence check, so the
// restore was skipped and the empty husk was then uploaded over the only cloud
// copy with `upsert: true` (no version history). This module answers the
// question the guard actually needs.

import { existsSync } from 'node:fs'
import type Database from 'better-sqlite3'

export type MemoryCountResult =
  /** The DB opened and we counted its memories. `count: 0` is a real answer. */
  | { ok: true; count: number }
  /** No file at all. */
  | { ok: false; reason: 'absent' }
  /** A file exists but could not be opened or queried — 0-byte husk, torn
   *  file, not-a-SQLite-file, locked. Deliberately DISTINCT from `count: 0`:
   *  an empty DB is safe to replace, an unreadable one might be recoverable
   *  and must never be silently destroyed. */
  | { ok: false; reason: 'unreadable'; errorClass?: string }

/**
 * Count rows in `memories`, or say why we cannot. Never throws.
 *
 * Opened readonly and WITHOUT the sqlite-vec extension, the same reasoning as
 * `snapshotMemoryDb`: deciding whether the user has memories must keep working
 * on a machine where the vector extension is broken — that is exactly the
 * clean-Windows failure class that produces husks in the first place.
 */
export function localMemoryCount(dbPath: string): MemoryCountResult {
  if (!existsSync(dbPath)) return { ok: false, reason: 'absent' }
  let db: Database.Database | null = null
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const DatabaseCtor = require('better-sqlite3') as typeof Database
    db = new DatabaseCtor(dbPath, { readonly: true, fileMustExist: true })
    const row = db.prepare('select count(*) as n from memories').get() as { n?: number } | undefined
    const n = typeof row?.n === 'number' ? row.n : 0
    return { ok: true, count: n }
  } catch (err) {
    return {
      ok: false,
      reason: 'unreadable',
      errorClass: err instanceof Error ? err.name : 'Error'
    }
  } finally {
    try {
      db?.close()
    } catch {
      /* closing a handle we may have failed to open is best-effort */
    }
  }
}
