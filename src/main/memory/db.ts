// M25 Sales Brain — SQLite connection + migration runner.
//
// PLAIN-LANGUAGE SUMMARY (for the Phase 1 checkpoint, kept here so the code
// and the explanation never drift apart):
//
// The memory database is one file: memory.db, sitting next to every other
// data folder this app already has. Every time the app starts, before
// anything else touches that file, this module checks a number stamped
// inside the file itself (SQLite has a built-in slot for exactly this,
// called `user_version` — no custom "migrations table" needed) against the
// number this VERSION of the app expects. Three things can happen:
//
//   1. The numbers match — nothing to do, the app opens the file and moves on.
//   2. The file's number is LOWER — this file was created by an older app
//      version and needs upgrading. Before touching a single row, the WHOLE
//      FILE is copied to a backup (memory.db.pre-migration-backup) — a true
//      point-in-time snapshot via SQLite's own backup mechanism, not a raw
//      file copy, so it's never caught mid-write. Only then do the pending
//      upgrade steps run, all inside one single transaction — meaning
//      either every step succeeds together, or none of them take effect at
//      all (SQLite's transactions are all-or-nothing by design). If
//      anything goes wrong partway through, the transaction is
//      automatically undone AND the pre-migration backup is restored on top
//      of it — two independent layers of protection, not one.
//   3. The file's number is HIGHER than what this app version expects —
//      meaning a NEWER version of the app already upgraded this file, and
//      the user somehow ended up running an OLDER version (very unlikely
//      given auto-update, but not impossible). The app refuses to touch the
//      file at all in this case rather than guessing — Sales Brain just
//      goes into a "needs update" state until the user is back on a current
//      version. This is much safer than trying to "downgrade" a database,
//      which this app makes no attempt to support.
//
// In every failure case, the ORIGINAL call/contact/task data (everything
// this app stored before Sales Brain existed) is completely untouched —
// this module only ever reads/writes the separate memory.db file.
import { copyFileSync, existsSync, rmSync } from 'node:fs'
// M27 J3 — type-only. better-sqlite3's actual native module is loaded lazily
// inside openMemoryDb(), below, not here — see that function's own doc
// comment for why. A type-only import is erased entirely at compile time
// (no runtime require, no native load), so every `Database.Database`
// annotation in this file costs nothing until Sales Brain is actually used.
import type Database from 'better-sqlite3'
import { MIGRATIONS, LATEST_SCHEMA_VERSION } from './migrations'

export function memoryDbPath(userDataDir: string): string {
  return `${userDataDir}/memory.db`
}

function preMigrationBackupPath(dbPath: string): string {
  return `${dbPath}.pre-migration-backup`
}

export type MigrateResult =
  | { ok: true; migrated: boolean; fromVersion: number; toVersion: number }
  | { ok: false; reason: 'newer-than-app'; fileVersion: number; appVersion: number }
  | { ok: false; reason: 'migration-failed'; fileVersion: number; targetVersion: number; error: string }

/** Opens (creating if needed) the memory DB and loads the sqlite-vec
 *  extension into it. Does NOT migrate — call migrate() separately so a
 *  caller can decide what to do (block startup vs. degrade gracefully) if
 *  it reports failure, rather than this function making that call silently. */
