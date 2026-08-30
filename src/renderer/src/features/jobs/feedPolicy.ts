import type { Job, JobLane, JobState } from '../../../../preload/index.d'

/**
 * What belongs in the Activity panel.
 *
 * Founder's ruling, 2026-08-29: **the Activity panel is a FEED, not a log.**
 * It shows things the user did, or things the app did on their behalf that
 * they would care about — not internal housekeeping. The test they gave:
 *
 *   > Would the user recognise this as something connected to an action they
 *   > took, or something they'd want to know happened? If yes, it belongs. If
 *   > it's the app tidying up after itself, it doesn't.
 *
 * ── WHY THIS IS A LANE TABLE AND NOT A PER-JOB FLAG ─────────────────────────
 *
 * The founder's constraint, and it is the whole design: *"If it's a per-job
 * flag, the first person to add a job without knowing the convention breaks
 * it."* That is the same reasoning as BUG-129's notification fix, which is a
 * LANE rule for exactly this reason ("marking each maintenance job
 * `silent: true` individually would work today and rot the moment someone adds
 * job number six without knowing").
 *
 * So the policy is a total function over `JobLane`. A new job type is filed
 * into a lane for SCHEDULING reasons — that decision is unavoidable and
 * everyone makes it — and its feed behaviour follows from it with no extra
 * knowledge required. Get the lane right and the feed is right.
 *
 * ── THE ONE EXCEPTION, AND WHY IT IS A LIST RATHER THAN A FLAG ──────────────
 *
 * The founder put updates IN the feed: *"Update progress and available updates
 * — that's genuinely relevant to them even though they didn't start it."* The
 * updater's download job lives in MAINTENANCE, which is otherwise silent.
 *
 * The tempting fix is to move it to BATCH so the lane rule needs no exception.
 * Rejected after checking what a lane actually controls: BATCH and MAINTENANCE
 * are both `maxConcurrent: 1`, so the download would start queueing behind
 * long batch work (and vice versa) — a real regression for updates, caused by
 * a UI cleanup. Scheduling and visibility are genuinely different questions
 * about a job; forcing one to encode the other is what would rot.
 *
 * So exceptions are a NAMED, CLOSED SET in this one file, next to the policy
 * they modify, pinned by a test. That still satisfies the constraint: someone
 * adding a job without knowing anything gets their lane's behaviour, and
 * departing from it is a deliberate, reviewable, single-file act rather than a
 * boolean they could forget to set.
 *
 * ── FAILURES ALWAYS SURFACE ────────────────────────────────────────────────
 *
 * Non-negotiable, and checked before anything else below: *"A feed that hides
 * a broken backup because 'the user didn't start it' is worse than the log.
 * The filter is about noise, not about hiding bad news."*
 */

/** Whether a lane's work is the kind a person would recognise as theirs. */
type LaneFeedPolicy =
  | 'always' // the user started it, or its output is theirs to collect
  | 'problems-only' // the app tidying up after itself: silent unless it breaks

const LANE_FEED_POLICY: Record<JobLane, LaneFeedPolicy> = {
  // The live call's own pipeline. Never in the feed at all — see below; this
  // entry exists so the record is total and a new lane cannot be added
  // without answering the question.
  LIVE: 'problems-only',
  // Everything the user pressed a button for: summarise, coach, generate
  // tasks, draft, import.
  INTERACTIVE: 'always',
  // Long-running work with real output to review or collect.
  BATCH: 'always',
  // Housekeeping: backup, cloud sync, calendar reconcile, embedding warm-up,
  // nightly consolidation. Runs every launch, means nothing to a person when
  // it works, matters a great deal when it doesn't.
  MAINTENANCE: 'problems-only'
}

/**
 * Job types whose lane's policy does not describe them.
 *
 * Keep this SMALL and justify every entry. If it grows past a handful, the
 * lane table is wrong and should be fixed instead of patched here.
 */
const FEED_ALWAYS_TYPES: ReadonlySet<string> = new Set([
  // Founder: "Update progress and available updates — that's genuinely
  // relevant to them even though they didn't start it." Lives in MAINTENANCE
  // for scheduling (it is background work with no AI purpose), which is the
  // right scheduling answer and the wrong visibility answer.
  'updater:download'
])

/** States that mean something went wrong and the user needs to know. */
const PROBLEM_STATES: ReadonlySet<JobState> = new Set<JobState>([
  'failed',
  // An interrupted job is unfinished work the user may need to resume — the
  // Activity panel is where the Resume button lives, so hiding it would
  // remove the only way to act on it.
  'interrupted'
])

/**
 * Does this job belong in the Activity feed?
 *
 * Note the deliberate ordering: the failure check comes FIRST, before any
 * filtering. Written this way so that no filter added later can accidentally
 * sit in front of it — a rule that hides bad news is the one failure mode this
 * whole change must not introduce.
 */
export function belongsInFeed(job: Pick<Job, 'lane' | 'state' | 'type'>): boolean {
  if (PROBLEM_STATES.has(job.state)) return true

  // The live call's own pipeline is never feed material even when it is fine:
  // its start/end would read as an odd "Test job — done" the instant every
  // call wraps up. (Its failures are still surfaced by the line above.)
  if (job.lane === 'LIVE') return false

  if (FEED_ALWAYS_TYPES.has(job.type)) return true
  return LANE_FEED_POLICY[job.lane] === 'always'
}

/** Exported for the guard test, so the exception list cannot silently grow. */
export const FEED_POLICY_INTERNALS = {
  LANE_FEED_POLICY,
  FEED_ALWAYS_TYPES,
  PROBLEM_STATES
} as const
