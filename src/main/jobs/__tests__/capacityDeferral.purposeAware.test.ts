// M27 follow-up — the quota-pressure gate is PURPOSE-AWARE.
//
// Found in the field, not in review. Sales Brain's import ran straight into a
// fully-exhausted memory-extract chain while the gate reported capacity,
// failed three calls in a row and tripped the scan breaker. The app's own
// error said "every model set up for THIS is rate-limited" while the gate
// built to prevent exactly that said go.
//
// The gate asked "is ANY configured model usable?". A job walks ONE purpose's
// chain, which is a strict subset of the keyed catalog — narrowed by the
// purpose's assignment and again by tool-capability. Every model outside it
// is capacity the job can never spend.
//
// The original code carried a comment reading "DELIBERATELY NOT
// PURPOSE-AWARE" with a paragraph justifying it. That is taxonomy species 13
// — the claim that signals its own rigor — in our own runtime code.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir: string
vi.mock('electron', () => ({ app: { getPath: () => dir } }))

const { JobManager } = await import('../JobManager')
const { NO_AI_PURPOSE } = await import('../types')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'callrise-purpose-gate-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Registers a BATCH job type that blocks until released, so "did it start?"
 *  is observable as a state rather than inferred from a mock call count. */
function register(
  m: InstanceType<typeof JobManager>,
  type: string,
  aiPurpose: string | undefined
): void {
  m.registerType({
    type,
    lane: 'BATCH',
    aiPurpose,
    titleFor: () => type,
    executor: { kind: 'inline-async', run: () => new Promise<string>(() => {}) }
  })
}

describe('the gate asks about the purpose the job will actually walk', () => {
  it('defers a job whose own chain is exhausted, even while other models are usable', async () => {
    // The exact field condition: memory-extract is spent, something else isn't.
    const usableByPurpose: Record<string, boolean> = {
      'memory-extract': false,
      other: true
    }
    const m = new JobManager([], {
      capacityGate: (p) => (p === undefined ? true : usableByPurpose[p] ?? true)
    })
    register(m, 'import', 'memory-extract')

    const job = m.enqueue('import', {})
    await new Promise((r) => setTimeout(r, 10))

    // RED against the old gate: it took no argument, so it answered the
    // whole-catalog question — true, because `other` is fine — and started a
    // job whose every attempt was guaranteed to fail.
    expect(m.get(job.id)?.state).toBe('queued')
    expect(m.deferredJobIds().has(job.id)).toBe(true)
    m.dispose()
  })

  it('starts the job as soon as its own chain recovers', async () => {
    const usable: Record<string, boolean> = { 'memory-extract': false }
    const m = new JobManager([], { capacityGate: (p) => (p ? (usable[p] ?? true) : true) })
    register(m, 'import', 'memory-extract')

    const job = m.enqueue('import', {})
    await new Promise((r) => setTimeout(r, 10))
    expect(m.get(job.id)?.state).toBe('queued')

    usable['memory-extract'] = true
    m.enqueue('import', {}) // any enqueue re-ticks
    await new Promise((r) => setTimeout(r, 10))

    expect(m.get(job.id)?.state).toBe('running')
    m.dispose()
  })

  it('does not let one exhausted purpose stall an unrelated job in the same lane', async () => {
    const usable: Record<string, boolean> = { 'memory-extract': false, 'crm-note': true }
    const m = new JobManager([], {
      capacityGate: (p) => (p ? (usable[p] ?? true) : true),
      // Room for both, so anything held is held by capacity, not concurrency.
      maxRetainedJobs: 100
    })
    m.configureLanes({ BATCH: { maxConcurrent: 4 } })
    register(m, 'import', 'memory-extract')
    register(m, 'note', 'crm-note')

    const blocked = m.enqueue('import', {})
    const fine = m.enqueue('note', {})
    await new Promise((r) => setTimeout(r, 10))

    // RED against the first version, which skipped the WHOLE LANE on one
    // negative answer — an exhausted extract chain would have stalled CRM
    // note drafting that had capacity of its own.
    expect(m.get(blocked.id)?.state).toBe('queued')
    expect(m.get(fine.id)?.state).toBe('running')
    m.dispose()
  })
})

describe('jobs that use no AI provider', () => {
  it('never wait on AI quota', async () => {
    // Backup, calendar reminders, the auto-updater and the on-device
    // embeddings warm-up are all MAINTENANCE-lane and use no provider. Under
    // the first version of the gate an exhausted key silently stopped all
    // four — the app quietly stopped backing up, reminding, updating, and
    // finishing its local-search setup, for a condition none of them touch.
    const m = new JobManager([], { capacityGate: () => false }) // nothing usable anywhere
    m.registerType({
      type: 'backup',
      lane: 'MAINTENANCE',
      aiPurpose: NO_AI_PURPOSE,
      titleFor: () => 'backup',
      executor: { kind: 'inline-async', run: () => new Promise<string>(() => {}) }
    })

    const job = m.enqueue('backup', {})
    await new Promise((r) => setTimeout(r, 10))

    expect(m.get(job.id)?.state).toBe('running')
    expect(m.deferredJobIds().has(job.id)).toBe(false)
    m.dispose()
  })

  it('still defers a declared-purpose job under the same total outage', async () => {
    // The control for the test above: proves the gate is still WIRED and this
    // isn't just "nothing ever defers now". Without this, blinding the gate
    // entirely would pass the previous test.
    const m = new JobManager([], { capacityGate: () => false })
    register(m, 'import', 'memory-extract')

    const job = m.enqueue('import', {})
    await new Promise((r) => setTimeout(r, 10))

    expect(m.get(job.id)?.state).toBe('queued')
    m.dispose()
  })
})