/**
 * The vec0 extension path, corrected for asar packaging.
 *
 * sqlite-vec's own load() resolves vec0.dll via `require.resolve` (see
 * node_modules/sqlite-vec/index.cjs), which inside a packaged app returns a
 * path INSIDE app.asar — e.g.
 *   ...\resources\app.asar\node_modules\sqlite-vec-windows-x64\vec0.dll
 * That path is fine for anything going through Node's fs (Electron's asar
 * shim transparently redirects it), but loadExtension() hands the string
 * straight to SQLite's C `sqlite3_load_extension`, which calls LoadLibraryW
 * directly. The Win32 loader knows nothing about asar archives, finds no
 * such file on the real filesystem, and fails with ERROR_MOD_NOT_FOUND —
 * surfaced to the user as the bare OS string "The specified module could
 * not be found."
 *
 * electron-builder already unpacks the real DLL to the mirrored
 * app.asar.unpacked tree (see electron-builder.yml's asarUnpack), so the fix
 * is to point at that copy. Same correction the two in-repo native addons
 * make in their own resolveAddonPath (MacAdapter/WindowsAdapter).
 *
 * A no-op outside a packaged app (dev has no "app.asar" path segment), and
 * falls back to the original path if the unpacked copy somehow isn't there,
 * so this can only ever help. Exported for direct unit testing.
 */
export function resolveVecExtensionPath(resolved: string): string {
  const unpacked = resolved.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  if (unpacked !== resolved && existsSync(unpacked)) return unpacked
  return resolved
}

/**
 * M27 J3 — better-sqlite3 and sqlite-vec are require()'d HERE, lazily, not
 * imported at module scope. Every user's process used to load both native
 * modules at startup regardless of whether Sales Brain was even enabled
 * (isSalesBrainEnabled() is only checked inside initSalesBrain(), one layer
 * up in memory-runtime.ts — by the time execution reaches this function,
 * that gate has already passed). embeddings.ts's loadTransformers()
 * established this exact pattern first, for the identical reason
 * (onnxruntime-node's native binding), and WindowsAdapter.ts's
 * loadNativeAddon() is the same pattern again for a different native addon
 * — this brings db.ts in line with both rather than being the one holdout.
 *
 * Deliberately still SYNCHRONOUS (require(), not a dynamic import()) rather
 * than making this function — and its 7 existing call sites across
 * memory-runtime.ts and this module's own tests — async for no functional
 * benefit: require() inside a function body already defers the load to
 * first call exactly as well as a dynamic import would, without the ripple.
 */
export function openMemoryDb(dbPath: string): Database.Database {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const DatabaseCtor = require('better-sqlite3') as typeof Database
  const db = new DatabaseCtor(dbPath)
  db.pragma('journal_mode = WAL') // same durability/perf tradeoff every other SQLite app on desktop makes
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sqliteVec = require('sqlite-vec') as typeof import('sqlite-vec')
  // NOT sqliteVec.load(db) — that uses the raw require.resolve path, which
  // is broken inside a packaged app. See resolveVecExtensionPath above.
  db.loadExtension(resolveVecExtensionPath(sqliteVec.getLoadablePath()))
  return db
}

/** Best-effort cleanup of WAL-mode sidecar files after restoring the main DB
 *  file from a backup — leaving a stale `-wal`/`-shm` next to a just-restored
 *  `memory.db` risks SQLite reading inconsistent state on next open (they're
 *  keyed to match their main file's prior state, not the restored one). */
function removeWalSidecars(dbPath: string): void {
  for (const suffix of ['-wal', '-shm']) {
    try {
      rmSync(`${dbPath}${suffix}`, { force: true })
    } catch {
      /* best-effort */
    }
  }
}

/** Runs any pending migrations. Safe to call on every app startup — a
 *  fully-migrated DB is a fast no-op (one PRAGMA read). See the module doc
 *  comment above for the full plain-language explanation of what "safe"
 *  means here. Never throws — every failure mode is reported in the return
 *  value so the caller can decide how to degrade, matching this codebase's
 *  existing "never throw into startup" convention (app-settings.ts).
 *
 *  IMPORTANT: on an `ok: false` result, `db` has already been closed by this
 *  function (see the failure path below) — the caller must not keep using
 *  it. Re-open via openMemoryDb() only after a genuine fix; this module
 *  deliberately never re-opens automatically, so a real failure always
 *  surfaces instead of silently retrying against a DB whose state isn't
 *  understood.
 *
 *  `overrides` is test-only — production callers never pass it, so real
 *  usage always runs against the real, shipped MIGRATIONS/LATEST_SCHEMA_
 *  VERSION. It exists so the migration-failure path (backup → apply →
 *  restore-on-error) can be exercised with a deliberately-broken migration
 *  in a test, rather than that path only ever running for the first time
 *  when a REAL migration breaks in production — see __tests__/db.test.ts's
 *  "migration drill". */
