// @vitest-environment happy-dom
//
// M27 — unreviewed AI drafts get their own pinned section instead of sinking
// into the chronological Recent list.
//
// BUG-048 and BUG-050 moved already-paid-for AI output (Generate tasks'
// proposals, Generate CRM note's draft) INTO the job, so it survives closing
// a screen and even a restart, and retention.ts refuses to prune it. That
// makes it safe on disk — but safe and FINDABLE are different guarantees.
// Recent is strictly newest-first, and the post-call cascade alone fires
// roughly six automatic jobs per call, so a draft from this morning is buried
// under dozens of "Detecting who this was — done" rows by the afternoon. A
// draft the rep can't find is functionally a draft they lost, which is the
// exact outcome those two bugs were fixed to prevent.
//
// Drives the REAL ActivityCenter against a real job list, same as the
// clear-history suite next door.
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

/** A finished Generate-tasks job holding proposals the rep hasn't saved —
 *  and deliberately the OLDEST thing in the list, so newest-first ordering
 *  would bury it last. */
const OLD_DRAFT = makeJob({
  id: 'old-draft',
  type: 'tasks:generateFromCall',
  title: 'Tasks from the Acme call',
  state: 'succeeded',
  retainUntilConsumed: true,
  resultData: { tasks: [{ title: 'Send pricing' }] },
  createdAt: 1,
  endedAt: 1
})

let container: HTMLDivElement
let root: Root | null
let store: Job[]

function setupApi(): void {
  ;(window as unknown as { api: unknown }).api = {
    jobs: {
      list: () => Promise.resolve([...store]),
      onChanged: () => () => {},
      onNotify: () => () => {},
      onOpenRequested: () => () => {},
      dismiss: () => Promise.resolve({ ok: true }),
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
  const toggle = document.body.querySelector('button') as HTMLButtonElement
  await act(async () => toggle.click())
  await flush()
}

function bodyText(): string {
  return document.body.textContent ?? ''
}

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

describe('ActivityCenter — an unreviewed draft stays findable', () => {
  it('shows a draft under "Needs your review", not buried in Recent', async () => {
    // 12 newer routine jobs on top of one old draft — the realistic shape
    // after an afternoon of calls, where newest-first ordering puts the
    // draft dead last.
    store = [
      OLD_DRAFT,
      ...Array.from({ length: 12 }, (_, i) =>
        makeJob({ id: `routine-${i}`, title: `Detecting who this was ${i}`, createdAt: 10 + i, endedAt: 10 + i })
      )
    ]
    await mountAndOpen()

    expect(bodyText()).toContain('Needs your review')
    expect(bodyText()).toContain('Tasks from the Acme call')

    // The load-bearing assertion: the draft's heading appears BEFORE the
    // Recent heading in the DOM, i.e. it is genuinely pinned above the
    // churn rather than merely present somewhere in a long scroll.
    const text = bodyText()
    expect(text.indexOf('Needs your review')).toBeLessThan(text.indexOf('Recent'))
    expect(text.indexOf('Tasks from the Acme call')).toBeLessThan(text.indexOf('Recent'))
  })

  it('shows no review section at all when there are no drafts', async () => {
    // It must not become permanent furniture — an always-present empty
    // "Needs your review" heading would train the rep to ignore it.
    store = [makeJob({ id: 'routine-1' }), makeJob({ id: 'routine-2' })]
    await mountAndOpen()

    expect(bodyText()).not.toContain('Needs your review')
    expect(bodyText()).toContain('Recent')
  })

  it('a draft never appears in BOTH sections', async () => {
    // The two lists are complements of one predicate; if that ever drifted
    // into two independent filters, a draft could show up twice (or vanish
    // from both). Counting occurrences catches either.
    //
    // HONEST LIMITATION (taxonomy species 5): this does NOT discriminate the
    // M27 change itself — under the old single-list code the draft also
    // appeared exactly once, just in the wrong place. It is a guard against
    // a FUTURE drift, not proof of the current fix. The first test in this
    // file is the one that goes red without the fix.
    store = [OLD_DRAFT, makeJob({ id: 'routine-1', title: 'Routine job' })]
    await mountAndOpen()

    const occurrences = bodyText().split('Tasks from the Acme call').length - 1
    expect(occurrences).toBe(1)
  })

  it('a FAILED draft-type job stays in Recent — only succeeded output needs review', async () => {
    // holdsUnreviewedOutput is state-sensitive: a failed generate-tasks job
    // produced nothing to review, so pinning it would be noise.
    store = [
      makeJob({
        id: 'failed-draft',
        type: 'tasks:generateFromCall',
        title: 'Tasks that failed',
        state: 'failed',
        retainUntilConsumed: true,
        endedAt: 5
      })
    ]
    await mountAndOpen()

    expect(bodyText()).not.toContain('Needs your review')
    expect(bodyText()).toContain('Tasks that failed')
  })
})
