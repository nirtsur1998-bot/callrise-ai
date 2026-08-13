// M26 Phase 1 — the central job queue. Owns every job's lifecycle (queued
// -> running -> succeeded/failed/cancelled, or interrupted -> resumed),
// enforces per-lane concurrency so a batch scan can never starve a live
// call or flood an AI provider, threads cancellation through to the actual
// work, and persists enough state that a crash or force-quit shows up as
// "interrupted", never silent data loss.
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import {
  DEFAULT_LANE_CONFIG,
  INDETERMINATE_PROGRESS,
  type EnqueueOptions,
  type Job,
  type JobHandle,
  type JobLane,
  type JobProgress,
  type JobTypeDefinition,
  type LaneConfig
} from './types'
import { loadJobs, saveJobs } from './store'
import {
  MAX_RETAINED_JOBS,
  holdsUnreviewedOutput,
  isTerminal,
  selectJobsToPrune
} from './retention'
import { throttle } from './throttle'

const LANES: JobLane[] = ['LIVE', 'INTERACTIVE', 'BATCH', 'MAINTENANCE']
/** How often job-list state is actually written to disk, at most — cheap
 *  in-memory updates (progress ticks, etc.) can happen far more often
 *  without hammering the filesystem. Independent of the ~4/sec IPC
 *  broadcast throttle in jobs/ipc.ts, which throttles renderer traffic, not
 *  disk I/O. */
const PERSIST_THROTTLE_MS = 250

interface RunningEntry {
  controller: AbortController
  worker?: Worker
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Pulls a machine-readable code off any thrown error that has one (e.g.
 *  AIProviderError's `code` — 'no-key' | 'rate-limit' | ... — see
 *  src/main/ai/types.ts), without JobManager needing to import or know
 *  about any specific feature's error type. This is the wiring
 *  JobError.code's own doc comment already promises but that never
 *  actually existed until an adapter needed to preserve a "no API key
 *  configured" distinction through the job system (see calls.ts's
 *  summarize/coach/commitments adapters). */
function errorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object' || !('code' in err)) return undefined
  const code = (err as { code: unknown }).code
  return typeof code === 'string' ? code : undefined
}

export class JobManager {
  private jobs = new Map<string, Job>()
  private order: string[] = [] // insertion order, oldest first — stable listing
  private types = new Map<string, JobTypeDefinition>()
  private running = new Map<string, RunningEntry>()
  private laneConfig: Record<JobLane, LaneConfig> = { ...DEFAULT_LANE_CONFIG }
  private listeners = new Set<(jobs: Job[]) => void>()
  // leading: false — see throttle()'s own doc comment: this makes dispose()'s
  // cancel() a real guarantee (no write can already be mid-flight when it
  // runs), which matters more here than shaving the first write's latency.
  private persistThrottled = throttle(() => void this.flush(), PERSIST_THROTTLE_MS, {
    leading: false
  })

  /** Cap on retained history. Overridable so tests can exercise pruning
   *  with a handful of jobs instead of 500+ — building fixtures that large
   *  is slow enough to cross the persist throttle mid-test and race the
   *  temp-directory teardown, which is noise, not signal. Production always
   *  uses the default. */
  private maxRetainedJobs: number

  constructor(initialJobs: Job[] = loadJobs(), opts: { maxRetainedJobs?: number } = {}) {
    this.maxRetainedJobs = opts.maxRetainedJobs ?? MAX_RETAINED_JOBS
    for (const j of initialJobs) {
      this.jobs.set(j.id, j)
      this.order.push(j.id)
    }
  }

  // The internal registry is necessarily heterogeneous (every job type has
  // its own TInput/TResult) — callers get full type safety at the call
  // site; the Map itself, like Job.input/Job.checkpoint, is untyped past
  // that boundary by design (mirrors how JobHandle/Job themselves already
  // erase to `unknown`).
  registerType<TInput, TResult>(def: JobTypeDefinition<TInput, TResult>): void {
    this.types.set(def.type, def as unknown as JobTypeDefinition)
  }

  configureLanes(overrides: Partial<Record<JobLane, LaneConfig>>): void {
    this.laneConfig = { ...this.laneConfig, ...overrides }
    this.tick()
  }

  list(): Job[] {
    const out: Job[] = []
    for (const id of this.order) {
      const j = this.jobs.get(id)
      if (j) out.push(j)
    }
    return out
  }

  get(id: string): Job | null {
    return this.jobs.get(id) ?? null
  }

