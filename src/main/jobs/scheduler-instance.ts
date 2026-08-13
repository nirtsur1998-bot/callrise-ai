// M26 Phase 5 — same shared-instance shape as jobs/instance.ts's
// getJobManager(), for the same reason: a module wanting to register a
// recurring/idle job (memory-runtime.ts's nightly consolidation, so far)
// shouldn't have to thread a Scheduler parameter through index.ts's existing
// registerXxx() call sites. One Scheduler for the whole app — it persists
// every registered spec's last-run timestamp to the SAME shared state file
// (jobs-scheduler.json, keyed by spec.name), so a single instance handling
// multiple recurring specs is the natural fit, not one Scheduler per caller.
import type { Scheduler } from './scheduler'

let instance: Scheduler | null = null

export function setScheduler(scheduler: Scheduler): void {
  instance = scheduler
}

/** Throws if called before main/index.ts has created the Scheduler — every
 *  real call site here only ever runs from inside a registerXxx()-style
 *  function, which index.ts always calls after `setScheduler(new
 *  Scheduler())`, mirroring getJobManager()'s own contract. */
export function getScheduler(): Scheduler {
  if (!instance) throw new Error('Scheduler accessed before it was initialized')
  return instance
}

/** Test-only reset — production code never calls this. */
export function __resetSchedulerForTests(): void {
  instance = null
}
