// M26 — how much finished job history to keep.
//
// Kept as pure logic with no Electron/JobManager import so it stays
// exhaustively testable: this module can DELETE things, and the one thing it
// must never delete is already-paid-for AI output the rep hasn't looked at
// yet (see BUG-048 Generate tasks, BUG-050 Generate CRM note — both fixed by
// keeping that output in a SUCCEEDED job until the rep consumes it). A naive
// "keep the newest N" would silently undo both, with no error and no way for
// the rep to know their draft was thrown away.
//
// Until now nothing pruned at all — every finished job stayed in memory and
// in jobs-state.json forever. Harmless while only user-clicked operations
// were jobs; not harmless once automatic/recurring work joins them (a
// 10-minute timer is ~50k entries a year, every one re-read at startup and
// re-broadcast to the renderer on each change).
import type { Job, JobState } from './types'

/** Ceiling on total retained jobs. A COUNT, not a time window: "keep 7 days"
 *  behaves wildly differently for a heavy user vs. someone who opens the app
 *  twice a week, whereas a count is predictable for everyone. Set high on
 *  purpose — the real risk here is deleting something someone wanted, not
 *  row count, and rows are cheap. */
export const MAX_RETAINED_JOBS = 500

/** States that mean the job is over. Anything else is still live and is
 *  never a pruning candidate at any size. */
const TERMINAL: JobState[] = ['succeeded', 'failed', 'cancelled', 'interrupted']

export function isTerminal(state: JobState): boolean {
  return TERMINAL.includes(state)
}

/**
 * True while this job's resultData may still be the only copy of output the
 * rep hasn't reviewed. Both the automatic pruner and the manual dismiss path
 * refuse to destroy one of these — see JobManager.dismiss (BUG-052) — and
 * the Activity Center uses the same rule to stop OFFERING a dismiss that
 * would be refused.
 */
export function holdsUnreviewedOutput(job: Job): boolean {
  return job.state === 'succeeded' && job.retainUntilConsumed === true
}

/**
 * Jobs that must survive pruning no matter what:
 *
 *  - Anything not finished (queued/running) — pruning live work would orphan
 *    a running executor from its own record.
 *  - A SUCCEEDED job of a type that declares `retainUntilConsumed`, because
 *    its resultData may still hold output the rep hasn't reviewed. These
 *    leave only via their own "you've dealt with it" path (the self-dismiss
 *    in GenerateTasksDialog / crm-note-generator-ipc). Deliberately scoped
 *    to `succeeded`: a FAILED or CANCELLED run of the same type produced no
 *    output to lose, so it prunes like anything else.
 *
 *  - Any INTERRUPTED job. These exist precisely so work killed by a crash or
 *    force-quit can be picked up again: store.ts rewrites running ->
 *    interrupted on load so resume() can continue the SAME job from its
 *    saved checkpoint. Pruning one silently turns "your import was
 *    interrupted, click Resume" into "your import vanished". They're rare
 *    (only a crash creates them) and the rep can clear them by hand from
 *    the Activity Center, so keeping them costs nothing real.
 */
export function isProtected(job: Job): boolean {
  if (!isTerminal(job.state)) return true
  if (job.state === 'interrupted') return true
  return holdsUnreviewedOutput(job)
}

/** Successes are routine and disposable; a failure, a cancellation, or an
 *  interruption is the kind of thing someone might go back and investigate
 *  ("did that scan actually stop, or is it still going?"), so they are given
 *  up last. Lower tier = dropped first. */
function disposalTier(job: Job): number {
  return job.state === 'succeeded' ? 0 : 1
}

/** When a job finished, for oldest-first ordering. Falls back to createdAt
 *  for a record that somehow never got an endedAt (a hand-edited or
 *  partially-written state file), so ordering is always total. */
function finishedAt(job: Job): number {
  return job.endedAt ?? job.createdAt
}

/**
 * Which job ids should be dropped to get back under the cap, oldest and most
 * disposable first. Returns an empty array when nothing needs pruning.
 *
 * Protected jobs are never returned, even if that leaves the total ABOVE the
 * cap — the cap is a target for disposable history, not a hard limit that
 * justifies destroying unreviewed work. That case is self-correcting: those
 * jobs leave as soon as the rep reviews them.
 */
export function selectJobsToPrune(jobs: Job[], max: number = MAX_RETAINED_JOBS): string[] {
  if (jobs.length <= max) return []

  const prunable = jobs.filter((j) => !isProtected(j))
  const excess = jobs.length - max
  if (excess <= 0 || prunable.length === 0) return []

  const ordered = [...prunable].sort(
    (a, b) => disposalTier(a) - disposalTier(b) || finishedAt(a) - finishedAt(b)
  )
  return ordered.slice(0, Math.min(excess, ordered.length)).map((j) => j.id)
}
