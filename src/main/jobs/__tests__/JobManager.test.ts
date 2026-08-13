// IPC-broadcast throttling itself is covered by throttle.test.ts (the exact
// same utility jobs/ipc.ts wraps around JobManager.onChange) — this file
// covers what CLAUDE.md's testing section asks for on the manager itself:
// lane scheduling, priority, cancellation propagation, and checkpoint/
// resume math, including a real crash-and-restart round trip through the
// actual on-disk store.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job, JobHandle } from '../types'

let dir: string
vi.mock('electron', () => ({
  app: { getPath: () => dir }
}))

async function freshManager(): Promise<{
  JobManager: typeof import('../JobManager').JobManager
  saveJobs: typeof import('../store').saveJobs
  loadJobs: typeof import('../store').loadJobs
}> {
  vi.resetModules()
  const [{ JobManager }, { saveJobs, loadJobs }] = await Promise.all([
    import('../JobManager'),
    import('../store')
  ])
  return { JobManager, saveJobs, loadJobs }
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** Flush pending microtasks AND at least one macrotask turn — enough for a
 *  resolved promise's .then() chain (executor -> finishSuccess/Failure ->
 *  tick) to have fully run. */
function settle(): Promise<void> {
  return new Promise((r) => setImmediate(r))
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'callrise-jobmanager-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('lane scheduling', () => {
  it('runs at most maxConcurrent jobs per lane at once, queuing the rest', async () => {
    const { JobManager } = await freshManager()
    const manager = new JobManager([])
    const gates = new Map<string, ReturnType<typeof deferred<string>>>()
    manager.registerType<{ id: string }, string>({
      type: 'test:hold',
      lane: 'INTERACTIVE', // default maxConcurrent 2
      titleFor: (i) => i.id,
      executor: {
        kind: 'inline-async',
        run: async (input) => {
          const gate = deferred<string>()
          gates.set(input.id, gate)
          return gate.promise
        }
      }
    })

    const j1 = manager.enqueue('test:hold', { id: 'j1' })
    const j2 = manager.enqueue('test:hold', { id: 'j2' })
    const j3 = manager.enqueue('test:hold', { id: 'j3' })

    expect(manager.get(j1.id)?.state).toBe('running')
    expect(manager.get(j2.id)?.state).toBe('running')
    expect(manager.get(j3.id)?.state).toBe('queued') // capacity is 2, third waits

    gates.get('j1')!.resolve('done-j1')
    await settle()

    expect(manager.get(j1.id)?.state).toBe('succeeded')
    expect(manager.get(j3.id)?.state).toBe('running') // freed slot immediately picked up

    gates.get('j2')!.resolve('done-j2')
    gates.get('j3')!.resolve('done-j3')
    await settle()
    expect(manager.get(j2.id)?.state).toBe('succeeded')
    expect(manager.get(j3.id)?.state).toBe('succeeded')
    manager.dispose()
  })

  it('never lets a LIVE job wait behind other lanes', async () => {
    const { JobManager } = await freshManager()
    const manager = new JobManager([])
    manager.registerType<Record<string, never>, string>({
      type: 'test:live',
      lane: 'LIVE',
      titleFor: () => 'live',
      executor: { kind: 'inline-async', run: async () => 'ok' }
    })
    // Saturate every other lane at once — none of this should matter to LIVE.
    manager.registerType<Record<string, never>, string>({
      type: 'test:blockBatch',
      lane: 'BATCH',
      titleFor: () => 'blocker',
      executor: { kind: 'inline-async', run: () => new Promise<string>(() => {}) }
    })
    manager.enqueue('test:blockBatch', {})
    manager.enqueue('test:blockBatch', {}) // second one queues behind BATCH's own limit of 1

    const live = manager.enqueue('test:live', {})
    expect(manager.get(live.id)?.state).toBe('running')
    manager.dispose()
  })
})

