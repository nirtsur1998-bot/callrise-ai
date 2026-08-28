// M27 — quota-pressure-aware job deferral.
//
// When EVERY configured AI model is unusable (daily quota spent, cooling
// down, structurally broken), starting a BATCH/MAINTENANCE job would walk its
// whole fallback chain, fail every entry, and add retry pressure to a key
// live coaching is also competing for. Holding it queued is strictly better:
// no wasted requests, and it resumes the moment anything frees up.
//
// Two layers, tested separately: the capacity signal itself (ai/capacity.ts)
// against the REAL catalog and cooldown state, then the scheduler behavior
// (JobManager) driven through a real enqueue with a controllable gate.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir: string
vi.mock('electron', () => ({ app: { getPath: () => dir } }))

const { hasUsableAiCapacity } = await import('../../ai/capacity')
const { markPeriodExhausted, markStructurallyBroken, resetCooldownsForTests } = await import(
  '../../ai/model-cooldown'
)
const { markUsed, resetPacingForTests } = await import('../../ai/model-pacing')
const { JobManager } = await import('../JobManager')
const { MODEL_CATALOG } = await import('../../ai/model-catalog')
const { PROVIDER_REGISTRY } = await import('../../ai/registry')

const ORIGINAL_ENV = { ...process.env }
const NOW = 1_000_000

/** Every catalog id whose provider we're about to configure a key for. */
function idsForProvider(providerId: string): string[] {
  return MODEL_CATALOG.filter((e) => e.providerId === providerId && !e.knownStale).map((e) => e.id)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'callrise-capacity-'))
  resetCooldownsForTests()
  resetPacingForTests()
  // A realistic single-free-provider setup: only Groq configured.
  process.env = { ...ORIGINAL_ENV }
  for (const p of Object.values(PROVIDER_REGISTRY)) delete process.env[p.keyEnvName]
  process.env.GROQ_API_KEY = 'test-key'
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  rmSync(dir, { recursive: true, force: true })
})

describe('hasUsableAiCapacity — the signal', () => {
  it('is true when nothing is cooling down', () => {
    expect(hasUsableAiCapacity(NOW)).toBe(true)
  })

  it('is FALSE only once every configured model is unusable', () => {
    const groqIds = idsForProvider('groq')
    expect(groqIds.length).toBeGreaterThan(1) // otherwise "every" proves nothing

    // Exhaust all but one — capacity still exists, so no deferral.
    for (const id of groqIds.slice(0, -1)) markPeriodExhausted(id, undefined, NOW, 'durable')
    expect(hasUsableAiCapacity(NOW)).toBe(true)

    // The last one goes too.
    markPeriodExhausted(groqIds[groqIds.length - 1], undefined, NOW, 'durable')
    expect(hasUsableAiCapacity(NOW)).toBe(false)
  })

  // AUDIT FIX (2026-08-24) — this assertion INVERTED deliberately when
  // structural breaks became purpose-scoped, and the inversion is the point.
  //
  // hasUsableAiCapacity is the no-purpose fallback (src/main/index.ts:360);
  // every caller that knows its purpose uses hasUsableCapacityForPurpose,
  // which still counts breaks for that purpose (capacityForPurpose.test.ts).
  // A break is now evidence about one purpose's request shape, so it cannot
  // answer "does anything have capacity at all". Treating it as if it could
  // is what let one rejected Rise attachment defer every background job in
  // the app behind a "waiting for provider capacity" label that no success
  // could ever clear — a blacklisted model is filtered out of every chain,
  // so it can never earn the success that clears it early.
  it("does NOT count another purpose's structural break — breaks are purpose-scoped", () => {
    for (const id of idsForProvider('groq')) markStructurallyBroken(id, NOW, 'assistant-chat')
    expect(hasUsableAiCapacity(NOW)).toBe(true)
  })

  it('recovers as soon as ONE model comes back', () => {
    const groqIds = idsForProvider('groq')
    for (const id of groqIds) markPeriodExhausted(id, 60_000, NOW, 'durable')
    expect(hasUsableAiCapacity(NOW)).toBe(false)
    // One minute later that cooldown has expired.
    expect(hasUsableAiCapacity(NOW + 60_001)).toBe(true)
  })

  it('a merely-PACED model still counts as capacity — pacing is our own spacing, not the provider refusing', () => {
    // The flicker case: an ordinary burst marks every model used within the
    // last few seconds. That is not quota pressure and must not read as
    // "waiting for provider capacity".
    for (const id of idsForProvider('groq')) markUsed(id, NOW, 'durable')
    expect(hasUsableAiCapacity(NOW + 100)).toBe(true)
  })

  it('is TRUE when no keys are configured at all — a setup state, not pressure', () => {
    // Deferring here would hide the real, actionable "no AI provider is set
    // up" error behind a label implying a temporary condition.
    for (const p of Object.values(PROVIDER_REGISTRY)) delete process.env[p.keyEnvName]
    expect(hasUsableAiCapacity(NOW)).toBe(true)
  })
})

