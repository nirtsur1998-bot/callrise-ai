// M25 Sales Brain — owns the single memory.db connection for the whole app
// (mirrors how every other store in this app has exactly one on-disk
// location, resolved once). Called from index.ts's startup sequence, gated
// on the master flag — see initSalesBrain()'s own doc comment for exactly
// where and why.
import { app } from 'electron'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { memoryDbPath, openMemoryDb, migrate, type MigrateResult } from './db'
import {
  describeTemporalBackfill,
  loadCallStartTimes,
  recordTemporalBackfillSkipped,
  runTemporalBackfill,
  temporalBackfillRecord
} from './temporal-backfill'
import { configureEmbeddingsCacheDir, warmUpEmbeddings } from './embeddings'
import { isSalesBrainEnabled } from '../app-settings'
import { runNightlyConsolidation } from './consolidation'
import { getScheduler } from '../jobs/scheduler-instance'
import {
  enqueueNightlyConsolidation,
  enqueueWarmUpEmbeddings,
  registerNightlyConsolidationJob,
  registerWarmUpEmbeddingsJob
} from './nightly-consolidation-job'

let db: Database.Database | null = null
let lastInitResult: { ok: boolean; detail: string } | null = null

// --- Nightly consolidation trigger ---------------------------------------
// M26 Phase 5 — this used to be a hand-rolled "run once per ~20 hours,
// checked at each app launch" timestamp file (this module's own doc comment
// used to explain why: "this app has no real cron/scheduled-task
// infrastructure... building one just for this would be a lot of new
// surface area for one feature"). Phase 1 built that shared infrastructure
// (jobs/scheduler.ts) specifically so this and backup.ts wouldn't each keep
// reinventing it — see that file's own header comment. This is the first
// caller.
//
// The ~20h (not 24h) window means "once a day" still triggers even if
// someone opens the app at a slightly earlier time than yesterday — same
// reasoning as before, just now expressed as Scheduler.registerRecurring's
// intervalMs instead of a bespoke comparison.
//
// One real behavior change from the migration, worth stating plainly:
// Scheduler records a spec's "last ran" timestamp the moment it's TRIGGERED
// (synchronously, before `run()` executes), not after the work actually
// finishes — unlike the old markNightlyConsolidationRan(), which only ever
// ran on SUCCESS, so a failed pass would retry on the next eligible check
// rather than waiting out the full ~20h again. Accepted deliberately: this
// is best-effort maintenance, not a correctness-critical operation, and a
// failure is no longer silent either way — it now shows up as a failed job
// in the Activity Center, which the timestamp-file version never surfaced
// at all.
const NIGHTLY_INTERVAL_MS = 20 * 60 * 60 * 1000

/** Called once at startup, after initSalesBrain() — registers the recurring
 *  spec (idempotent-ish: Scheduler doesn't dedupe by name today, so this
 *  must only ever be called once per process, same as every other
 *  registerXxx() in this codebase's own `let registered = false` guards —
 *  here that's naturally true, since index.ts calls this exactly once).
 *  No-ops instantly if Sales Brain is off or init failed — never even
 *  registers the recurring spec, so a user who never opts in never has this
 *  running in the background at all. */
