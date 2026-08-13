// M25 Sales Brain — owns the single memory.db connection for the whole app
// (mirrors how every other store in this app has exactly one on-disk
// location, resolved once). Called from index.ts's startup sequence, gated
// on the master flag — see initSalesBrain()'s own doc comment for exactly
// where and why.
import { app } from 'electron'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type Database from 'better-sqlite3'
import { memoryDbPath, openMemoryDb, migrate, type MigrateResult } from './db'
import { configureEmbeddingsCacheDir, warmUpEmbeddings } from './embeddings'
import { isSalesBrainEnabled } from '../app-settings'
import { writeJsonAtomic } from '../atomic-write'
import { runNightlyConsolidation } from './consolidation'
import {
  enqueueNightlyConsolidation,
  enqueueWarmUpEmbeddings,
  registerNightlyConsolidationJob,
  registerWarmUpEmbeddingsJob
} from './nightly-consolidation-job'

let db: Database.Database | null = null
let lastInitResult: { ok: boolean; detail: string } | null = null

// --- Nightly consolidation trigger ---------------------------------------
// This app has no real cron/scheduled-task infrastructure (confirmed during
// Phase 0's codebase map) — building one just for this would be a lot of
// new surface area for one feature. A "run once per ~20 hours, checked at
// each app launch" timestamp file is a pragmatic, honest substitute: it
// can't guarantee 2am-sharp execution, but it DOES guarantee the deep pass
// (reflection + decay) runs roughly once a day for anyone who opens the app
// at all that day, without needing the app to be running in the background
// 24/7. The ~20h (not 24h) window means "once a day" still triggers even if
// someone opens the app at a slightly earlier time than yesterday.
const NIGHTLY_INTERVAL_MS = 20 * 60 * 60 * 1000

function nightlySchedulePath(userDataDir: string): string {
  return join(userDataDir, 'sales-brain-schedule.json')
}

async function shouldRunNightlyConsolidation(userDataDir: string): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(nightlySchedulePath(userDataDir), 'utf8')) as {
      lastRunAt?: string
    }
    if (!raw.lastRunAt) return true
    const last = Date.parse(raw.lastRunAt)
    if (Number.isNaN(last)) return true
    return Date.now() - last >= NIGHTLY_INTERVAL_MS
  } catch {
    return true // no schedule file yet — first run
  }
}

async function markNightlyConsolidationRan(userDataDir: string): Promise<void> {
  await writeJsonAtomic(nightlySchedulePath(userDataDir), {
    lastRunAt: new Date().toISOString()
  }).catch(() => {})
}

/** Called once at startup, after initSalesBrain() — fire-and-forget, never
 *  blocks startup (reflection + decay across every scope can take a real
 *  amount of wall-clock time with several AI calls; this must never be
 *  something the user waits on just to open the app). No-ops instantly if
 *  Sales Brain is off, if init failed, or if it already ran recently. */
export function maybeRunNightlyConsolidation(): void {
  if (!isSalesBrainEnabled() || !db) return
  const userDataDir = app.getPath('userData')
  void shouldRunNightlyConsolidation(userDataDir).then((should) => {
    if (!should || !db) return
    // M26 Batch 5 — runs as a MAINTENANCE job so the longest recurring AI
    // operation in the app stops being completely invisible (Phase 0 row 36:
    // "no 'is it running' indicator anywhere"). The once-a-day decision and
    // the ran-marker stay here; the job owns only the work itself.
    registerNightlyConsolidationJob(async () => {
      // `db` is re-read INSIDE the executor rather than captured from the
      // check above: the job can start after this function returns, and a
      // Sales Brain that shut down in between must not be written to.
      if (!db) return
      await runNightlyConsolidation(db)
      await markNightlyConsolidationRan(userDataDir)
    })
    enqueueNightlyConsolidation()
  })
}

/** The ONLY place memory.db is ever opened. Call once, early in startup —
 *  see index.ts's placement of the call, right after the AI-keys load and
 *  BEFORE any registerX() that could touch memory data, for the same race-
 *  prevention reason the codebase map (Phase 0) flagged: an IPC handler
 *  that starts listening before migration finishes could hit a DB mid-
 *  upgrade. Gated on the master flag: if Sales Brain is off, this does
 *  nothing at all — no file even gets created — so a user who never opts in
 *  never pays any cost (disk, startup time, or otherwise) for a feature
 *  they didn't turn on. */
export async function initSalesBrain(): Promise<{ ok: boolean; detail: string }> {
  if (!isSalesBrainEnabled()) {
    lastInitResult = { ok: true, detail: 'disabled' }
    return lastInitResult
  }

  const userDataDir = app.getPath('userData')
  configureEmbeddingsCacheDir(userDataDir)

  const dbPath = memoryDbPath(userDataDir)
  const handle = openMemoryDb(dbPath)
  const result: MigrateResult = await migrate(handle, dbPath)

  if (!result.ok) {
    // migrate() already closed the handle on any failure (see its own doc
    // comment) — Sales Brain simply stays inert for this session. The rest
    // of the app is completely unaffected; this only ever touches the
    // separate memory.db file. Logged via console.error (not thrown) so
    // startup never crashes on this — same "never throw into startup"
    // convention as every other module here.
    lastInitResult = { ok: false, detail: `migration failed: ${JSON.stringify(result)}` }
    console.error('[sales-brain] migration failed, Sales Brain disabled for this session:', result)
    return lastInitResult
  }

  db = handle
  lastInitResult = {
    ok: true,
    detail: result.migrated
      ? `migrated ${result.fromVersion} -> ${result.toVersion}`
      : 'already current'
  }

  // M26 Batch 5 — pull the ~23MB embedding model down now, as a visible
  // background job, instead of letting it ambush whatever feature happens to
  // need the first embedding (Phase 0 row 37: a real ~48s production stall
  // with no explanation anywhere).
  //
  // Only reached when Sales Brain is ON and its DB opened successfully — the
  // early return at the top of this function means a user who never opts in
  // never downloads anything. Deliberately NOT awaited: startup must never
  // wait on a download, and the app stays fully usable while it runs. An
  // embedText() arriving mid-download awaits the same memoised promise, so it
  // waits exactly as long as it would have anyway.
  registerWarmUpEmbeddingsJob(warmUpEmbeddings)
  enqueueWarmUpEmbeddings()

  return lastInitResult
}

/** Returns null if Sales Brain is off, or if init failed/hasn't run yet —
 *  every caller (extraction hooks, future retrieval/consolidation code)
 *  must handle null by simply skipping its work, never by throwing. */
export function getMemoryDb(): Database.Database | null {
  return db
}

export function getLastInitResult(): { ok: boolean; detail: string } | null {
  return lastInitResult
}

/** Test-only reset — production code never calls this. */
export function __resetForTests(): void {
  db = null
  lastInitResult = null
}