  onChange(cb: (jobs: Job[]) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  enqueue<TInput = unknown>(type: string, input: TInput, opts: EnqueueOptions = {}): Job {
    const def = this.types.get(type)
    if (!def) throw new Error(`Unknown job type: ${type}`)
    const job: Job = {
      id: randomUUID(),
      type,
      title: def.titleFor(input),
      targetRef: def.targetRefFor?.(input),
      state: 'queued',
      progress: INDETERMINATE_PROGRESS,
      lane: def.lane,
      priority: opts.priority ?? 0,
      createdAt: Date.now(),
      // BUG-060 — defaults to FALSE, deliberately inverted.
      //
      // This defaulted to `true`, so every job type got a Cancel button for
      // free whether or not its executor had wired the signal up. The audit:
      // 10 of 12 registered types offered the button, exactly ONE adapter
      // checked the signal at all, and the only two honest ones were honest
      // because someone explicitly opted out. Pressing Cancel marked the job
      // cancelled while the work ran on, still spending the user's API key.
      //
      // A forgotten flag must fail as "this feature is MISSING" — visible,
      // someone reports it — never as "this feature silently doesn't work",
      // which stays invisible for months. Defaulting to true failed in the
      // wrong direction. Now an adapter author who does nothing ships a job
      // with no Cancel button, and setting this to `true` is a deliberate act
      // — which is exactly the moment to ask "did I thread handle.signal into
      // the work?" (see the doc comment on cancel() below).
      cancellable: def.cancellable ?? false,
      silent: def.silent ?? false,
      retainUntilConsumed: def.retainUntilConsumed ?? false,
      input
    }
    this.jobs.set(job.id, job)
    this.order.push(job.id)
    this.notify()
    this.tick()
    return job
  }

  /** Cancel a queued or running job. No-op (returns false) for a job that's
   *  already terminal, unknown, or explicitly marked non-cancellable.
   *
   *  Cancellation is cooperative for 'inline-async' job types: this aborts
   *  the signal handed to the executor, but nothing in JavaScript can force
   *  a running Promise chain to actually stop — an executor that never
   *  checks `handle.signal`/never threads it into its own awaited calls
   *  will simply keep running to completion regardless of what this
   *  returns. Every real adapter MUST wire the signal through (into
   *  completeWithFallback's `req.signal`, an abortable sleep, a loop's own
   *  `if (signal.aborted) throw`, ...) for cancel to mean anything. 'worker'
   *  job types are the one case this is NOT true for — worker.terminate()
   *  really does kill a non-cooperative worker outright, which is the
   *  other reason (besides "never freeze the app") a genuinely long-running
   *  CPU-bound job type should prefer that kind. */
  cancel(id: string): boolean {
    const job = this.jobs.get(id)
    if (!job) return false
    if (job.state === 'queued') {
      this.transition(job, { state: 'cancelled', endedAt: Date.now() })
      this.tick()
      return true
    }
    if (job.state !== 'running' || !job.cancellable) return false
    const entry = this.running.get(id)
    if (!entry) return false
    entry.controller.abort()
    void entry.worker?.terminate()
    return true
  }

  /** Re-run a finished (failed/cancelled) job from scratch, under a brand
   *  new id — the original stays in history, so the failure and the retry's
   *  own outcome are both visible in Recent. */
  retry(id: string): Job | null {
    const job = this.jobs.get(id)
    if (!job || (job.state !== 'failed' && job.state !== 'cancelled')) return null
    return this.enqueue(job.type, job.input, { priority: job.priority })
  }

  /** Continue an interrupted job under its OWN id and checkpoint. Only
   *  valid from `interrupted` (set on load when a job was `running` when
   *  the app last quit/crashed — see store.ts). */
  resume(id: string): Job | null {
    const job = this.jobs.get(id)
    if (!job || job.state !== 'interrupted') return null
    this.transition(job, {
      state: 'queued',
      startedAt: undefined,
      endedAt: undefined,
      error: undefined
    })
    this.tick()
    return job
  }

  /** Remove a finished job from the list (Activity Center's "clear
   *  history"). Refuses on anything still active — dismiss is for history,
   *  not for stopping work; use cancel() for that.
   *
   *  ALSO refuses a succeeded job that still holds unreviewed output
   *  (`retainUntilConsumed`), unless the caller passes `consumed: true`.
   *
   *  This guard lives HERE, not in each screen, on purpose. "Clear history"
   *  in the Activity Center loops dismiss() over everything in Recent —
   *  which includes a finished Generate tasks / Generate CRM note job whose
   *  resultData is the ONLY copy of already-paid-for AI output the rep
   *  hasn't looked at yet. One click, no confirmation, and it was gone
   *  (BUG-052): the same data loss as BUG-048/BUG-050 through a different
   *  door, plus a silent re-run and re-bill of the AI call, because both
   *  adapters' dedupe treats a succeeded job as "already there". Putting
   *  the check at this layer means every future job type is protected by
   *  default rather than depending on someone remembering to add it.
   *
   *  `consumed: true` is deliberately NOT reachable over the generic
   *  `jobs:dismiss` IPC — only a feature's own main-process code, which
   *  actually knows the rep is done with the output, passes it (see
   *  crm-note-generator-ipc's recordDecision and tasks.ts's
   *  markGenerationConsumed). */
  dismiss(id: string, opts: { consumed?: boolean } = {}): boolean {
    const job = this.jobs.get(id)
    if (!job || job.state === 'queued' || job.state === 'running') return false
    if (!opts.consumed && holdsUnreviewedOutput(job)) return false
    this.jobs.delete(id)
    this.order = this.order.filter((x) => x !== id)
    this.notify()
    this.persistThrottled.call()
    return true
  }

  /** Replace a FINISHED job's resultData, persisting it like any other job
   *  state change.
   *
   *  For job types whose result is reviewed incrementally rather than
   *  consumed in one go: the executor produces the AI output, and the rep's
   *  decisions ABOUT that output (accepted this, skipped that, saved the
   *  note) have to live somewhere durable too, or a reopen can't tell what's
   *  already been dealt with. Keeping them on the job means one source of
   *  truth for the whole review, surviving an app restart with the output
   *  itself — see crm-note-review.ts, the first user of this.
   *
   *  Deliberately refuses on a queued/running job: while an executor is
   *  alive it owns its own result, and letting an IPC handler race a
   *  finishSuccess() write would make which value survives a coin flip. */
  setResultData(id: string, data: unknown): boolean {
    const job = this.jobs.get(id)
    if (!job || job.state === 'queued' || job.state === 'running') return false
    this.transition(job, { resultData: data })
    return true
  }

  /** Write the current state to disk right now, bypassing the throttle —
   *  called on app quit so nothing since the last throttled write is lost. */
  async flush(): Promise<void> {
    this.persistThrottled.cancel()
    await saveJobs(this.list())
  }

  /** Abort every in-flight job's work (does not wait for them to actually
   *  stop) and cancel any pending throttled persist so it can't fire later
   *  against a manager nobody owns anymore. Call flush() after, not before,
   *  if you want a final write — this method deliberately does not persist
   *  anything itself. */
  dispose(): void {
    this.persistThrottled.cancel()
    for (const entry of this.running.values()) {
      entry.controller.abort()
      void entry.worker?.terminate()
    }
  }

  // --- scheduling ------------------------------------------------------

  private runningCountInLane(lane: JobLane): number {
    let n = 0
    for (const id of this.running.keys()) {
      if (this.jobs.get(id)?.lane === lane) n++
    }
    return n
  }

  /** Fill every lane's free capacity with its highest-priority queued jobs.
   *  Lanes are independent pools — LIVE's own (effectively unlimited)
   *  capacity is never shared with or blocked by the other three, which is
   *  what actually guarantees "nothing else may starve it" rather than
   *  relying on priority numbers alone. */
  private tick(): void {
    for (const lane of LANES) {
      let capacity = this.laneConfig[lane].maxConcurrent - this.runningCountInLane(lane)
      if (!(capacity > 0)) continue
      const queued = this.list()
        .filter((j) => j.lane === lane && j.state === 'queued')
        .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)
      for (const job of queued) {
        if (capacity <= 0) break
        this.start(job)
        capacity--
      }
    }
  }

