// M26 Phase 5 — nightly consolidation moved from a hand-rolled ~20h
// timestamp file to jobs/scheduler.ts's shared Scheduler.registerRecurring.
// Drives the REAL maybeRunNightlyConsolidation() against mocked db/
// job-registration/scheduler collaborators.
import { describe, expect, it, beforeEach, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/fake/userData' } }))

const enabled = { current: true }
vi.mock('../../app-settings', () => ({ isSalesBrainEnabled: () => enabled.current }))

const fakeDb = { fake: true }
vi.mock('../db', () => ({
  memoryDbPath: () => '/fake/userData/memory.db',
  openMemoryDb: () => fakeDb,
  migrate: async () => ({ ok: true, migrated: false, fromVersion: 1, toVersion: 1 })
}))
vi.mock('../embeddings', () => ({
  configureEmbeddingsCacheDir: () => {},
  warmUpEmbeddings: async () => {}
}))

const runNightlyConsolidation = vi.fn(async (_db: unknown) => {})
vi.mock('../consolidation', () => ({ runNightlyConsolidation: (db: unknown) => runNightlyConsolidation(db) }))

const registerNightlyConsolidationJob = vi.fn()
const enqueueNightlyConsolidation = vi.fn()
vi.mock('../nightly-consolidation-job', () => ({
  registerNightlyConsolidationJob: (run: () => Promise<void>) => registerNightlyConsolidationJob(run),
  enqueueNightlyConsolidation: () => enqueueNightlyConsolidation(),
  registerWarmUpEmbeddingsJob: () => {},
  enqueueWarmUpEmbeddings: () => {}
}))

const registerRecurring = vi.fn()
vi.mock('../../jobs/scheduler-instance', () => ({
  getScheduler: () => ({ registerRecurring })
}))

const { initSalesBrain, maybeRunNightlyConsolidation, __resetForTests } = await import('../memory-runtime')

beforeEach(() => {
  enabled.current = true
  registerNightlyConsolidationJob.mockClear()
  enqueueNightlyConsolidation.mockClear()
  registerRecurring.mockClear()
  runNightlyConsolidation.mockClear()
  __resetForTests()
})

describe('maybeRunNightlyConsolidation', () => {
  it('does nothing when Sales Brain is off — no job registered, no recurring spec added', () => {
    enabled.current = false
    maybeRunNightlyConsolidation()
    expect(registerNightlyConsolidationJob).not.toHaveBeenCalled()
    expect(registerRecurring).not.toHaveBeenCalled()
  })

  it('does nothing when init never ran (db still null), even if Sales Brain is on', () => {
    maybeRunNightlyConsolidation()
    expect(registerRecurring).not.toHaveBeenCalled()
  })

  it('registers the job type and a recurring spec named for this job, once init has run', async () => {
    await initSalesBrain()
    maybeRunNightlyConsolidation()
    expect(registerNightlyConsolidationJob).toHaveBeenCalledTimes(1)
    expect(registerRecurring).toHaveBeenCalledTimes(1)
    const spec = registerRecurring.mock.calls[0][0]
    expect(spec.name).toBe('salesBrain:nightlyConsolidation')
    expect(spec.intervalMs).toBe(20 * 60 * 60 * 1000)
  })

  it("the recurring spec's run() enqueues when still enabled", async () => {
    await initSalesBrain()
    maybeRunNightlyConsolidation()
    const spec = registerRecurring.mock.calls[0][0]
    spec.run()
    expect(enqueueNightlyConsolidation).toHaveBeenCalledTimes(1)
  })

  it("the recurring spec's run() re-checks isSalesBrainEnabled() FRESH — does not enqueue if turned off since registration", async () => {
    await initSalesBrain()
    maybeRunNightlyConsolidation()
    const spec = registerRecurring.mock.calls[0][0]
    enabled.current = false // the rep turned it off sometime in the ~20h since registration
    spec.run()
    expect(enqueueNightlyConsolidation).not.toHaveBeenCalled()
  })

  it("the job executor passed to registerNightlyConsolidationJob calls runNightlyConsolidation with the live db", async () => {
    await initSalesBrain()
    maybeRunNightlyConsolidation()
    const run = registerNightlyConsolidationJob.mock.calls[0][0] as () => Promise<void>
    await run()
    expect(runNightlyConsolidation).toHaveBeenCalledWith(fakeDb)
  })
})
