// M26 Batch 5 — Sales Brain's two background housekeeping jobs: the nightly
// consolidation, and the one-time embedding-model warm-up.
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
 *  startup, and a job-system problem must not take the app down with it.
 *
 *  M27 — dedupes against an already-pending run, the same shape 8 other
 *  adapters already use (backup.ts, calls.ts, deals.ts, ...). Previously this
 *  enqueued unconditionally, which was harmless only because the queue always
 *  drained long before the next nightly trigger. Quota-pressure deferral
 *  (JobManager.setCapacityGate) breaks that assumption: with every AI model
 *  unusable, a held consolidation can still be sitting queued when the NEXT
 *  night's trigger fires, and the scheduler's own dedup can't help — it
 *  correctly considers the run due again (see scheduler.ts's checkOne, which
 *  stamps lastRuns at trigger time). Two identical consolidations would then
 *  both run the moment capacity returned, doubling the AI spend of a pass
 *  whose whole job is housekeeping. */
export function enqueueNightlyConsolidation(): void {
  try {
    const manager = getJobManager()
    const pending = manager
      .list()
      .find(
        (j) =>
          j.type === NIGHTLY_CONSOLIDATION_JOB_TYPE &&
          (j.state === 'running' || j.state === 'queued')
      )
    if (pending) return
    manager.enqueue(NIGHTLY_CONSOLIDATION_JOB_TYPE, {})
  } catch (err) {
    console.error('[sales-brain] could not enqueue nightly consolidation:', err)
  }
}

export const WARM_UP_EMBEDDINGS_JOB_TYPE = 'salesBrain:warmUpEmbeddings'

let warmUpRegistered = false

/**
 * The first-run embedding-model download (Phase 0 row 37), pulled out of the
 * lazy path it used to hide in.
 *
 * NOT silent, unlike the other housekeeping jobs — this one is the whole
 * point. A ~23MB download that used to ambush an unrelated feature for ~48s
 * with no explanation now says "Setting up on-device search" in the Activity
 * Center while it happens. It is the one piece of background work here the
 * rep genuinely benefits from being able to see.
 *
 * Runs once (the underlying promise is memoised, so a second run is a no-op),
 * and never blocks anything: it is an ordinary MAINTENANCE job, so the app is
 * fully usable throughout, and an embedding-dependent action that arrives
 * mid-download simply awaits the same download it would have started itself.
 */
export function registerWarmUpEmbeddingsJob(run: () => Promise<void>): void {
  if (warmUpRegistered) return
  warmUpRegistered = true

  getJobManager().registerType<Record<string, never>, string>({
    type: WARM_UP_EMBEDDINGS_JOB_TYPE,
    lane: 'MAINTENANCE',
    titleFor: () => 'Setting up on-device search',
    cancellable: false,
    executor: {
      kind: 'inline-async',
      run: async () => {
        await run()
        return 'Ready.'
      }
    }
  })
}

/** Queue the warm-up. Never throws — same startup-safety reason as above. */
export function enqueueWarmUpEmbeddings(): void {
  try {
    getJobManager().enqueue(WARM_UP_EMBEDDINGS_JOB_TYPE, {})
  } catch (err) {
    console.error('[sales-brain] could not enqueue the embedding warm-up:', err)
  }
}