  private start(job: Job): void {
    const def = this.types.get(job.type)
    if (!def) {
      // A job type from a previous install that no longer exists (or a
      // corrupt record) — fail it loudly rather than looping on it forever.
      this.transition(job, {
        state: 'failed',
        endedAt: Date.now(),
        error: { message: `Unknown job type: ${job.type}` }
      })
      return
    }
    const controller = new AbortController()
    const lastCheckpoint = job.checkpoint
    this.transition(job, { state: 'running', startedAt: Date.now(), error: undefined })

    const handle: JobHandle = {
      signal: controller.signal,
      reportProgress: (progress: JobProgress) => {
        const current = this.jobs.get(job.id)
        if (!current || current.state !== 'running') return
        current.progress = progress
        this.notify()
        this.persistThrottled.call()
      },
      checkpoint: (data: unknown) => {
        const current = this.jobs.get(job.id)
        if (!current) return
        current.checkpoint = data
        this.persistThrottled.call()
      },
      lastCheckpoint
    }

    if (def.executor.kind === 'inline-async') {
      this.running.set(job.id, { controller })
      def.executor
        .run(job.input, handle)
        .then((result) => this.finishSuccess(job.id, def, result))
        .catch((err: unknown) => this.finishFailure(job.id, controller.signal, err))
    } else {
      this.runWorker(job, def, controller, lastCheckpoint)
    }
  }

