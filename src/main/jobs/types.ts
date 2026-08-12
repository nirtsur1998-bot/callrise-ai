/**
 * M26 — the shared vocabulary every part of the job system (the manager,
 * the store, the IPC surface, and every future adapter) is built from.
 */

export type JobLane = 'LIVE' | 'INTERACTIVE' | 'BATCH' | 'MAINTENANCE'

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'

/** Batch jobs report a real percent; single AI operations report a stage
 *  label instead of a fake percent (CLAUDE.md's "honest progress" rule).
 *  `indeterminate` is for the (hopefully rare) job that genuinely has
 *  neither yet — a spinner, not a lie. */
export type JobProgress =
  | { mode: 'determinate'; itemsDone: number; itemsTotal: number }
  | { mode: 'stages'; stageLabel: string }
  | { mode: 'indeterminate' }

export const INDETERMINATE_PROGRESS: JobProgress = { mode: 'indeterminate' }

export interface JobError {
  message: string
  /** Machine-readable where the job type has one (e.g. reused straight from
   *  AIProviderError's `code` — 'no-key' | 'rate-limit' | ... — see
   *  src/main/ai/types.ts) so a Retry affordance can tell "will never work
   *  without you doing something" from "worth trying again". */
  code?: string
}

export interface Job {
  id: string
  type: string
  title: string
  /** e.g. a call id, contact id — whatever the Activity Center should deep
   *  link to. Not always applicable (a scan over many calls has no single
   *  target). */
  targetRef?: string
  state: JobState
  progress: JobProgress
  lane: JobLane
  /** Higher runs first within its lane once capacity frees up. Default 0. */
  priority: number
  createdAt: number
  startedAt?: number
  endedAt?: number
  error?: JobError
  /** Deep link to the finished result (a call id, note id, ...) — set from
   *  whatever string the executor resolves with, if any. */
  resultRef?: string
  /** The executor's full resolved result, for job types whose output is
   *  more than a single deep-link string (e.g. Generate tasks' proposed-
   *  but-not-yet-saved task list). Must be JSON-serializable — persisted
   *  to disk the same as everything else on Job. Set unconditionally on
   *  success; most job types just leave it unread. This is what lets a
   *  screen treat the JOB as the source of truth for real AI output
   *  instead of its own transient state, so closing the screen before
   *  reviewing/saving can never lose already-paid-for work — reopening
   *  (or resuming after a full app restart) finds the same result here. */
  resultData?: unknown
  cancellable: boolean
  /** This job never produces its own toast/OS notification — it still shows
   *  in the Activity Center like everything else. For features that already
   *  ship a purpose-built completion notification of their own, whose
   *  wording is far more useful than a generic "X — done" (e.g. contact
   *  auto-attach's "Automatically created and attached 'Dana'"). Without
   *  this, migrating such a feature to a job silently doubles up its
   *  notifications. Copied from the job type at enqueue, same as
   *  `cancellable`. */
  silent?: boolean
  /** This job's resultData may hold output the rep still has to review, so
   *  automatic history pruning must never touch it while it's succeeded —
   *  it leaves only via its own "you've dealt with it" dismiss. Set for the
   *  job types behind BUG-048 (Generate tasks) and BUG-050 (Generate CRM
   *  note), whose whole fix is that already-paid-for AI output survives in
   *  a finished job until consumed. Copied from the job type at enqueue,
   *  same as `cancellable`/`silent`. See jobs/retention.ts. */
  retainUntilConsumed?: boolean
  /** The serializable input the executor was (or will be) called with.
   *  Kept so Retry can re-run a failed job identically. */
  input: unknown
  /** The last checkpoint an executor saved via `handle.checkpoint()`, if
   *  any — batch jobs only. Handed back as `handle.lastCheckpoint` when the
   *  job is Resumed after an interruption. */
  checkpoint?: unknown
}

