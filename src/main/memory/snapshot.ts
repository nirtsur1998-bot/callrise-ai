// M29 A5.2 — THE one mechanism for producing a consistent copy of memory.db.
//
// Founder's constraint, verbatim: "the Export button and BUG-088's upload fix
// should provably share one mechanism, not two implementations of db.backup()
// that drift. One helper, both callers." This file is that helper; the cloud
// upload (backup.ts) and the Export Sales Brain button (memory-center IPC)
// both call it, and a test asserts neither has a private copy path.
//
// WHY db.backup() AND NOT fs.readFile: memory.db runs in WAL mode — recent
// commits live in memory.db-wal until a checkpoint folds them in, and nothing
// in the app forces one. On the founder's own machine the main file was NINE
// DAYS staler than its WAL (BUG-088's live evidence). SQLite's online-backup
// API reads through the WAL and produces a single consistent file, safe even
// while the app is writing.

import { existsSync, statSync } from 'node:fs'
import type Database from 'better-sqlite3'
import { getMemoryDb } from './memory-runtime'
import { signalNativeLoad } from '../telemetry/signals'
import { errorClassOf } from '../telemetry/capture'

export type SnapshotResult =
  | { ok: true; bytes: number }
  | { ok: false; reason: 'no-memory-db' | 'snapshot-failed'; errorClass?: string }

/**
 * Write a consistent snapshot of the memory DB to `destPath`.
 *
 * Uses the live runtime connection when Sales Brain is loaded (zero extra
 * native loads, snapshots exactly what the app sees), otherwise opens the
 * file read-only just long enough to back it up — deliberately WITHOUT the
 * sqlite-vec extension: copying bytes must keep working on a machine where
 * the vector extension is broken, which is exactly a machine you want an
 * export from. Never throws.
 */
export async function snapshotMemoryDb(
  sourcePath: string,
  destPath: string,
  deps: { liveDb?: Database.Database | null } = {}
): Promise<SnapshotResult> {
  try {
    const live = deps.liveDb !== undefined ? deps.liveDb : getMemoryDb()
    if (live) {
      await live.backup(destPath)
      return { ok: true, bytes: statSync(destPath).size }
    }
    if (!existsSync(sourcePath)) {
      return { ok: false, reason: 'no-memory-db' }
    }
    let fresh: Database.Database | null = null
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const DatabaseCtor = require('better-sqlite3') as typeof Database
      fresh = new DatabaseCtor(sourcePath, { readonly: true, fileMustExist: true })
      signalNativeLoad({ module: 'better-sqlite3', ok: true })
      await fresh.backup(destPath)
      return { ok: true, bytes: statSync(destPath).size }
    } finally {
      fresh?.close()
    }
  } catch (err) {
    // A require() failure here is the clean-Windows native class — count it.
    if (
      err instanceof Error &&
      /better-sqlite3|MODULE_NOT_FOUND|specified module/i.test(String(err.message))
    ) {
      signalNativeLoad({ module: 'better-sqlite3', ok: false, errorClass: errorClassOf(err) })
    }
    return { ok: false, reason: 'snapshot-failed', errorClass: errorClassOf(err) }
  }
}