  private runWorker(
    job: Job,
    def: JobTypeDefinition,
    controller: AbortController,
    lastCheckpoint: unknown
  ): void {
    if (def.executor.kind !== 'worker') return
    let worker: Worker
    try {
      worker = new Worker(def.executor.workerSource, {
        eval: true,
        workerData: { input: job.input, lastCheckpoint }
      })
    } catch (err) {
      this.finishFailure(job.id, controller.signal, err)
      return
    }
    this.running.set(job.id, { controller, worker })
    controller.signal.addEventListener('abort', () => void worker.terminate())

    worker.on('message', (msg: unknown) => {
      const m = (msg && typeof msg === 'object' ? msg : {}) as Record<string, unknown>
      if (m.type === 'progress') {
        const current = this.jobs.get(job.id)
        if (current && current.state === 'running') {
          current.progress = m.progress as JobProgress
          this.notify()
          this.persistThrottled.call()
        }
      } else if (m.type === 'checkpoint') {
        const current = this.jobs.get(job.id)
        if (current) {
          current.checkpoint = m.data
          this.persistThrottled.call()
        }
      } else if (m.type === 'result') {
        this.finishSuccess(job.id, def, m.result)
      } else if (m.type === 'error') {
        this.finishFailure(
          job.id,
          controller.signal,
          new Error(typeof m.message === 'string' ? m.message : 'Worker job failed')
        )
      }
    })
    worker.on('error', (err) => this.finishFailure(job.id, controller.signal, err))
  }

  private finishSuccess(id: string, def: JobTypeDefinition, result: unknown): void {
    const job = this.jobs.get(id)
    if (!job) return
    this.running.delete(id)
    const resultRef: string | undefined =
      typeof result === 'string' ? result : def.resultRefFor?.(result as never)
    // A determinate job that succeeds is DONE, even if its last reported
    // tick was a beat behind the final item — never leave "9 / 10" on
    // screen for a job that actually finished.
    const progress: JobProgress =
      job.progress.mode === 'determinate'
        ? {
            mode: 'determinate',
            itemsDone: job.progress.itemsTotal,
            itemsTotal: job.progress.itemsTotal
          }
        : job.progress
    this.transition(job, {
      state: 'succeeded',
      endedAt: Date.now(),
      resultRef,
      resultData: result,
      progress
    })
    this.tick()
  }

  private finishFailure(id: string, signal: AbortSignal, err: unknown): void {
    const job = this.jobs.get(id)
    if (!job) return
    this.running.delete(id)
    if (signal.aborted) {
      this.transition(job, { state: 'cancelled', endedAt: Date.now() })
    } else {
      this.transition(job, {
        state: 'failed',
        endedAt: Date.now(),
        error: { message: errorMessage(err), code: errorCode(err) }
      })
    }
    this.tick()
  }

  private transition(job: Job, patch: Partial<Job>): void {
    Object.assign(job, patch)
    if (isTerminal(job.state)) this.pruneHistory()
    this.notify()
    this.persistThrottled.call()
  }

  /** Drop the oldest disposable history once it exceeds the cap. Runs only
   *  when a job reaches a terminal state (the only moment the retained set
   *  can grow), never on a progress tick.
   *
   *  Deliberately does NOT notify() or persist here — the caller does both
   *  immediately after, so a prune always rides along with the transition
   *  that caused it rather than emitting a second, half-applied snapshot.
   *  See retention.ts for what may and may not be dropped; the short
   *  version is that a succeeded job still holding unreviewed AI output is
   *  never touched. */
  private pruneHistory(): void {
    const doomed = selectJobsToPrune(this.list(), this.maxRetainedJobs)
    if (doomed.length === 0) return
    for (const id of doomed) this.jobs.delete(id)
    const dropped = new Set(doomed)
    this.order = this.order.filter((id) => !dropped.has(id))
  }

  private notify(): void {
    const snapshot = this.list()
    for (const cb of this.listeners) cb(snapshot)
  }
}