describe('JobManager — what actually defers', () => {
  const started: string[] = []

  function managerWithGate(hasCapacity: () => boolean): InstanceType<typeof JobManager> {
    const m = new JobManager([], { capacityGate: hasCapacity })
    for (const [type, lane] of [
      ['batch-job', 'BATCH'],
      ['maint-job', 'MAINTENANCE'],
      ['interactive-job', 'INTERACTIVE']
    ] as const) {
      m.registerType({
        type,
        lane,
        titleFor: () => type,
        executor: {
          kind: 'inline-async',
          run: async () => {
            started.push(type)
            return 'done'
          }
        }
      })
    }
    return m
  }

  beforeEach(() => {
    started.length = 0
  })

  it('holds a BATCH job while there is no capacity, and it stays plain "queued"', () => {
    const m = managerWithGate(() => false)
    const job = m.enqueue('batch-job', {})
    expect(started).toEqual([])
    // Deliberately NOT a new persisted state — nothing about retention, the
    // quit guard or resume has to learn about deferral.
    expect(m.get(job.id)?.state).toBe('queued')
    m.dispose()
  })

  it('still starts an INTERACTIVE job under the same pressure — the rep is waiting on it', () => {
    const m = managerWithGate(() => false)
    m.enqueue('interactive-job', {})
    expect(started).toEqual(['interactive-job'])
    m.dispose()
  })

  it('starts the held job as soon as capacity returns', () => {
    let capacity = false
    const m = managerWithGate(() => capacity)
    m.enqueue('batch-job', {})
    expect(started).toEqual([])

    capacity = true
    m.setCapacityGate(() => capacity) // production's un-defer path re-ticks
    expect(started).toEqual(['batch-job'])
    m.dispose()
  })

  it('defers MAINTENANCE too, and never defers when capacity is fine', () => {
    const ok = managerWithGate(() => true)
    ok.enqueue('maint-job', {})
    expect(started).toEqual(['maint-job'])
    ok.dispose()

    started.length = 0
    const pressured = managerWithGate(() => false)
    pressured.enqueue('maint-job', {})
    expect(started).toEqual([])
    pressured.dispose()
  })
})

describe('deferredJobIds — the derived label, never stored', () => {
  function manager(hasCapacity: () => boolean, laneMax = 1): InstanceType<typeof JobManager> {
    const m = new JobManager([], { capacityGate: hasCapacity })
    m.configureLanes({ BATCH: { maxConcurrent: laneMax } })
    m.registerType({
      type: 'slow-batch',
      lane: 'BATCH',
      titleFor: () => 'slow',
      executor: { kind: 'inline-async', run: () => new Promise<string>(() => {}) } // never resolves
    })
    return m
  }

  it('flags a job held by pressure', () => {
    const m = manager(() => false)
    const job = m.enqueue('slow-batch', {})
    expect(m.deferredJobIds().has(job.id)).toBe(true)
    m.dispose()
  })

  it('does NOT flag a job that is merely queued behind a running one', () => {
    // The distinction that makes the label honest: with capacity fine, the
    // first job runs and the second waits its turn — that is not pressure.
    const m = manager(() => true)
    m.enqueue('slow-batch', {})
    const second = m.enqueue('slow-batch', {})
    expect(m.deferredJobIds().has(second.id)).toBe(false)
    m.dispose()
  })

  it('flags nothing at all while capacity is available', () => {
    const m = manager(() => true)
    m.enqueue('slow-batch', {})
    expect(m.deferredJobIds().size).toBe(0)
    m.dispose()
  })

  it('does not flag a job whose lane is already full, even under pressure — it is blocked by the lane, not capacity', () => {
    // Capacity is fine at first so job 1 actually starts and occupies BATCH;
    // then pressure arrives. Job 2 is queued behind a RUNNING job, so
    // "waiting for AI capacity" would be the wrong explanation for it.
    let capacity = true
    const m = manager(() => capacity)
    m.enqueue('slow-batch', {}) // starts, occupies the lane
    const second = m.enqueue('slow-batch', {})
    capacity = false
    expect(m.deferredJobIds().has(second.id)).toBe(false)
    m.dispose()
  })
})

// M27 concern 3 (the founder's own question): what happens when capacity
// returns briefly, a job starts, and capacity vanishes again mid-job?
//
// ANSWER — CONFIRMED INTENDED, and deliberately NOT given a stability window:
//   1. tick() gates STARTING only. A running job is never interrupted, which
//      is correct — interrupting would discard work already done, and most of
//      these jobs have no resume.
//   2. The "one request that freed up" isn't a real provider credit. A model
//      becomes eligible because OUR OWN cooldown timer expired, not because
//      the provider said so. Something has to actually attempt it for the
//      system to learn whether the quota really reset — clearCooldown() on
//      success is the only exit from a cooldown. So this probe is the
//      recovery mechanism, not a waste of one.
//   3. A stability window could only DELAY that probe, never avoid it, since
//      it has no other way to distinguish "our guess expired early" from
//      "genuinely recovered."
//   4. Deferral is strictly better than today's behavior even in this case:
//      without it the job runs immediately under full pressure and burns its
//      WHOLE chain; with it, it waits and spends one probe with a real chance
//      of succeeding.
// This test pins (1) — the property a future change could silently break.
describe('a running job is never re-deferred mid-flight', () => {
  it('keeps running when capacity disappears after it started', async () => {
    let capacity = true
    let finished = false
    const m = new JobManager([], { capacityGate: () => capacity })
    let release!: () => void
    m.registerType({
      type: 'long-batch',
      lane: 'BATCH',
      titleFor: () => 'long',
      executor: {
        kind: 'inline-async',
        run: () =>
          new Promise<string>((resolve) => {
            release = () => {
              finished = true
              resolve('done')
            }
          })
      }
    })

    const job = m.enqueue('long-batch', {})
    expect(m.get(job.id)?.state).toBe('running')

    capacity = false // the flap
    expect(m.get(job.id)?.state).toBe('running') // still running, not clawed back

    release()
    await vi.waitFor(() => expect(finished).toBe(true))
    m.dispose()
  })
})