describe('priority', () => {
  it('a higher-priority queued job runs before an earlier-enqueued lower-priority one', async () => {
    const { JobManager } = await freshManager()
    const manager = new JobManager([])
    const gates = new Map<string, ReturnType<typeof deferred<string>>>()
    manager.registerType<{ id: string }, string>({
      type: 'test:hold1',
      lane: 'BATCH', // maxConcurrent 1 — makes ordering observable
      titleFor: (i) => i.id,
      executor: {
        kind: 'inline-async',
        run: async (input) => {
          const gate = deferred<string>()
          gates.set(input.id, gate)
          return gate.promise
        }
      }
    })

    const first = manager.enqueue('test:hold1', { id: 'first' }) // occupies the only slot
    expect(first.state).toBe('running')
    const low = manager.enqueue('test:hold1', { id: 'low' }, { priority: 0 })
    const high = manager.enqueue('test:hold1', { id: 'high' }, { priority: 5 })
    expect(manager.get(low.id)?.state).toBe('queued')
    expect(manager.get(high.id)?.state).toBe('queued')

    gates.get('first')!.resolve('done')
    await settle()

    expect(manager.get(high.id)?.state).toBe('running') // priority wins over arrival order
    expect(manager.get(low.id)?.state).toBe('queued')
    manager.dispose()
  })
})

describe('cancellation propagation', () => {
  it('cancel() aborts the signal the executor was handed, and the job ends cancelled — not failed', async () => {
    const { JobManager } = await freshManager()
    const manager = new JobManager([])
    let sawAbort = false
    manager.registerType<Record<string, never>, string>({
      type: 'test:cancellable',
      lane: 'INTERACTIVE',
      titleFor: () => 'cancellable',
      // BUG-060 — `cancellable` now defaults to FALSE, so a type must opt in.
      // This executor genuinely honours handle.signal (below), so it
      // qualifies. That this test broke the instant the default flipped is
      // the inversion working: cancel() refuses a type that never opted in.
      cancellable: true,
      executor: {
        kind: 'inline-async',
        run: (_input, handle: JobHandle) =>
          new Promise<string>((_resolve, reject) => {
            handle.signal.addEventListener('abort', () => {
              sawAbort = true
              reject(new DOMException('Aborted', 'AbortError'))
            })
          })
      }
    })

    const job = manager.enqueue('test:cancellable', {})
    expect(manager.cancel(job.id)).toBe(true)
    await settle()

    expect(sawAbort).toBe(true)
    expect(manager.get(job.id)?.state).toBe('cancelled')
    manager.dispose()
  })

  it('cancelling a merely-queued job (never started) marks it cancelled without ever running it', async () => {
    const { JobManager } = await freshManager()
    const manager = new JobManager([])
    let ran = false
    manager.registerType<Record<string, never>, string>({
      type: 'test:blocker',
      lane: 'BATCH',
      titleFor: () => 'blocker',
      executor: { kind: 'inline-async', run: () => new Promise<string>(() => {}) }
    })
    manager.registerType<Record<string, never>, string>({
      type: 'test:neverRuns',
      lane: 'BATCH', // same lane, maxConcurrent 1 — stays queued behind the blocker
      titleFor: () => 'never',
      executor: {
        kind: 'inline-async',
        run: async () => {
          ran = true
          return 'ok'
        }
      }
    })
    manager.enqueue('test:blocker', {})
    const queued = manager.enqueue('test:neverRuns', {})
    expect(manager.get(queued.id)?.state).toBe('queued')

    expect(manager.cancel(queued.id)).toBe(true)
    await settle()
    expect(manager.get(queued.id)?.state).toBe('cancelled')
    expect(ran).toBe(false)
    manager.dispose()
  })

  it('a real (non-abort) failure is reported as failed, distinct from a cancellation', async () => {
    const { JobManager } = await freshManager()
    const manager = new JobManager([])
    manager.registerType<Record<string, never>, string>({
      type: 'test:fails',
      lane: 'INTERACTIVE',
      titleFor: () => 'fails',
      executor: {
        kind: 'inline-async',
        run: async () => {
          throw new Error('boom')
        }
      }
    })
    const job = manager.enqueue('test:fails', {})
    await settle()
    const final = manager.get(job.id)
    expect(final?.state).toBe('failed')
    expect(final?.error?.message).toBe('boom')
    manager.dispose()
  })

  it('carries a machine-readable error.code through when the thrown error has one (e.g. AIProviderError-style)', async () => {
    const { JobManager } = await freshManager()
    const manager = new JobManager([])
    manager.registerType<Record<string, never>, string>({
      type: 'test:failsWithCode',
      lane: 'INTERACTIVE',
      titleFor: () => 'fails with code',
      executor: {
        kind: 'inline-async',
        run: async () => {
          throw Object.assign(new Error('No AI key configured'), { code: 'no-key' })
        }
      }
    })
    const job = manager.enqueue('test:failsWithCode', {})
    await settle()
    const final = manager.get(job.id)
    expect(final?.error).toEqual({ message: 'No AI key configured', code: 'no-key' })
    manager.dispose()
  })

  it('leaves error.code undefined when the thrown error has none (a plain Error, say)', async () => {
    const { JobManager } = await freshManager()
    const manager = new JobManager([])
    manager.registerType<Record<string, never>, string>({
      type: 'test:failsPlain',
      lane: 'INTERACTIVE',
      titleFor: () => 'fails plain',
      executor: {
        kind: 'inline-async',
        run: async () => {
          throw new Error('just a plain failure')
        }
      }
    })
    const job = manager.enqueue('test:failsPlain', {})
    await settle()
    expect(manager.get(job.id)?.error).toEqual({ message: 'just a plain failure', code: undefined })
    manager.dispose()
  })
})

