import type { Job } from '../../../../preload/index.d'

/**
 * True while this job's result may still be the only copy of AI output the
 * rep hasn't reviewed — a Generate tasks proposal list, a Generate CRM note
 * draft. The job system REFUSES to clear one of these from generic history
 * UI (see JobManager.dismiss, BUG-052), so screens use this to avoid
 * offering a "Dismiss" that would silently do nothing.
 *
 * Mirrors main's jobs/retention.ts holdsUnreviewedOutput() — renderer code
 * can't import from src/main, and the rule is one line, so it's duplicated
 * rather than routed through another IPC round trip. Main is the authority:
 * this copy only decides what to SHOW, never what may actually be deleted,
 * so the two drifting apart degrades the UI, never the guarantee.
 */
export function holdsUnreviewedOutput(job: Job): boolean {
  return job.state === 'succeeded' && job.retainUntilConsumed === true
}