export async function migrate(
  db: Database.Database,
  dbPath: string,
  overrides?: { migrations: import('./migrations').Migration[]; targetVersion: number }
): Promise<MigrateResult> {
  const migrations = overrides?.migrations ?? MIGRATIONS
  const targetVersion = overrides?.targetVersion ?? LATEST_SCHEMA_VERSION
  const fileVersion = db.pragma('user_version', { simple: true }) as number

  if (fileVersion === targetVersion) {
    return { ok: true, migrated: false, fromVersion: fileVersion, toVersion: fileVersion }
  }

  if (fileVersion > targetVersion) {
    // A newer app version already upgraded this file. Never attempt to
    // "downgrade" a schema — refuse cleanly instead.
    return { ok: false, reason: 'newer-than-app', fileVersion, appVersion: targetVersion }
  }

  const pending = migrations.filter((m) => m.version > fileVersion).sort((a, b) => a.version - b.version)

  // Nothing to protect on a brand-new (version 0, no tables) file — skip the
  // backup step rather than writing a pointless empty-DB backup every first
  // install.
  if (fileVersion > 0) {
    try {
      // better-sqlite3's backup() is async — it returns a Promise, uses
      // SQLite's own online-backup API (a consistent point-in-time
      // snapshot, safe even with WAL-mode writers active), never a raw
      // file copy of a file that could be mid-write.
      await db.backup(preMigrationBackupPath(dbPath))
    } catch (e) {
      // If we can't even take a backup, we must not proceed with a
      // migration we couldn't protect against — fail closed.
      return {
        ok: false,
        reason: 'migration-failed',
        fileVersion,
        targetVersion,
        error: `Could not create pre-migration backup: ${e instanceof Error ? e.message : String(e)}`
      }
    }
  }

  try {
    const applyAll = db.transaction(() => {
      for (const migration of pending) {
        db.exec(migration.sql)
      }
      db.pragma(`user_version = ${targetVersion}`)
    })
    applyAll()
    return { ok: true, migrated: true, fromVersion: fileVersion, toVersion: targetVersion }
  } catch (e) {
    // The transaction already rolled itself back (better-sqlite3's
    // db.transaction() wrapper does this automatically on throw) — but
    // restore the full pre-migration file too, as a second, independent
    // layer of protection, not just a defense against a bug in the
    // transaction wrapper itself.
    if (fileVersion > 0 && existsSync(preMigrationBackupPath(dbPath))) {
      try {
        // Close first: a WAL-mode connection's close() checkpoints and
        // clears its -wal/-shm sidecars, so the file copy below lands on a
        // clean, self-consistent main file, not one with pending WAL frames
        // that no longer match after being overwritten.
        db.close()
        copyFileSync(preMigrationBackupPath(dbPath), dbPath)
        removeWalSidecars(dbPath)
      } catch {
        // If even the restore fails, the error below still surfaces the
        // ORIGINAL migration failure — the caller needs to know the DB is
        // in an unknown state either way, and the pre-migration-backup
        // file is still sitting on disk for manual recovery.
      }
    } else {
      // No prior data existed (fresh install failing on its very first
      // migration) — still close so the caller never holds a handle to a
      // DB left in a partially-applied (if the transaction rollback itself
      // somehow didn't fully clear it) or otherwise unknown state.
      try {
        db.close()
      } catch {
        /* already closed or unusable — nothing more to do */
      }
    }
    return {
      ok: false,
      reason: 'migration-failed',
      fileVersion,
      targetVersion,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}