describe('checkpoint / resume', () => {
  it('resumes an interrupted job from its last checkpoint, not from scratch', async () => {
    const { JobManager, saveJobs, loadJobs } = await freshManager()

    // Simulate a crash: a batch job got to item 3 of 5 and checkpointed each
    // step, then the process died mid-flight — persisted state still says
    // "running" (nothing ever got the chance to mark it otherwise).
    const crashedJob: Job = {
      id: 'crashed-1',
      type: 'test:resumable',
      title: 'Resumable batch',
      state: 'running',
      progress: { mode: 'determinate', itemsDone: 3, itemsTotal: 5 },
      lane: 'BATCH',
      priority: 0,
      createdAt: 1000,
      startedAt: 1000,
      cancellable: true,
      input: { itemsTotal: 5 },
      checkpoint: 3
    }
    await saveJobs([crashedJob])

    // A fresh app launch: load from disk (this is where running -> interrupted
    // actually happens, per store.ts), then hand it to a brand new manager.
    const manager = new JobManager(loadJobs())
    const interrupted = manager.get('crashed-1')
    expect(interrupted?.state).toBe('interrupted')
    expect(interrupted?.checkpoint).toBe(3)

    const seenStartAt: number[] = []
    const itemsProcessed: number[] = []
    manager.registerType<{ itemsTotal: number }, string>({
      type: 'test:resumable',
      lane: 'BATCH',
      titleFor: () => 'Resumable batch',
      executor: {
        kind: 'inline-async',
        run: async (input, handle) => {
          const startAt = typeof handle.lastCheckpoint === 'number' ? handle.lastCheckpoint : 0
          seenStartAt.push(startAt)
          for (let i = startAt; i < input.itemsTotal; i++) {
            itemsProcessed.push(i)
            handle.checkpoint(i + 1)
            handle.reportProgress({
              mode: 'determinate',
              itemsDone: i + 1,
              itemsTotal: input.itemsTotal
            })
          }
          return 'resumable-done'
        }
      }
    })

    // resume() transitions to 'queued' and immediately ticks the scheduler
    // in the same call — with BATCH's slot free, the returned reference
    // (jobs are mutated in place, not cloned) already reflects 'running' by
    // the time this line runs, which is itself the behavior worth asserting:
    // an interrupted job with free capacity resumes without waiting around.
    const resumed = manager.resume('crashed-1')
    expect(resumed?.state).toBe('running')
    await settle()

    expect(seenStartAt).toEqual([3]) // handed back exactly the saved checkpoint
    expect(itemsProcessed).toEqual([3, 4]) // continued from item 3, never re-did 0-2
    expect(manager.get('crashed-1')?.state).toBe('succeeded')
    expect(manager.get('crashed-1')?.progress).toEqual({
      mode: 'determinate',
      itemsDone: 5,
      itemsTotal: 5
    })
    manager.dispose()
  })

  it('resume() only accepts a job actually in the interrupted state', async () => {
    const { JobManager } = await freshManager()
    const manager = new JobManager([])
    manager.registerType<Record<string, never>, string>({
      type: 'test:quick',
      lane: 'INTERACTIVE',
      titleFor: () => 'quick',
      executor: { kind: 'inline-async', run: async () => 'ok' }
    })
    const job = manager.enqueue('test:quick', {})
    await settle()
    expect(manager.get(job.id)?.state).toBe('succeeded')
    expect(manager.resume(job.id)).toBeNull() // succeeded, not interrupted — refused
    manager.dispose()
  })

  it('retry() re-runs a failed job under a NEW id, leaving the original in history', async () => {
    const { JobManager } = await freshManager()
    const manager = new JobManager([])
    let attempts = 0
    manager.registerType<{ n: number }, string>({
      type: 'test:flaky',
      lane: 'INTERACTIVE',
      titleFor: (i) => `flaky ${i.n}`,
      executor: {
        kind: 'inline-async',
        run: async () => {
          attempts++
          if (attempts === 1) throw new Error('first attempt fails')
          return 'ok-on-retry'
        }
      }
    })
    const first = manager.enqueue('test:flaky', { n: 1 })
    await settle()
    expect(manager.get(first.id)?.state).toBe('failed')

    const retried = manager.retry(first.id)
    expect(retried?.id).not.toBe(first.id)
    await settle()

    expect(manager.get(first.id)?.state).toBe('failed') // untouched — still visible in history
    expect(manager.get(retried!.id)?.state).toBe('succeeded')
    manager.dispose()
  })
})

