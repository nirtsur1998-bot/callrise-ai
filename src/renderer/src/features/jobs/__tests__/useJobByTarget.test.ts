// @vitest-environment happy-dom
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useJobByTarget } from '@renderer/features/jobs/useJobByTarget'
import type { Job, JobState } from '../../../../../preload/index.d'

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    type: 'test:type',
    title: 'Test job',
    state: 'running',
    progress: { mode: 'indeterminate' },
    lane: 'INTERACTIVE',
    priority: 0,
    createdAt: 0,
    cancellable: true,
    input: {},
    ...overrides
  }
}

let container: HTMLDivElement
let root: Root
let changeListeners: Array<(jobs: Job[]) => void>
let listResult: Job[]
let onSucceeded: ReturnType<typeof vi.fn<(job: Job) => void>>
let onFailed: ReturnType<typeof vi.fn<(job: Job) => void>>
let lastResult: { job: Job | null; start: (job: Job) => void } | null

function setupWindowApi(): void {
  changeListeners = []
  listResult = []
  ;(window as unknown as { api: unknown }).api = {
    jobs: {
      list: () => Promise.resolve(listResult),
      onChanged: (cb: (jobs: Job[]) => void) => {
        changeListeners.push(cb)
        return () => {
          changeListeners = changeListeners.filter((l) => l !== cb)
        }
      }
    }
  }
}

function emitChange(jobs: Job[]): void {
  changeListeners.forEach((cb) => cb(jobs))
}

function Harness({
  jobType,
  targetRef,
  adoptStates
}: {
  jobType: string
  targetRef: string
  adoptStates?: JobState[]
}): React.JSX.Element {
  const [job, start] = useJobByTarget(jobType, targetRef, { onSucceeded, onFailed, adoptStates })
  // Recording into the outer `lastResult` for assertions is a test-only side
  // effect — kept out of the render body itself (react-hooks/set-state-in-
  // effect's sibling rule for outer-variable writes), same as production code.
  useEffect(() => {
    lastResult = { job, start }
  })
  return createElement('div', null)
}

// Reuses the SAME root across calls within a test (only creates a fresh one
// in beforeEach) — a real React update on an already-mounted tree, not a
// remount, so the "targetRef changes" test genuinely exercises the effect's
// cleanup-then-rerun on a changed dependency, not just a fresh mount.
async function render(jobType: string, targetRef: string, adoptStates?: JobState[]): Promise<void> {
  await act(async () => {
    root.render(createElement(Harness, { jobType, targetRef, adoptStates }))
    await Promise.resolve()
  })
}

