// @vitest-environment happy-dom
//
// M26 Phase 3 — Generate tasks was flagged as an actual bug, not just an
// architecture migration: closing the review dialog before clicking Save
// used to permanently discard the AI's already-paid-for output, since the
// proposed tasks lived only in this component's own React state. These
// tests prove the fix at the level the founder asked to confirm: the JOB
// (simulated here via a plain in-memory store standing in for JobManager),
// not the dialog, is the source of truth — closing early and reopening
// recovers the exact same proposals, and saving cleans up after itself so
// a later reopen doesn't resurface an already-saved batch.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GenerateTasksDialog } from '../GenerateTasksDialog'
import type { Job } from '../../../../../preload/index.d'

const JOB_TYPE = 'tasks:generateFromCall'

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    type: JOB_TYPE,
    title: 'Generating tasks',
    state: 'running',
    progress: { mode: 'indeterminate' },
    lane: 'INTERACTIVE',
    priority: 0,
    createdAt: 0,
    cancellable: true,
    // Main stamps this on every job of this type (tasks.ts) — it is what
    // makes the generic dismiss refuse, so the mock must carry it too or
    // these tests would pass against a dialog that regressed to using it.
    retainUntilConsumed: true,
    input: {},
    ...overrides
  }
}

let container: HTMLDivElement
let root: Root | null
let store: Job[]
let changeListeners: Array<(jobs: Job[]) => void>
let nextId: number
let generateCalls: Array<{ callId: string; force: boolean }>
let createCalls: unknown[]
let dismissCalls: string[]

function emitChange(): void {
  const snapshot = [...store]
  changeListeners.forEach((cb) => cb(snapshot))
}

/** Simulates the main-process handler's own dedup + enqueue behavior
 *  (calls.ts/tasks.ts's real IPC handlers do the exact same running/
 *  queued/succeeded check server-side) — the dialog's own correctness
 *  should not depend on which side does the deduping, but exercising it
 *  here keeps the mock honest to the real contract. */
function setupWindowApi(): void {
  store = []
  changeListeners = []
  nextId = 1
  generateCalls = []
  createCalls = []
  dismissCalls = []
  ;(window as unknown as { api: unknown }).api = {
    jobs: {
      list: () => Promise.resolve([...store]),
      get: (id: string) => Promise.resolve(store.find((j) => j.id === id) ?? null),
      onChanged: (cb: (jobs: Job[]) => void) => {
        changeListeners.push(cb)
        return () => {
          changeListeners = changeListeners.filter((l) => l !== cb)
        }
      },
      // BUG-052 — the generic dismiss now REFUSES a job still holding
      // unreviewed output, exactly as main does. If the dialog ever regressed
      // to using this instead of the purpose-built channel below, the job
      // would survive and the "starts fresh next time" test would fail.
      dismiss: (id: string) => {
        const job = store.find((j) => j.id === id)
        if (job?.retainUntilConsumed && job.state === 'succeeded') {
          return Promise.resolve({ ok: false })
        }
        dismissCalls.push(id)
        store = store.filter((j) => j.id !== id)
        return Promise.resolve({ ok: true })
      }
    },
    tasks: {
      // The one path that legitimately knows the proposals were saved.
      markGenerationConsumed: (jobId: string) => {
        dismissCalls.push(jobId)
        store = store.filter((j) => j.id !== jobId)
        return Promise.resolve({ ok: true })
      },
      generateFromCall: (callId: string, opts?: { force?: boolean }) => {
        generateCalls.push({ callId, force: !!opts?.force })
        if (!opts?.force) {
          const already = store.find(
            (j) =>
              j.type === JOB_TYPE &&
              j.targetRef === callId &&
              (j.state === 'running' || j.state === 'queued' || j.state === 'succeeded')
          )
          if (already) return Promise.resolve({ ok: true, jobId: already.id })
        }
        const job = makeJob({ id: `job-${nextId++}`, targetRef: callId, state: 'running' })
        store.push(job)
        return Promise.resolve({ ok: true, jobId: job.id })
      },
      create: (input: unknown) => {
        createCalls.push(input)
        return Promise.resolve({ id: `task-${createCalls.length}`, ...(input as object) })
      }
    }
  }
}

/** Advances the given job (already in `store`) to succeeded with the given
 *  proposed tasks, and broadcasts the change — standing in for the AI call
 *  actually finishing in main. */
