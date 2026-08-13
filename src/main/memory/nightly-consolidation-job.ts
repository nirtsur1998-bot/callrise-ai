// M26 Batch 5 — the nightly Sales Brain consolidation as a background job.
//
// Phase 0 row 36 described it as "completely invisible, no 'is it running'
// indicator anywhere", and it is the longest recurring AI operation in the
// app (reflection + decay across every memory scope, tens of seconds to
// minutes). Running it as a job means the rep can see it happening instead
// of wondering why the app feels busy shortly after launch.
//
// Runs at most once a day, so it costs one job entry per day against the
// 500-job retention cap — nothing like the every-10-minutes sync heartbeat
// that was deliberately left off the job system for noise reasons.
import { getJobManager } from '../jobs/instance'

export const NIGHTLY_CONSOLIDATION_JOB_TYPE = 'salesBrain:nightlyConsolidation'

let registered = false

/** Registers the job type. Takes the actual work as a callback so this
 *  module never imports memory-runtime — that module owns the `db` handle
 *  and its own gating, and importing it here would create a cycle
 *  (memory-runtime enqueues this job). */
export function registerNightlyConsolidationJob(run: () => Promise<void>): void {
  if (registered) return
  registered = true

  getJobManager().registerType<Record<string, never>, string>({
    type: NIGHTLY_CONSOLIDATION_JOB_TYPE,
    // MAINTENANCE, per the approved Phase 0 lane assignment: idle-time
    // housekeeping that must never compete with anything the rep clicked.
    lane: 'MAINTENANCE',
    titleFor: () => 'Sales Brain: nightly tidy-up',
    // runNightlyConsolidation has no AbortSignal support, and adding one
    // would mean rewriting M25 internals — out of scope for an adapter.
    cancellable: false,
    // Housekeeping the rep never asked for and cannot act on. It belongs in
    // the Activity Center, but "Sales Brain: nightly tidy-up — done" is not
    // worth interrupting anyone for.
    silent: true,
    executor: {
      kind: 'inline-async',
      run: async () => {
        await run()
        return 'Tidied up.'
      }
    }
  })
}

/** Queue the nightly pass. Never throws into its caller — this fires during
 *  startup, and a job-system problem must not take the app down with it. */
export function enqueueNightlyConsolidation(): void {
  try {
    getJobManager().enqueue(NIGHTLY_CONSOLIDATION_JOB_TYPE, {})
  } catch (err) {
    console.error('[sales-brain] could not enqueue nightly consolidation:', err)
  }
}