export function maybeRunNightlyConsolidation(): void {
  if (!isSalesBrainEnabled() || !db) return
  // M26 Batch 5 — runs as a MAINTENANCE job so the longest recurring AI
  // operation in the app stops being completely invisible (Phase 0 row 36:
  // "no 'is it running' indicator anywhere").
  registerNightlyConsolidationJob(async () => {
    // `db` is re-read INSIDE the executor rather than captured from the
    // check above: the job can start well after registration, and a Sales
    // Brain that shut down in between must not be written to.
    if (!db) return
    await runNightlyConsolidation(db)
  })
  getScheduler().registerRecurring({
    name: 'salesBrain:nightlyConsolidation',
    intervalMs: NIGHTLY_INTERVAL_MS,
    run: () => {
      // Re-checked fresh at fire time, not just at registration — the rep
      // may have turned Sales Brain off (or it may have failed to init)
      // sometime in the ~20h since this was registered.
      if (!isSalesBrainEnabled() || !db) return
      enqueueNightlyConsolidation()
    }
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

  // M36 Stage 3 item 5, step 1 — date the existing rows ONCE, after the
  // schema is current. Not awaited: it reads the calls directory, and startup
  // must not wait on that. Not inside the migration: the calls store is
  // outside memory.db. Its record (the counts) lands in memory_meta and in
  // the log, so what got a real date and what got an approximate one is
  // never a matter of trust.
  void runTemporalBackfillOnce(handle, join(userDataDir, 'calls'))

  return lastInitResult
}

async function runTemporalBackfillOnce(handle: Database.Database, callsDir: string): Promise<void> {
  try {
    // a handle that is not open is never read or written through (a test's
    // stand-in object, or a connection closed during startup). Nothing can
    // be recorded through it either — the absence of any record IS the
    // "never got the chance" state, and the next launch runs the job.
    if (!handle.open) return
    if (temporalBackfillRecord(handle)?.status === 'ran') return
    const callStartTimes = await loadCallStartTimes(callsDir)
    // the connection may have been replaced or closed while the directory
    // was being read — never write rows through a stale handle. A skip is
    // recorded (where the handle still can) so it reads as a skip, not as a
    // run that found nothing.
    if (!handle.open) return
    if (db !== handle) {
      recordTemporalBackfillSkipped(handle, 'connection replaced during startup')
      return
    }
    const counts = runTemporalBackfill(handle, callStartTimes)
    console.log(`[sales-brain] ${describeTemporalBackfill(counts)}`)
  } catch (err) {
    console.error('[sales-brain] temporal backfill failed (memories stay undated until the next launch):', err)
    try {
      if (handle.open) recordTemporalBackfillSkipped(handle, `error: ${err instanceof Error ? err.message : String(err)}`)
    } catch {
      /* the record is best-effort; the log line above already says what happened */
    }
  }
}

/** Returns null if Sales Brain is off, or if init failed/hasn't run yet —
 *  every caller (extraction hooks, future retrieval/consolidation code)
 *  must handle null by simply skipping its work, never by throwing. */
export function getMemoryDb(): Database.Database | null {
  return db
}

let initRetryPromise: Promise<{ ok: boolean; detail: string }> | null = null

/** A null db from getMemoryDb() can be PERMANENT for the rest of a session
 *  even with Sales Brain switched on — initSalesBrain() only ever runs
 *  automatically once, at startup (raced against a 15s cap so a slow init
 *  never blocks login, see index.ts), or once more on a live settings-
 *  toggle flip (app-settings.ts's settings:update handler). Nothing else
 *  ever retries it. A startup init that loses that 15s race on a slower
 *  machine, or any transient failure (a locked file, a momentary disk
 *  hiccup), used to leave every Sales Brain surface permanently inert for
 *  the rest of the session with the same generic "not ready yet," no way
 *  to see why, and no recovery short of a full restart — confirmed live: a
 *  real report where waiting well past the 15s window and retrying still
 *  failed with the identical unhelpful message.
 *
 *  Used only at the USER-FACING entry points where someone is actively
 *  waiting on an answer (backfill start, onboarding submit) — deliberately
 *  NOT retrofitted into every background hook (memory-hooks.ts, rag.ts,
 *  profile-injection.ts, memory-center-ipc.ts): those fire silently off the
 *  live/post-call path by design, where a doomed retry costs real latency
 *  nobody is watching for, for no benefit a background caller can act on
 *  anyway. A foreground click is someone waiting right now, and deserves a
 *  real answer instead of a dead end.
 *
 *  De-duplicates concurrent callers onto the SAME retry attempt (a bare
 *  retry-on-every-call would let two near-simultaneous clicks race two
 *  independent migrate() runs against the same file) rather than adding a
 *  new lock primitive this codebase doesn't otherwise have — the in-flight
 *  promise clears itself when it settles, so a LATER call still gets a
 *  fresh attempt rather than being stuck replaying a stale one.
 *
 *  MUST NEVER THROW AND MUST NEVER HANG — this is awaited directly inside
 *  IPC handlers, and an ipcMain.handle callback that throws or never
 *  settles reaches the renderer as a rejected/pending promise. The renderer
 *  call sites read a RESULT OBJECT; a rejection there isn't a visible error,
 *  it's silence — the button appears to do nothing at all. That is exactly
 *  what shipped in 1.2.1: initSalesBrain() can throw synchronously
 *  (better-sqlite3's Database constructor on a native-module load failure —
 *  index.ts's own startup call has always wrapped it in try/catch for
 *  precisely this reason, which the first version of this function failed to
 *  mirror), so on a machine where init genuinely fails, "not ready yet"
 *  became "nothing happens." Both guards below exist for that: catch
 *  everything, and bound the wait so a slow/stuck init can't leave the
 *  click unanswered forever. */
const ENSURE_TIMEOUT_MS = 20_000

export async function ensureMemoryDb(): Promise<{ db: Database.Database | null; detail: string }> {
  if (db) return { db, detail: 'already ready' }
  if (!isSalesBrainEnabled()) return { db: null, detail: 'disabled' }
  if (!initRetryPromise) {
    // .catch() HERE, on the shared promise, not only around the await
    // below: an un-caught rejection stored in initRetryPromise would also
    // surface as an unhandled rejection for every OTHER caller awaiting the
    // same attempt. Normalised to a result object so nothing downstream
    // ever sees a rejected promise.
    initRetryPromise = initSalesBrain()
      .catch((err: unknown) => ({
        ok: false,
        detail: `init threw: ${err instanceof Error ? err.message : String(err)}`
      }))
      .finally(() => {
        initRetryPromise = null
      })
  }
  // Bounded, for the same reason index.ts bounds the startup init: a slow or
  // stuck open/migrate must not hold an IPC handler open indefinitely. The
  // init itself keeps running in the background on timeout — a later click
  // finds `db` already set if it eventually succeeds.
  const timeout = new Promise<{ ok: boolean; detail: string }>((resolve) =>
    setTimeout(() => resolve({ ok: false, detail: `still starting up (>${ENSURE_TIMEOUT_MS / 1000}s)` }), ENSURE_TIMEOUT_MS)
  )
  const result = await Promise.race([initRetryPromise, timeout])
  return { db, detail: result.detail }
}

export function getLastInitResult(): { ok: boolean; detail: string } | null {
  return lastInitResult
}

/** Test-only reset — production code never calls this. */
export function __resetForTests(): void {
  db = null
  lastInitResult = null
}