function finishJob(jobId: string, tasks: unknown[]): void {
  store = store.map((j) =>
    j.id === jobId ? { ...j, state: 'succeeded' as const, resultData: { tasks } } : j
  )
  emitChange()
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function mountDialog(
  callId: string,
  onSaved: (n: number) => void = () => {}
): Promise<HTMLDivElement> {
  const el = document.createElement('div')
  container.appendChild(el)
  root = createRoot(el)
  await act(async () => {
    root!.render(
      createElement(GenerateTasksDialog, {
        callId,
        callTitle: 'Discovery call with Acme',
        onClose: () => {},
        onSaved
      })
    )
    await Promise.resolve()
  })
  await flush()
  return el
}

async function unmountDialog(): Promise<void> {
  await act(async () => {
    root?.unmount()
  })
  root = null
}

describe('GenerateTasksDialog — recovering AI output across a close/reopen', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    setupWindowApi()
  })

  afterEach(async () => {
    await unmountDialog()
    container.remove()
  })

  it('closing before Save, then reopening the same call, shows the exact same proposals — nothing is lost', async () => {
    await mountDialog('call-1')
    expect(generateCalls).toEqual([{ callId: 'call-1', force: false }])
    const jobId = store[0].id

    finishJob(jobId, [
      { title: 'Send pricing breakdown', type: 'follow-up', priority: 'high', clientName: 'Acme' }
    ])
    await flush()

    const titleInput = (): HTMLInputElement | null =>
      document.body.querySelector('input[placeholder="What needs to happen?"]')
    expect(titleInput()?.value).toBe('Send pricing breakdown')

    // The rep closes the dialog WITHOUT clicking Save — this is the exact
    // scenario that used to permanently discard the AI's output.
    await unmountDialog()
    expect(dismissCalls).toEqual([]) // never saved, so never dismissed either

    // Reopening for the SAME call must recover the same proposal, not
    // silently show nothing / re-run (and re-bill) the AI call.
    await mountDialog('call-1')
    expect(titleInput()?.value).toBe('Send pricing breakdown')

    // A second generateFromCall call is allowed (the dialog always asks;
    // the server is what dedupes) — but it must NOT have produced a SECOND
    // job for this call, which is what "re-running the AI" would look like.
    const jobsForCall1 = store.filter((j) => j.targetRef === 'call-1')
    expect(jobsForCall1).toHaveLength(1)
  })

  it('surviving a full app restart works the same way — the store, not the dialog, is what is checked', async () => {
    // Simulate "the job already finished while the app was closed, and the
    // dialog was never even open at the time" — i.e. restore straight from
    // a persisted succeeded job, with the dialog mounting fresh afterward.
    store = [
      makeJob({
        id: 'restored-job',
        targetRef: 'call-2',
        state: 'succeeded',
        resultData: {
          tasks: [{ title: 'Follow up Friday', type: 'follow-up', priority: 'medium' }]
        }
      })
    ]

    await mountDialog('call-2')

    const titleInput = document.body.querySelector(
      'input[placeholder="What needs to happen?"]'
    ) as HTMLInputElement | null
    expect(titleInput?.value).toBe('Follow up Friday')
  })

  it('saving dismisses the job, so a later reopen starts a genuinely fresh generation instead of resurfacing the saved batch', async () => {
    await mountDialog('call-3')
    const jobId = store[0].id
    finishJob(jobId, [{ title: 'Send contract', type: 'follow-up', priority: 'high' }])
    await flush()

    const saveButton = Array.from(document.body.querySelectorAll('button')).find((b) =>
      b.textContent?.startsWith('Save ')
    ) as HTMLButtonElement
    expect(saveButton).toBeDefined()

    await act(async () => {
      saveButton.click()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(createCalls).toHaveLength(1)
    expect(dismissCalls).toEqual([jobId])
    expect(store.find((j) => j.id === jobId)).toBeUndefined() // actually removed from the store

    await unmountDialog()
    await mountDialog('call-3')
    // The old job is gone, so this must be a brand-new one, not a re-adopt
    // of the just-saved batch.
    const jobsForCall3 = store.filter((j) => j.targetRef === 'call-3')
    expect(jobsForCall3).toHaveLength(1)
    expect(jobsForCall3[0].id).not.toBe(jobId)
  })
})
