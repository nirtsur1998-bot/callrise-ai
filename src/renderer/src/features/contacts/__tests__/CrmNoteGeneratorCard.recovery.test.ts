// @vitest-environment happy-dom
//
// The bug: "Generate CRM note" produces a drafted note AND a list of
// suggested contact-field updates, both reviewed separately. Both used to
// live only in this card's React state, so navigating off the Contact page
// permanently discarded whatever hadn't been dealt with — already paid for
// on the rep's own API key, and worse for the suggestions than the note
// since they're worked through one at a time (accept two of five, get
// interrupted, lose the other three with no record they existed).
//
// These tests drive the REAL card against an in-memory stand-in for the
// job store, proving: closing and reopening recovers both the note and the
// still-undecided suggestions; already-decided ones stay decided; and a
// skipped suggestion is permanent but never invisible.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CrmNoteGeneratorCard } from '../CrmNoteGeneratorCard'
import type { Job } from '../../../../../preload/index.d'

const JOB_TYPE = 'crmNote:generate'

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    type: JOB_TYPE,
    title: 'Drafting CRM note',
    state: 'running',
    progress: { mode: 'indeterminate' },
    lane: 'INTERACTIVE',
    priority: 0,
    createdAt: 0,
    cancellable: true,
    input: { contactId: 'c1', length: 'medium' },
    ...overrides
  }
}

const FACTS = [
  { id: 'f1', field: 'timeline', text: 'Q1 rollout', confidence: 'high' as const },
  { id: 'f2', field: 'budgetIndication', text: 'Around $40k', confidence: 'high' as const },
  { id: 'f3', field: 'competitors', text: 'Evaluating Salesforce', confidence: 'medium' as const }
]

let container: HTMLDivElement
let root: Root | null
let store: Job[]
let listeners: Array<(jobs: Job[]) => void>
let appliedFacts: Array<{ field: string; text: string }>

function emit(): void {
  const snapshot = [...store]
  listeners.forEach((cb) => cb(snapshot))
}

/** Mirrors main's recordDecision(): merge the decision into the job's
 *  resultData, and dismiss the job once nothing is left to review. */
function record(jobId: string, apply: (review: Record<string, unknown>) => void): void {
  store = store.map((j) => {
    if (j.id !== jobId) return j
    const data = j.resultData as {
      note: string
      facts: typeof FACTS
      review?: Record<string, unknown>
    }
    const review = { ...(data.review ?? {}) }
    apply(review)
    return { ...j, resultData: { ...data, review } }
  })
  const job = store.find((j) => j.id === jobId)
  const data = job?.resultData as
    | {
        facts: typeof FACTS
        review?: { noteHandled?: boolean; accepted?: string[]; skipped?: string[] }
      }
    | undefined
  if (data?.review?.noteHandled) {
    const decided = new Set([...(data.review.accepted ?? []), ...(data.review.skipped ?? [])])
    if (data.facts.every((f) => decided.has(f.id))) store = store.filter((j) => j.id !== jobId)
  }
  emit()
}

function push(list: string[] | undefined, v: string): string[] {
  const cur = list ?? []
  return cur.includes(v) ? cur : [...cur, v]
}

function setupApi(): void {
  store = []
  listeners = []
  appliedFacts = []
  ;(window as unknown as { api: unknown }).api = {
    jobs: {
      list: () => Promise.resolve([...store]),
      get: (id: string) => Promise.resolve(store.find((j) => j.id === id) ?? null),
      onChanged: (cb: (jobs: Job[]) => void) => {
        listeners.push(cb)
        return () => {
          listeners = listeners.filter((l) => l !== cb)
        }
      }
    },
    crmNoteGenerator: {
      generate: (contactId: string, _length: string, opts?: { force?: boolean }) => {
        if (!opts?.force) {
          const already = store.find(
            (j) =>
              j.type === JOB_TYPE &&
              j.targetRef === contactId &&
              (j.state === 'running' || j.state === 'queued' || j.state === 'succeeded')
          )
          if (already) return Promise.resolve({ ok: true, jobId: already.id })
        }
        const job = makeJob({ id: `job-${store.length + 1}`, targetRef: contactId })
        store.push(job)
        return Promise.resolve({ ok: true, jobId: job.id })
      },
      save: (_c: string, _n: string, jobId?: string) => {
        if (jobId) record(jobId, (r) => void (r.noteHandled = true))
        return Promise.resolve({ ok: true })
      },
      applyFact: (_c: string, field: string, text: string, jobId?: string, factId?: string) => {
        appliedFacts.push({ field, text })
        if (jobId && factId) {
          record(jobId, (r) => void (r.accepted = push(r.accepted as string[], factId)))
        }
        return Promise.resolve({ ok: true })
      },
      skipFact: (jobId: string, factId: string) => {
        record(jobId, (r) => void (r.skipped = push(r.skipped as string[], factId)))
        return Promise.resolve({ ok: true })
      },
      discardNote: (jobId: string) => {
        record(jobId, (r) => void (r.noteHandled = true))
        return Promise.resolve({ ok: true })
      }
    }
  }
}

