// @vitest-environment happy-dom
//
// BUG-052 — "Clear history" in the Activity Center swept EVERYTHING in
// Recent, including a finished Generate tasks / Generate CRM note job whose
// resultData is the only copy of already-paid-for AI output the rep hasn't
// looked at yet. One click, no confirmation, and it was gone — plus a silent
// re-run and re-bill next time they opened it, since both adapters treat a
// succeeded job as "already generated".
//
// Neither Phase 2 (which wrote Clear history) nor Phase 3 (which started
// keeping drafts inside jobs) was wrong on its own; the bug lived in the gap
// between them, which is exactly what per-feature tests can't see. So this
// drives the REAL ActivityCenter against a real job list.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from '../../../../../preload/index.d'

vi.mock('@renderer/features/notifications/useToast', () => ({
  useToast: () => ({ show: () => {}, dismiss: () => {} })
}))

const { ActivityCenter } = await import('../ActivityCenter')

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    type: 'test:type',
    title: 'Routine job',
    state: 'succeeded',
    progress: { mode: 'indeterminate' },
    lane: 'INTERACTIVE',
    priority: 0,
    createdAt: 1,
    endedAt: 1,
    cancellable: true,
    input: {},
    ...overrides
  }
}

/** A finished Generate-tasks job holding proposals the rep hasn't saved. */
const UNREVIEWED_DRAFT = makeJob({
  id: 'unreviewed-draft',
  type: 'tasks:generateFromCall',
  title: 'Generating tasks',
  state: 'succeeded',
  retainUntilConsumed: true,
  resultData: { tasks: [{ title: 'Send pricing' }] },
  createdAt: 2,
  endedAt: 2
})

let container: HTMLDivElement
let root: Root | null
let store: Job[]
let listeners: Array<(jobs: Job[]) => void>
/** Ids the renderer actually ASKED to dismiss — including ones main refused.
 *  Tracked separately from `dismissed` so a test can tell "the UI correctly
 *  never asked" apart from "the UI asked and main saved us", which is the
 *  difference between a real UI fix and relying on the backstop. */
let dismissAttempts: string[]
let dismissed: string[]

function setupApi(): void {
  listeners = []
  dismissed = []
  dismissAttempts = []
  ;(window as unknown as { api: unknown }).api = {
    jobs: {
      list: () => Promise.resolve([...store]),
      onChanged: (cb: (jobs: Job[]) => void) => {
        listeners.push(cb)
        return () => {
          listeners = listeners.filter((l) => l !== cb)
        }
      },
      onNotify: () => () => {},
      onOpenRequested: () => () => {},
      // Mirrors main's guard: a job holding unreviewed output is refused.
      dismiss: (id: string) => {
        dismissAttempts.push(id)
        const job = store.find((j) => j.id === id)
        if (job && job.state === 'succeeded' && job.retainUntilConsumed) {
          return Promise.resolve({ ok: false })
        }
        dismissed.push(id)
        store = store.filter((j) => j.id !== id)
        listeners.forEach((cb) => cb([...store]))
        return Promise.resolve({ ok: true })
      },
      cancel: () => Promise.resolve({ ok: true }),
      retry: () => Promise.resolve(null),
      resume: () => Promise.resolve(null)
    }
  }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function mountAndOpen(): Promise<void> {
  const el = document.createElement('div')
  container.appendChild(el)
  root = createRoot(el)
  await act(async () => {
    root!.render(createElement(ActivityCenter))
    await Promise.resolve()
  })
  await flush()
  // Open the panel — the toggle is the only button before it opens.
  const toggle = document.body.querySelector('button') as HTMLButtonElement
  await act(async () => toggle.click())
  await flush()
}

function buttonWith(text: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(text)
  ) as HTMLButtonElement | undefined
}

function bodyText(): string {
  return document.body.textContent ?? ''
}

describe('ActivityCenter — Clear history must not destroy unreviewed AI output', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    store = [makeJob({ id: 'routine-1' }), UNREVIEWED_DRAFT, makeJob({ id: 'routine-2' })]
    setupApi()
  })

  afterEach(async () => {
    await act(async () => root?.unmount())
    root = null
    container.remove()
  })

  it('clears routine history but LEAVES the job holding an unreviewed draft', async () => {
    await mountAndOpen()
    const clear = buttonWith('Clear history')
    expect(clear).toBeDefined()

    await act(async () => clear!.click())
    await flush()

    expect(dismissed).toContain('routine-1')
    expect(dismissed).toContain('routine-2')
    expect(dismissed).not.toContain('unreviewed-draft')
    // And it is genuinely still there, output intact.
    const survivor = store.find((j) => j.id === 'unreviewed-draft')
    expect(survivor).toBeDefined()
    expect(survivor?.resultData).toEqual({ tasks: [{ title: 'Send pricing' }] })
  })

  it('never even ASKS main to dismiss the draft — the UI filters it, rather than leaning on the backstop', async () => {
    await mountAndOpen()
    await act(async () => buttonWith('Clear history')!.click())
    await flush()
    // Main refusing it would also protect the data, but then the button
    // would be half-failing invisibly. The renderer must not ask at all.
    expect(dismissAttempts).not.toContain('unreviewed-draft')
    expect(dismissAttempts.sort()).toEqual(['routine-1', 'routine-2'])
  })

  it('hides Clear history entirely when the ONLY history is an unreviewed draft', async () => {
    store = [UNREVIEWED_DRAFT]
    await mountAndOpen()
    expect(buttonWith('Clear history')).toBeUndefined()
  })

  it('still offers Clear history when there is anything routine to clear', async () => {
    store = [UNREVIEWED_DRAFT, makeJob({ id: 'routine-1' })]
    await mountAndOpen()
    expect(buttonWith('Clear history')).toBeDefined()
  })
})

describe('ActivityCenter — determinate progress rendering', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    setupApi()
  })

  afterEach(async () => {
    await act(async () => root?.unmount())
    root = null
    container.remove()
  })

  it('renders a percent-unit job as "45%", not as a raw byte pair', async () => {
    // The update download: electron-updater always knew the exact percent,
    // but nothing listened, so this showed a fake spinner for what is often
    // the longest operation in the product.
    store = [
      makeJob({
        id: 'download',
        type: 'updater:download',
        title: 'Downloading update',
        state: 'running',
        progress: { mode: 'determinate', itemsDone: 45, itemsTotal: 100, unit: 'percent' }
      })
    ]
    await mountAndOpen()
    expect(bodyText()).toContain('45%')
    expect(bodyText()).not.toContain('45 / 100')
  })

  it('still renders a countable job as "12 / 50" — the unit is opt-in, nothing else changed', async () => {
    store = [
      makeJob({
        id: 'scan',
        title: 'Scanning past calls',
        state: 'running',
        progress: { mode: 'determinate', itemsDone: 12, itemsTotal: 50 }
      })
    ]
    await mountAndOpen()
    expect(bodyText()).toContain('12 / 50')
  })
})