describe('useJobByTarget', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    setupWindowApi()
    onSucceeded = vi.fn()
    onFailed = vi.fn()
    lastResult = null
  })

  afterEach(() => {
    act(() => root?.unmount())
    container.remove()
  })

  it('adopts an already-running job for the same target on mount', async () => {
    listResult = [
      makeJob({ id: 'existing', type: 'calls:summarize', targetRef: 'call-1', state: 'running' })
    ]
    await render('calls:summarize', 'call-1')
    expect(lastResult?.job?.id).toBe('existing')
  })

  it('ignores a running job that belongs to a DIFFERENT target', async () => {
    listResult = [
      makeJob({ id: 'other-call', type: 'calls:summarize', targetRef: 'call-2', state: 'running' })
    ]
    await render('calls:summarize', 'call-1')
    expect(lastResult?.job).toBeNull()
  })

  it('ignores a job of a DIFFERENT type for the same target', async () => {
    listResult = [
      makeJob({ id: 'wrong-type', type: 'calls:coach', targetRef: 'call-1', state: 'running' })
    ]
    await render('calls:summarize', 'call-1')
    expect(lastResult?.job).toBeNull()
  })

  it('fires onSucceeded exactly once when the tracked job transitions to succeeded', async () => {
    await render('calls:summarize', 'call-1')
    act(() => {
      lastResult!.start(
        makeJob({ id: 'started', type: 'calls:summarize', targetRef: 'call-1', state: 'running' })
      )
    })
    act(() => {
      emitChange([
        makeJob({ id: 'started', type: 'calls:summarize', targetRef: 'call-1', state: 'succeeded' })
      ])
    })
    expect(onSucceeded).toHaveBeenCalledTimes(1)

    act(() => {
      // A later, unrelated tick still carrying the same terminal job must not re-fire.
      emitChange([
        makeJob({ id: 'started', type: 'calls:summarize', targetRef: 'call-1', state: 'succeeded' })
      ])
    })
    expect(onSucceeded).toHaveBeenCalledTimes(1)
    expect(onFailed).not.toHaveBeenCalled()
  })

  it("fires onFailed exactly once, with the job's error (code and all), when it transitions to failed", async () => {
    await render('calls:summarize', 'call-1')
    act(() => {
      lastResult!.start(
        makeJob({ id: 'started', type: 'calls:summarize', targetRef: 'call-1', state: 'running' })
      )
    })
    act(() => {
      emitChange([
        makeJob({
          id: 'started',
          type: 'calls:summarize',
          targetRef: 'call-1',
          state: 'failed',
          error: { message: 'No AI key configured', code: 'no-key' }
        })
      ])
    })
    expect(onFailed).toHaveBeenCalledTimes(1)
    expect(onFailed.mock.calls[0][0].error).toEqual({
      message: 'No AI key configured',
      code: 'no-key'
    })
    expect(onSucceeded).not.toHaveBeenCalled()
  })

  it('resets tracking when targetRef changes — a job for the old target never leaks onto the new one', async () => {
    listResult = [
      makeJob({ id: 'call-1-job', type: 'calls:summarize', targetRef: 'call-1', state: 'running' })
    ]
    await render('calls:summarize', 'call-1')
    expect(lastResult?.job?.id).toBe('call-1-job')

    listResult = []
    await render('calls:summarize', 'call-2')
    expect(lastResult?.job).toBeNull()
  })

  describe('adoptStates', () => {
    it('ignores an already-succeeded job by default (running/queued only)', async () => {
      listResult = [
        makeJob({
          id: 'done-already',
          type: 'tasks:generateFromCall',
          targetRef: 'call-1',
          state: 'succeeded'
        })
      ]
      await render('tasks:generateFromCall', 'call-1')
      expect(lastResult?.job).toBeNull()
      expect(onSucceeded).not.toHaveBeenCalled()
    })

    it('adopts an already-succeeded, not-yet-consumed job when told to — e.g. reopening Generate tasks for a call whose AI output already finished', async () => {
      const done = makeJob({
        id: 'done-already',
        type: 'tasks:generateFromCall',
        targetRef: 'call-1',
        state: 'succeeded',
        resultData: { tasks: ['send pricing'] }
      })
      listResult = [done]
      await render('tasks:generateFromCall', 'call-1', ['running', 'queued', 'succeeded'])
      expect(lastResult?.job?.id).toBe('done-already')
      expect(lastResult?.job?.resultData).toEqual({ tasks: ['send pricing'] })
      // Fires exactly once for the adoption itself — this is how the caller
      // learns "here's the already-generated result", same as if it had
      // watched the job finish live.
      expect(onSucceeded).toHaveBeenCalledTimes(1)
      expect(onSucceeded).toHaveBeenCalledWith(done)
    })

    it('does not re-fire onSucceeded for an adopted-already-succeeded job on a later unrelated onChanged tick', async () => {
      const done = makeJob({
        id: 'done-already',
        type: 'tasks:generateFromCall',
        targetRef: 'call-1',
        state: 'succeeded'
      })
      listResult = [done]
      await render('tasks:generateFromCall', 'call-1', ['running', 'queued', 'succeeded'])
      expect(onSucceeded).toHaveBeenCalledTimes(1)

      act(() => {
        emitChange([done]) // still succeeded, nothing new
      })
      expect(onSucceeded).toHaveBeenCalledTimes(1)
    })

    it('start() also notifies once for a job that is already terminal at the moment it is started', async () => {
      await render('tasks:generateFromCall', 'call-1', ['running', 'queued', 'succeeded'])
      const alreadyDone = makeJob({
        id: 'fast-job',
        type: 'tasks:generateFromCall',
        targetRef: 'call-1',
        state: 'succeeded',
        resultData: { tasks: [] }
      })
      act(() => {
        lastResult!.start(alreadyDone)
      })
      expect(lastResult?.job?.id).toBe('fast-job')
      expect(onSucceeded).toHaveBeenCalledTimes(1)
      expect(onSucceeded).toHaveBeenCalledWith(alreadyDone)
    })
  })
})
