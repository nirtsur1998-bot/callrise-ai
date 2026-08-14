// M25 Sales Brain — IPC surface for backfill.
//
// M26 Phase 3 — this used to run fire-and-forget with the renderer polling a
// module-level `lastProgress` snapshot on an interval; now it's a real BATCH
// job, tracked via window.api.jobs like every other migrated operation, so
// navigating away from Settings mid-import no longer loses visible progress
// (the import itself was always safe either way — only the visible feedback
// used to disappear). runBackfill() itself is completely unchanged — only
// its execution home and how progress reaches the renderer changed.
import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { isSalesBrainEnabled } from '../app-settings'
import { ensureMemoryDb, getMemoryDb } from './memory-runtime'
import { runBackfill, type BackfillOptions, type BackfillProgress } from './backfill'
import { getJobManager } from '../jobs/instance'
import type { Job } from '../jobs/types'

function callsDir(): string {
  return join(app.getPath('userData'), 'calls')
}
function contactsDir(): string {
  return join(app.getPath('userData'), 'contacts')
}
function dealsDir(): string {
  return join(app.getPath('userData'), 'deals')
}

const BACKFILL_JOB_TYPE = 'salesBrain:backfill'

type BackfillJobInput = Pick<BackfillOptions, 'includeContacts' | 'includeDeals' | 'includeCalls'>

function stageLabel(p: BackfillProgress): string {
  const noun = p.stage === 'contacts' ? 'contacts' : p.stage === 'deals' ? 'deals' : 'calls'
  return p.total > 0 ? `Scanning ${noun}… ${p.processed} / ${p.total}` : `Scanning ${noun}…`
}

let registered = false

export function registerBackfill(): void {
  if (registered) return
  registered = true

  // M26 Phase 3 — registered once here rather than at module load, since it
  // needs the shared JobManager (see jobs/instance.ts, same convention as
  // calls.ts's objection-scan job). BackfillJobInput deliberately holds ONLY
  // the three plain booleans the rep chose — never the live `db` handle or
  // the directory path strings, since Job.input gets JSON-serialized to disk
  // for resume/retry; getMemoryDb()/callsDir()/contactsDir()/dealsDir() are
  // resolved fresh inside the executor instead, exactly like the objection
  // scan adapter resolves callsDir() fresh rather than capturing it.
  getJobManager().registerType<BackfillJobInput, string>({
    type: BACKFILL_JOB_TYPE,
    lane: 'BATCH',
    titleFor: () => 'Importing your past history into Sales Brain',
    // runBackfill has no AbortSignal support, and adding one would mean
    // editing M25-owned code — out of scope for an adapter-only migration
    // (see CLAUDE.md's "migrate via adapters, don't rewrite feature logic").
    // Not cancellable mid-run; a rep can still navigate away freely, which is
    // the actual bug this migration fixes.
    cancellable: false,
    executor: {
      kind: 'inline-async',
      run: async (input, handle) => {
        const db = getMemoryDb()
        if (!db) throw new Error('Sales Brain is not ready yet.')

        // runBackfill() never rejects — it catches internally and reports
        // stage:'error' through the callback instead (see its own doc
        // comment) — so success/failure here has to be read back out of the
        // last progress snapshot rather than a thrown/resolved promise. Kept
        // on a holder object, not a bare `let` — TS's flow analysis doesn't
        // invalidate a plain variable's narrowing across a call that mutates
        // it only via a closure, which would otherwise misnarrow the read
        // below to `null`/`never` even though the callback did run.
        const progressHolder: { last: BackfillProgress | null } = { last: null }
        await runBackfill(
          db,
          {
            includeContacts: input.includeContacts,
            includeDeals: input.includeDeals,
            includeCalls: input.includeCalls,
            callsDir: callsDir(),
            contactsDir: contactsDir(),
            dealsDir: dealsDir()
          },
          (p) => {
            progressHolder.last = p
            if (p.stage === 'contacts' || p.stage === 'deals' || p.stage === 'calls') {
              handle.reportProgress({ mode: 'stages', stageLabel: stageLabel(p) })
            }
          }
        )

        if (progressHolder.last !== null && progressHolder.last.stage === 'error') {
          throw new Error(progressHolder.last.lastError ?? 'The import failed.')
        }

        // BUG-057 — a run where the calls stage attempted extractions and not
        // ONE succeeded is a failed run, and must surface as one: red, with
        // the reason and a Retry, instead of a green check over an import that
        // learned nothing. This is the case that hid two days of total AI
        // failure behind a hardcoded "Import complete." — twice in one morning,
        // 99 doomed requests each time.
        //
        // Partial success is deliberately NOT failure: if contacts and deals
        // imported fine and only the calls stage struggled, the job succeeds
        // and the summary names the failures instead.
        if (progressHolder.last?.callsTotalFailure === true) {
          throw new Error(
            progressHolder.last.summary ??
              'Every attempt to read your past calls failed — nothing was imported from them.'
          )
        }

        return progressHolder.last?.summary ?? 'Import complete.'
      }
    }
  })

  // The manual "Import now" trigger — only ever runs when the rep clicks it.
  // Enqueues and returns immediately; the renderer tracks the actual run via
  // window.api.jobs (list/onChanged), same as the objection scan adapter.
  ipcMain.handle(
    'salesBrain:backfill:start',
    async (_e, opts: unknown): Promise<{ ok: boolean; message?: string; jobId?: string }> => {
      if (!isSalesBrainEnabled()) return { ok: false, message: 'Sales Brain is off.' }
      // A null db here used to be a dead end for the rest of the session —
      // see ensureMemoryDb()'s own doc comment. Retry once, right here,
      // rather than failing on a stale/never-attempted init; surface the
      // REAL reason if it's still not ready, not the old generic message.
      const { db, detail } = await ensureMemoryDb()
      if (!db) return { ok: false, message: `still not ready — ${detail}` }

      const manager = getJobManager()
      // One import at a time, same explicit re-check as the objection scan
      // adapter — BATCH's own maxConcurrent already guarantees this too, but
      // checking here hands a second click back the SAME job instead of
      // silently queuing a redundant one behind it.
      const already = manager
        .list()
        .find(
          (j: Job) =>
            j.type === BACKFILL_JOB_TYPE && (j.state === 'running' || j.state === 'queued')
        )
      if (already) return { ok: true, jobId: already.id }

      const o = (opts && typeof opts === 'object' ? opts : {}) as Record<string, unknown>
      const job = manager.enqueue(BACKFILL_JOB_TYPE, {
        includeContacts: o.includeContacts !== false,
        includeDeals: o.includeDeals !== false,
        includeCalls: o.includeCalls === true // opt-in, off unless explicitly requested — the slow/costly part
      })
      return { ok: true, jobId: job.id }
    }
  )
}