describe('dismiss', () => {
  it('refuses to dismiss a queued or running job, but allows any terminal state', async () => {
    const { JobManager } = await freshManager()
    const manager = new JobManager([])
    // Must actually honor the abort signal to reach 'cancelled' at all — an
    // inline-async executor that ignores it can never be force-stopped
    // (see cancel()'s own doc comment on cooperative cancellation).
    manager.registerType<Record<string, never>, string>({
      type: 'test:cooperativeBlocker',
      lane: 'BATCH',
      titleFor: () => 'blocker',
      // BUG-060 — must opt in now that the default is false; this executor
      // does honour the signal, which is the whole point of the fixture.
      cancellable: true,
      executor: {
        kind: 'inline-async',
        run: (_input, handle) =>
          new Promise<string>((_resolve, reject) => {
            handle.signal.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError'))
            )
          })
      }
    })
    const running = manager.enqueue('test:cooperativeBlocker', {})
    expect(manager.dismiss(running.id)).toBe(false)
    expect(manager.get(running.id)).not.toBeNull()

    expect(manager.cancel(running.id)).toBe(true)
    await settle()
    expect(manager.get(running.id)?.state).toBe('cancelled')
    expect(manager.dismiss(running.id)).toBe(true)
    expect(manager.get(running.id)).toBeNull()
    manager.dispose()
  })
})

describe('enqueue', () => {
  it('throws for an unregistered job type rather than silently no-op-ing', async () => {
    const { JobManager } = await freshManager()
    const manager = new JobManager([])
    expect(() => manager.enqueue('does-not-exist', {})).toThrow(/Unknown job type/)
    manager.dispose()
  })
})