export interface JobHandle {
  /** Aborts the instant the job is cancelled — thread this straight into
   *  every fetch/AI-call this job's work makes (src/main/ai's
   *  completeWithFallback/streamWithFallback already accept and forward one
   *  end to end, per the M26 Phase 0 research), and check `.aborted`
   *  between iterations of any loop. */
  signal: AbortSignal
  reportProgress: (progress: JobProgress) => void
  /** Persist a resumable checkpoint. Safe to call often — the manager
   *  coalesces the actual disk write, this never blocks on I/O. */
  checkpoint: (data: unknown) => void
  /** The checkpoint saved by a PREVIOUS, interrupted attempt at this exact
   *  job (Resume) — undefined on a first attempt, and undefined after Retry
   *  too (Retry starts clean under a brand new job id; only Resume
   *  continues one). */
  lastCheckpoint: unknown
}

export type JobExecutor<TInput = unknown, TResult = unknown> = (
  input: TInput,
  handle: JobHandle
) => Promise<TResult>

/** Which kind of thread a job type's work belongs on, per CLAUDE.md's
 *  "execution placement" rule: I/O-bound (awaited network/LLM calls) stays
 *  inline on main's own event loop; genuinely CPU-heavy work must never
 *  visibly freeze the app, so it runs on a separate OS thread instead. */
export type JobExecutorSpec<TInput = unknown, TResult = unknown> =
  | { kind: 'inline-async'; run: JobExecutor<TInput, TResult> }
  | {
      kind: 'worker'
      /** Self-contained JS source, run via `new Worker(source, { eval:
       *  true, workerData: input })` — no separate build entry needed
       *  (electron-vite/Rollup only knows about files reachable from
       *  src/main/index.ts's own module graph, and a standalone
       *  worker_threads script isn't one of those). This is a deliberate,
       *  scoped-for-now choice: nothing registered in Phase 1 or found in
       *  the Phase 0 inventory is CPU-heavy enough to need more than this.
       *  A future job type whose worker body grows large/complex enough to
       *  outgrow a source string should get a real build-configured entry
       *  instead — that's a build-config change, not a JobManager one.
       *  Contract the source string must follow: `require('node:worker_
       *  threads')` for `parentPort`/`workerData`, then
       *  `parentPort.postMessage({type:'progress',progress})`,
       *  `{type:'checkpoint',data}`, `{type:'result',result}`, or
       *  `{type:'error',message,code?}` — exactly one of the last two,
       *  exactly once, ends the job. */
      workerSource: string
    } // spawned as `new Worker(workerSource, { eval: true, workerData: { input, lastCheckpoint } })`

export interface JobTypeDefinition<TInput = unknown, TResult = unknown> {
  type: string
  lane: JobLane
  executor: JobExecutorSpec<TInput, TResult>
  /** Default true. Set false only for work with no meaningful mid-flight
   *  stopping point (rare — most jobs should stay cancellable). */
  cancellable?: boolean
  /** Default false. Set true when this feature already fires its own,
   *  better-worded completion notification — see Job.silent. */
  silent?: boolean
  /** Default false. Set true when a SUCCEEDED job of this type holds output
   *  the rep must review before it can be discarded — see
   *  Job.retainUntilConsumed and jobs/retention.ts. Getting this wrong for a
   *  new adapter fails LOUDLY and recoverably ("my draft disappeared sooner
   *  than I expected"), which is the deliberate trade against inferring it
   *  automatically — an inferred rule would change meaning silently as the
   *  code evolves and surface as missing customer data months later. */
  retainUntilConsumed?: boolean
  /** Human title for the Activity Center ("Coaching call with Dana"),
   *  computed from the input at enqueue time. */
  titleFor: (input: TInput) => string
  targetRefFor?: (input: TInput) => string | undefined
  /** A resolved TResult that is itself a string becomes Job.resultRef
   *  automatically; set this to pull it from a richer result shape
   *  instead (e.g. `(r) => r.callId`). */
  resultRefFor?: (result: TResult) => string | undefined
}

export interface EnqueueOptions {
  priority?: number
}

export interface LaneConfig {
  /** Use Infinity for a lane that must never be starved by concurrency
   *  limits at all (LIVE). */
  maxConcurrent: number
}

export const DEFAULT_LANE_CONFIG: Record<JobLane, LaneConfig> = {
  // Reserved for the active call's own pipeline — never queued behind
  // anything else, so it gets no shared concurrency pool to compete over.
  LIVE: { maxConcurrent: Number.POSITIVE_INFINITY },
  INTERACTIVE: { maxConcurrent: 2 },
  BATCH: { maxConcurrent: 1 },
  MAINTENANCE: { maxConcurrent: 1 }
}