function finish(jobId: string): void {
  store = store.map((j) =>
    j.id === jobId
      ? {
          ...j,
          state: 'succeeded' as const,
          resultData: { note: 'Drafted note body.', facts: FACTS }
        }
      : j
  )
  emit()
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function mountCard(contactId = 'c1'): Promise<void> {
  const el = document.createElement('div')
  container.appendChild(el)
  root = createRoot(el)
  await act(async () => {
    root!.render(createElement(CrmNoteGeneratorCard, { contactId }))
    await Promise.resolve()
  })
  await flush()
}

async function unmountCard(): Promise<void> {
  await act(async () => root?.unmount())
  root = null
}

function buttonWith(text: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(text)
  ) as HTMLButtonElement | undefined
}

function bodyText(): string {
  return document.body.textContent ?? ''
}

describe('CrmNoteGeneratorCard — recovering a draft across a close/reopen', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    setupApi()
  })

  afterEach(async () => {
    await unmountCard()
    container.remove()
  })

  it('recovers BOTH the drafted note and the undecided suggestions after navigating away', async () => {
    await mountCard()
    await act(async () => void buttonWith('Generate from most recent call')?.click())
    await flush()
    finish(store[0].id)
    await flush()
    expect(bodyText()).toContain('Drafted note body.')
    expect(bodyText()).toContain('Q1 rollout')

    // The rep leaves the Contact page without saving or deciding anything —
    // the exact scenario that used to destroy all of it.
    await unmountCard()
    await mountCard()

    expect(bodyText()).toContain('Drafted note body.')
    expect(bodyText()).toContain('Q1 rollout')
    expect(bodyText()).toContain('Around $40k')
    // And no second job was created — no re-running (or re-billing) the AI.
    expect(store.filter((j) => j.targetRef === 'c1')).toHaveLength(1)
  })

  it('a partly-reviewed batch resumes with only what is still outstanding', async () => {
    await mountCard()
    await act(async () => void buttonWith('Generate from most recent call')?.click())
    await flush()
    finish(store[0].id)
    await flush()

    // Accept one, skip another, leave the third and the note untouched.
    await act(async () => void buttonWith('Update')?.click())
    await flush()
    await act(async () => void buttonWith('Skip')?.click())
    await flush()

    await unmountCard()
    await mountCard()

    // Only the third suggestion is still pending.
    expect(bodyText()).toContain('Evaluating Salesforce')
    expect(appliedFacts).toEqual([{ field: 'timeline', text: 'Q1 rollout' }])
    // The accepted one is gone from the pending list (it was applied).
    const pendingRegion = bodyText().split('skipped')[0]
    expect(pendingRegion).not.toContain('Q1 rollout')
    // The note is still there to save.
    expect(bodyText()).toContain('Drafted note body.')
  })

  it('a skipped suggestion is permanent but never invisible — it stays listed under a count', async () => {
    await mountCard()
    await act(async () => void buttonWith('Generate from most recent call')?.click())
    await flush()
    finish(store[0].id)
    await flush()

    await act(async () => void buttonWith('Skip')?.click())
    await flush()

    // Summarised by count, collapsed by default.
    expect(bodyText()).toContain('1 suggestion skipped')
    expect(bodyText()).not.toContain('Q1 rollout')

    // Expanding shows exactly what was skipped, so a mis-click leaves a trace.
    await act(async () => void buttonWith('1 suggestion skipped')?.click())
    await flush()
    expect(bodyText()).toContain('Q1 rollout')
    expect(bodyText()).toContain("won't be suggested again")
  })

  it('once the note is handled and every suggestion decided, the job is cleared so a reopen starts fresh', async () => {
    await mountCard()
    await act(async () => void buttonWith('Generate from most recent call')?.click())
    await flush()
    const jobId = store[0].id
    finish(jobId)
    await flush()

    await act(async () => void buttonWith('Save to contact')?.click())
    await flush()
    for (let i = 0; i < FACTS.length; i++) {
      await act(async () => void buttonWith('Skip')?.click())
      await flush()
    }

    // Nothing left to review — the job is gone from the store entirely.
    expect(store.find((j) => j.id === jobId)).toBeUndefined()

    await unmountCard()
    await mountCard()
    // Back to the initial call-to-action, not a stale already-handled batch.
    expect(buttonWith('Generate from most recent call')).toBeDefined()
  })
})