describe('dismiss — unreviewed output cannot be cleared from generic history UI (BUG-052)', () => {
  // The Activity Center's "Clear history" loops dismiss() over everything in
  // Recent. A finished Generate tasks / Generate CRM note job whose
  // resultData is the ONLY copy of already-paid-for AI output is in Recent.
  // One click used to destroy it — no confirmation, no error, and a silent
  // re-run/re-bill next time, since both adapters treat a succeeded job as
  // "already generated".
  async function managerWithDraft(): Promise<{
    manager: InstanceType<typeof import('../JobManager').JobManager>
    draftId: string
    plainId: string
  }> {
    const { JobManager } = await freshManager()
    const manager = new JobManager([])
    manager.registerType<Record<string, never>, { tasks: string[] }>({
      type: 'test:draft',
      lane: 'INTERACTIVE',
      titleFor: () => 'draft',
      retainUntilConsumed: true,
      executor: { kind: 'inline-async', run: async () => ({ tasks: ['send pricing'] }) }
    })
    manager.registerType<Record<string, never>, string>({
      type: 'test:plain',
      lane: 'INTERACTIVE',
      titleFor: () => 'plain',
      executor: { kind: 'inline-async', run: async () => 'ok' }
    })
    const draft = manager.enqueue('test:draft', {})
    const plain = manager.enqueue('test:plain', {})
    await settle()
    return { manager, draftId: draft.id, plainId: plain.id }
  }

  it('REFUSES a plain dismiss of a job still holding unreviewed output', async () => {
    const { manager, draftId } = await managerWithDraft()
    expect(manager.dismiss(draftId)).toBe(false)
    expect(manager.get(draftId)).not.toBeNull()
    expect(manager.get(draftId)?.resultData).toEqual({ tasks: ['send pricing'] })
    manager.dispose()
  })

  it('still allows dismissing an ordinary finished job — the guard is narrow, not a blanket freeze', async () => {
    const { manager, plainId } = await managerWithDraft()
    expect(manager.dismiss(plainId)).toBe(true)
    expect(manager.get(plainId)).toBeNull()
    manager.dispose()
  })

  it('allows it once the feature marks the output consumed', async () => {
    const { manager, draftId } = await managerWithDraft()
    expect(manager.dismiss(draftId)).toBe(false)
    expect(manager.dismiss(draftId, { consumed: true })).toBe(true)
    expect(manager.get(draftId)).toBeNull()
    manager.dispose()
  })

  it('a FAILED job of a retain-until-consumed type dismisses freely — a failed run produced no output to lose', async () => {
    const { JobManager } = await freshManager()
    const manager = new JobManager([])
    manager.registerType<Record<string, never>, string>({
      type: 'test:failingDraft',
      lane: 'INTERACTIVE',
      titleFor: () => 'failing draft',
      retainUntilConsumed: true,
      executor: {
        kind: 'inline-async',
        run: async () => {
          throw new Error('nope')
        }
      }
    })
    const job = manager.enqueue('test:failingDraft', {})
    await settle()
    expect(manager.get(job.id)?.state).toBe('failed')
    expect(manager.dismiss(job.id)).toBe(true)
    manager.dispose()
  })

  it('a whole "Clear history" sweep leaves the draft and takes everything else', async () => {
    const { manager, draftId, plainId } = await managerWithDraft()
    // Exactly what ActivityCenter.clearHistory does: dismiss every finished job.
    for (const job of manager.list()) manager.dismiss(job.id)

    expect(manager.get(draftId)).not.toBeNull() // survived
    expect(manager.get(plainId)).toBeNull() // routine history cleared
    manager.dispose()
  })
})

