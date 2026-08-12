// Phase 3 — every migrated feature's own module (calls.ts, backup.ts, ...)
// needs to register a job type and/or enqueue jobs, without this codebase's
// existing registerXxx() call sites in main/index.ts having to thread a
// JobManager parameter through every single one of them. Matches the
// established pattern elsewhere in this app (backup.ts's scheduleBackup(),
// detection-tray.ts's tray) of a module owning one shared instance behind
// plain exported functions, rather than constructor-injecting a service.
import type { JobManager } from './JobManager'

let instance: JobManager | null = null

export function setJobManager(manager: JobManager): void {
  instance = manager
}

/** Throws if called before main/index.ts has created the JobManager — every
 *  real call site here only ever runs from inside a registerXxx() function,
 *  which index.ts always calls after `jobManager = new JobManager()`. */
export function getJobManager(): JobManager {
  if (!instance) throw new Error('JobManager accessed before it was initialized')
  return instance
}
