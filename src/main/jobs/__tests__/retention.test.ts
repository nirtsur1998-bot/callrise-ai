// This module can DELETE things, so it is tested harder than most. The one
// thing it must never delete is already-paid-for AI output the rep hasn't
// reviewed yet — the entire mechanism behind BUG-048 (Generate tasks) and
// BUG-050 (Generate CRM note) is that such output survives in a SUCCEEDED
// job until consumed. A naive "keep the newest N" would silently undo both.
import { describe, expect, it } from 'vitest'
import { MAX_RETAINED_JOBS, isProtected, selectJobsToPrune } from '../retention'
import type { Job, JobState } from '../types'

let seq = 0
function job(overrides: Partial<Job> = {}): Job {
  seq++
  return {
    id: `job-${seq}`,
    type: 'test:type',
    title: 'Test job',
    state: 'succeeded',
    progress: { mode: 'indeterminate' },
    lane: 'INTERACTIVE',
    priority: 0,
    createdAt: seq,
    endedAt: seq,
    cancellable: true,
    input: {},
    ...overrides
  }
}

function many(count: number, overrides: Partial<Job> = {}): Job[] {
  return Array.from({ length: count }, () => job(overrides))
}

describe('isProtected', () => {
  it.each<JobState>(['queued', 'running'])('protects a %s job — never prune live work', (state) => {
    expect(isProtected(job({ state }))).toBe(true)
  })

  it('protects a succeeded job that still holds unreviewed output', () => {
    expect(isProtected(job({ state: 'succeeded', retainUntilConsumed: true }))).toBe(true)
  })

  it('does NOT protect a succeeded job without the flag', () => {
    expect(isProtected(job({ state: 'succeeded' }))).toBe(false)
  })

  it('does NOT protect a FAILED job of a retain-until-consumed type — a failed run produced no output to lose', () => {
    expect(isProtected(job({ state: 'failed', retainUntilConsumed: true }))).toBe(false)
  })

  it('does NOT protect a CANCELLED job of a retain-until-consumed type, for the same reason', () => {
    expect(isProtected(job({ state: 'cancelled', retainUntilConsumed: true }))).toBe(false)
  })

  it('protects an INTERRUPTED job — pruning one turns "click Resume" into "it vanished"', () => {
    expect(isProtected(job({ state: 'interrupted' }))).toBe(true)
  })
})

describe('selectJobsToPrune — the data-loss guarantees', () => {
  it('prunes nothing while at or under the cap', () => {
    expect(selectJobsToPrune(many(MAX_RETAINED_JOBS))).toEqual([])
    expect(selectJobsToPrune(many(10))).toEqual([])
  })

  it('NEVER prunes a job holding unreviewed output, even when far over the cap', () => {
    const draft = job({ state: 'succeeded', retainUntilConsumed: true, createdAt: 0, endedAt: 0 })
    const filler = many(MAX_RETAINED_JOBS + 200)
    const pruned = selectJobsToPrune([draft, ...filler])
    expect(pruned).not.toContain(draft.id)
    expect(pruned.length).toBeGreaterThan(0) // it really did prune, just not that one
  })

  it('NEVER prunes running or queued jobs, even when far over the cap', () => {
    const running = job({ state: 'running' })
    const queued = job({ state: 'queued' })
    const pruned = selectJobsToPrune([running, queued, ...many(MAX_RETAINED_JOBS + 100)])
    expect(pruned).not.toContain(running.id)
    expect(pruned).not.toContain(queued.id)
  })

  it('leaves the total ABOVE the cap rather than deleting protected work', () => {
    // Every single job is an unreviewed draft — nothing may be dropped.
    const drafts = many(MAX_RETAINED_JOBS + 50, { retainUntilConsumed: true })
    expect(selectJobsToPrune(drafts)).toEqual([])
  })
})

describe('selectJobsToPrune — what goes first', () => {
  it('drops exactly the overflow, no more', () => {
    const jobs = many(MAX_RETAINED_JOBS + 7)
    expect(selectJobsToPrune(jobs)).toHaveLength(7)
  })

  it('drops the OLDEST successes first', () => {
    const oldest = job({ createdAt: 1, endedAt: 1 })
    const newer = many(MAX_RETAINED_JOBS)
    const pruned = selectJobsToPrune([...newer, oldest])
    expect(pruned).toEqual([oldest.id])
  })

  it('gives up every disposable success before touching a failure', () => {
    // 3 over the cap, and exactly 3 old successes available to drop.
    const failures = many(MAX_RETAINED_JOBS, { state: 'failed' })
    const successes = many(3, { state: 'succeeded' })
    const pruned = selectJobsToPrune([...successes, ...failures])
    expect(pruned).toHaveLength(3)
    for (const s of successes) expect(pruned).toContain(s.id)
    for (const f of failures) expect(pruned).not.toContain(f.id)
  })

  it('treats CANCELLED like a failure, not like a routine success — "did that actually stop?" is worth investigating later', () => {
    const cancelled = job({ state: 'cancelled', createdAt: 1, endedAt: 1 })
    // One newer success is available; only one job needs to go.
    const success = job({ state: 'succeeded', createdAt: 999, endedAt: 999 })
    const filler = many(MAX_RETAINED_JOBS - 1, { state: 'failed' })
    const pruned = selectJobsToPrune([cancelled, success, ...filler])
    expect(pruned).toEqual([success.id]) // the NEWER success went, not the OLDER cancellation
  })

  it('never drops an INTERRUPTED job even when it is the oldest thing there — its checkpoint is what Resume continues from', () => {
    const interrupted = job({ state: 'interrupted', createdAt: 1, endedAt: 1 })
    const success = job({ state: 'succeeded', createdAt: 999, endedAt: 999 })
    const filler = many(MAX_RETAINED_JOBS - 1, { state: 'failed' })
    const pruned = selectJobsToPrune([interrupted, success, ...filler])
    expect(pruned).toEqual([success.id]) // the NEWER success went, not the OLDER interruption
    expect(pruned).not.toContain(interrupted.id)
  })

  it('falls back to createdAt for ordering when endedAt is missing (hand-edited/torn state file)', () => {
    const noEndedAt = job({ createdAt: 1, endedAt: undefined })
    const newer = many(MAX_RETAINED_JOBS, { createdAt: 500, endedAt: 500 })
    expect(selectJobsToPrune([...newer, noEndedAt])).toEqual([noEndedAt.id])
  })

  it('only drops failures once the successes have run out', () => {
    // 5 over the cap but only 2 successes exist — 3 failures must follow.
    const successes = many(2, { state: 'succeeded' })
    const failures = many(MAX_RETAINED_JOBS + 3, { state: 'failed' })
    const pruned = selectJobsToPrune([...successes, ...failures])
    expect(pruned).toHaveLength(5)
    for (const s of successes) expect(pruned).toContain(s.id)
  })
})

describe('selectJobsToPrune — a custom cap (used by tests and any future setting)', () => {
  it('honours a smaller cap', () => {
    const jobs = many(10)
    expect(selectJobsToPrune(jobs, 4)).toHaveLength(6)
  })

  it('still protects unreviewed drafts under a tiny cap', () => {
    const draft = job({ retainUntilConsumed: true })
    const pruned = selectJobsToPrune([draft, ...many(5)], 1)
    expect(pruned).not.toContain(draft.id)
    expect(pruned).toHaveLength(5) // everything else went
  })
})
