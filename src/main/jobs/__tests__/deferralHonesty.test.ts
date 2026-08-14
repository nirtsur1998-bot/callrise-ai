// M27 — the honesty half of quota-pressure deferral.
//
// Deferral can hold a background job for HOURS. Anything that already implied
// "this work is underway" the moment a job was created would go from briefly
// imprecise to flatly false. These pin the two surfaces that would have lied,
// plus the duplicate-run window deferral opens for recurring jobs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir: string
vi.mock('electron', () => ({ app: { getPath: () => dir } }))

const { ActivityNotifier } = await import('../activity')
const { JobManager } = await import('../JobManager')
const { setJobManager } = await import('../instance')

function job(over: Partial<Parameters<ActivityNotifierNext>[0][number]> = {}): never {
  return {
    id: 'j1',
    type: 't',
    title: 'Importing your past history into Sales Brain',
    state: 'queued',
    progress: { mode: 'indeterminate' },
    lane: 'BATCH',
    priority: 0,
    createdAt: 1,
    cancellable: false,
    input: {},
    ...over
  } as never
}
type ActivityNotifierNext = InstanceType<typeof ActivityNotifier>['next']

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'callrise-honesty-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('a queued job never announces that it started', () => {
  it('emits NOTHING for a job that is only queued', () => {
    // The bug this pins: the notifier used to fire on FIRST SIGHTING of any
    // job regardless of state, so a job held by quota pressure toasted
    // "Started: Importing…" while nothing had started.
    const n = new ActivityNotifier()
    expect(n.next([job({ state: 'queued' })])).toEqual([])
  })

  it('emits the start only when the job actually begins running', () => {
    const n = new ActivityNotifier()
    n.next([job({ state: 'queued' })]) // held — silent
    const events = n.next([job({ state: 'running' })])
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('started')
  })

  it('does not re-announce a job that was already running', () => {
    const n = new ActivityNotifier()
    n.next([job({ state: 'running' })])
    expect(n.next([job({ state: 'running' })])).toEqual([])
  })

  it('still reports the OUTCOME of a job that began and ended between snapshots', () => {
    // The throttled broadcast coalesces fast jobs; reporting the result is
    // the useful half, and is strictly better than the old behavior (which
    // announced a bogus "Started" for an already-finished job).
    const n = new ActivityNotifier()
    const events = n.next([job({ state: 'succeeded' })])
    expect(events).toHaveLength(1)
    expect(events[0].kind).not.toBe('started')
  })
})

describe('a recurring job cannot pile up while deferred', () => {
  // One test covering BOTH directions deliberately: registerNightly...Job has
  // a module-level "already registered" guard, so a second registration in
  // this file would silently no-op against a fresh manager. Splitting these
  // would leave the second one asserting against an empty queue and passing
  // for the wrong reason.
  it('holds a single run while deferred, and still allows the next one afterwards', async () => {
    let capacity = false
    const m = new JobManager([], { capacityGate: () => capacity })
    setJobManager(m)
    const { registerNightlyConsolidationJob, enqueueNightlyConsolidation } = await import(
      '../../memory/nightly-consolidation-job'
    )
    registerNightlyConsolidationJob(async () => {})

    // Deferral keeps night 1 queued past night 2's trigger. The scheduler
    // correctly considers the run due again (it stamps lastRuns at trigger
    // time, not completion), so the dedup has to live at the enqueue.
    enqueueNightlyConsolidation()
    enqueueNightlyConsolidation()
    expect(m.list().filter((j) => j.state === 'queued' || j.state === 'running')).toHaveLength(1)

    // ...but the dedup must not become "only ever runs once" — silently
    // skipping a run is the opposite failure and just as bad.
    capacity = true
    m.setCapacityGate(() => capacity)
    await vi.waitFor(() =>
      expect(m.list().every((j) => j.state === 'succeeded' || j.state === 'failed')).toBe(true)
    )
    enqueueNightlyConsolidation()
    expect(m.list()).toHaveLength(2)
    m.dispose()
  })
})