describe('history pruning', () => {
  // retention.ts covers the POLICY exhaustively; these prove it is actually
  // WIRED UP in the manager. History is seeded through the constructor (the
  // real "loaded from disk at launch" path) rather than by running hundreds
  // of jobs, so each test triggers exactly ONE real transition and stays
  // deterministic — no half-drained executor queue racing teardown.
  function finishedJob(i: number, overrides: Partial<Job> = {}): Job {
    return {
      id: `old-${i}`,
      type: 'test:old',
      title: 'Old job',
      state: 'succeeded',
      progress: { mode: 'indeterminate' },
      lane: 'INTERACTIVE',
      priority: 0,
      createdAt: i,
      endedAt: i,
      cancellable: true,
      input: {},
      ...overrides
    }
  }

  // A tiny cap instead of production's 500: the policy is identical, and a
  // 500-job fixture is slow enough to cross the persist throttle mid-test
  // and race the temp-dir teardown. retention.test.ts covers the real
  // constant; this file covers the wiring.
  const CAP = 5

  async function managerWith(history: Job[]): Promise<{
    manager: InstanceType<typeof import('../JobManager').JobManager>
    finishOne: () => Promise<void>
  }> {
    const { JobManager } = await freshManager()
    const manager = new JobManager(history, { maxRetainedJobs: CAP })
    manager.registerType<Record<string, never>, string>({
      type: 'test:trigger',
      lane: 'INTERACTIVE',
      titleFor: () => 'trigger',
      executor: { kind: 'inline-async', run: async () => 'ok' }
    })
    return {
      manager,
      finishOne: async () => {
        manager.enqueue('test:trigger', {})
        await settle()
      }
    }
  }

  it('caps retained history when a job finishes, instead of growing forever', async () => {
    const { manager, finishOne } = await managerWith(
      Array.from({ length: CAP + 3 }, (_, i) => finishedJob(i))
    )
    expect(manager.list()).toHaveLength(CAP + 3) // nothing pruned merely by loading
    await finishOne()
    expect(manager.list().length).toBeLessThanOrEqual(CAP)
    manager.dispose()
  })

  it('NEVER prunes a succeeded job that still holds unreviewed output', async () => {
    const draft = finishedJob(0, {
      id: 'unreviewed-draft',
      retainUntilConsumed: true,
      resultData: { tasks: ['send pricing'] }
    })
    // Buried under far more than the cap's worth of routine history, and the
    // OLDEST of the lot — first in line to be dropped by age alone.
    const { manager, finishOne } = await managerWith([
      draft,
      ...Array.from({ length: CAP * 3 }, (_, i) => finishedJob(i + 1))
    ])
    await finishOne()

    const survivor = manager.get('unreviewed-draft')
    expect(survivor).not.toBeNull()
    expect(survivor?.resultData).toEqual({ tasks: ['send pricing'] })
    expect(manager.list().length).toBeLessThanOrEqual(CAP + 1) // +1 = the protected draft
    manager.dispose()
  })

  it('gives up successes before failures and cancellations', async () => {
    const { manager, finishOne } = await managerWith([
      finishedJob(1, { id: 'a-failure', state: 'failed' }),
      finishedJob(2, { id: 'a-cancellation', state: 'cancelled' }),
      ...Array.from({ length: CAP }, (_, i) => finishedJob(i + 10))
    ])
    await finishOne()

    expect(manager.get('a-failure')).not.toBeNull()
    expect(manager.get('a-cancellation')).not.toBeNull()
    manager.dispose()
  })

  it('never prunes a still-running job, however much history sits behind it', async () => {
    const { JobManager } = await freshManager()
    const manager = new JobManager(
      Array.from({ length: CAP * 3 }, (_, i) => finishedJob(i)),
      { maxRetainedJobs: CAP }
    )
    manager.registerType<Record<string, never>, string>({
      type: 'test:forever',
      lane: 'BATCH',
      titleFor: () => 'forever',
      executor: { kind: 'inline-async', run: () => new Promise<string>(() => {}) }
    })
    manager.registerType<Record<string, never>, string>({
      type: 'test:trigger',
      lane: 'INTERACTIVE',
      titleFor: () => 'trigger',
      executor: { kind: 'inline-async', run: async () => 'ok' }
    })
    const running = manager.enqueue('test:forever', {})
    manager.enqueue('test:trigger', {}) // finishes, triggering a prune
    await settle()

    expect(manager.get(running.id)?.state).toBe('running')
    manager.dispose()
  })

  it('copies retainUntilConsumed from the job type onto each job, like cancellable', async () => {
    const { JobManager } = await freshManager()
    const manager = new JobManager([])
    manager.registerType<Record<string, never>, string>({
      type: 'test:retained',
      lane: 'INTERACTIVE',
      titleFor: () => 'retained',
      retainUntilConsumed: true,
      executor: { kind: 'inline-async', run: async () => 'ok' }
    })
    manager.registerType<Record<string, never>, string>({
      type: 'test:plain',
      lane: 'INTERACTIVE',
      titleFor: () => 'plain',
      executor: { kind: 'inline-async', run: async () => 'ok' }
    })
    const retained = manager.enqueue('test:retained', {})
    const plain = manager.enqueue('test:plain', {})
    expect(manager.get(retained.id)?.retainUntilConsumed).toBe(true)
    expect(manager.get(plain.id)?.retainUntilConsumed).toBe(false)
    manager.dispose()
  })
})

describe('resultData', () => {
  it("attaches the executor's full resolved result to the job, not just a string resultRef", async () => {
    const { JobManager } = await freshManager()
    const manager = new JobManager([])
    manager.registerType<Record<string, never>, { tasks: string[] }>({
      type: 'test:richResult',
      lane: 'INTERACTIVE',
      titleFor: () => 'rich result',
      executor: {
        kind: 'inline-async',
        run: async () => ({ tasks: ['send pricing', 'follow up Friday'] })
      }
    })
    const job = manager.enqueue('test:richResult', {})
    await settle()
    const final = manager.get(job.id)
    expect(final?.state).toBe('succeeded')
    expect(final?.resultRef).toBeUndefined() // no resultRefFor supplied, and the result isn't a string
    expect(final?.resultData).toEqual({ tasks: ['send pricing', 'follow up Friday'] })
    manager.dispose()
  })

  it("setResultData replaces a finished job's result — how incremental review state is kept with the output", async () => {
    const { JobManager } = await freshManager()
    const manager = new JobManager([])
    manager.registerType<Record<string, never>, { note: string; facts: string[] }>({
      type: 'test:reviewable',
      lane: 'INTERACTIVE',
      titleFor: () => 'reviewable',
      executor: { kind: 'inline-async', run: async () => ({ note: 'draft', facts: ['a', 'b'] }) }
    })
    const job = manager.enqueue('test:reviewable', {})
    await settle()
    expect(manager.get(job.id)?.state).toBe('succeeded')

    expect(
      manager.setResultData(job.id, {
        note: 'draft',
        facts: ['a', 'b'],
        review: { skipped: ['a'] }
      })
    ).toBe(true)
    expect(manager.get(job.id)?.resultData).toEqual({
      note: 'draft',
      facts: ['a', 'b'],
      review: { skipped: ['a'] }
    })
    manager.dispose()
  })

  it('setResultData REFUSES on a running job — an executor owns its own result while alive', async () => {
    const { JobManager } = await freshManager()
    const manager = new JobManager([])
    manager.registerType<Record<string, never>, string>({
      type: 'test:stillRunning',
      lane: 'INTERACTIVE',
      titleFor: () => 'still running',
      executor: { kind: 'inline-async', run: () => new Promise<string>(() => {}) }
    })
    const job = manager.enqueue('test:stillRunning', {})
    expect(manager.get(job.id)?.state).toBe('running')
    expect(manager.setResultData(job.id, { hijacked: true })).toBe(false)
    expect(manager.get(job.id)?.resultData).toBeUndefined()
    manager.dispose()
  })

  it('setResultData returns false for an unknown job rather than throwing', async () => {
    const { JobManager } = await freshManager()
    const manager = new JobManager([])
    expect(manager.setResultData('no-such-job', {})).toBe(false)
    manager.dispose()
  })

  it('still sets resultData for a plain string result (same value as resultRef)', async () => {
    const { JobManager } = await freshManager()
    const manager = new JobManager([])
    manager.registerType<Record<string, never>, string>({
      type: 'test:stringResult',
      lane: 'INTERACTIVE',
      titleFor: () => 'string result',
      executor: { kind: 'inline-async', run: async () => 'call-123' }
    })
    const job = manager.enqueue('test:stringResult', {})
    await settle()
    const final = manager.get(job.id)
    expect(final?.resultRef).toBe('call-123')
    expect(final?.resultData).toBe('call-123')
    manager.dispose()
  })
})

describe('BUG-060 — cancellable defaults to FALSE', () => {
  it('a job type that does not opt in gets NO cancel button, and cancel() refuses', async () => {
    // The inversion. This used to default true, so every job type advertised
    // a Cancel button whether or not anything honoured it: 10 of 12 registered
    // types offered one, exactly ONE adapter checked the signal, and pressing
    // Cancel marked the job cancelled while the work ran on spending the
    // user's API key.
    //
    // A forgotten flag must fail as "this feature is MISSING" (visible),
    // never as "this feature silently doesn't work" (invisible for months).
    const { JobManager } = await freshManager()
    const manager = new JobManager([])
    manager.registerType<Record<string, never>, string>({
      type: 'test:forgotToWireCancel',
      lane: 'BATCH',
      titleFor: () => 'forgetful',
      executor: {
        kind: 'inline-async',
        // Deliberately ignores handle.signal — the realistic mistake.
        run: () => new Promise<string>(() => {})
      }
    })

    const job = manager.enqueue('test:forgotToWireCancel', {})

    // No button is offered...
    expect(manager.get(job.id)?.cancellable).toBe(false)
    // ...and the operation is refused rather than lying about it.
    expect(manager.cancel(job.id)).toBe(false)
    expect(manager.get(job.id)?.state).not.toBe('cancelled')
    manager.dispose()
  })
})
