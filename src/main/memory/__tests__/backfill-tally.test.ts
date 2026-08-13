// BUG-057 — "scanned 102 calls, learned nothing because every AI call failed"
// must not be reportable as "Import complete."
//
// This is the piece that would have caught the whole bug on day one: the
// founder ran this exact import twice in one morning, it burned 99 doomed
// requests each time, and both runs reported green. These drive the REAL
// runBackfill and the REAL job executor registered by registerBackfill, with
// only extraction/consolidation/fs mocked.
import { describe, expect, it, beforeEach, vi } from 'vitest'
import type Database from 'better-sqlite3'

const isSalesBrainEnabled = vi.fn((): boolean => true)
vi.mock('../../app-settings', () => ({ isSalesBrainEnabled: () => isSalesBrainEnabled() }))

const listContacts = vi.fn(async (_dir: string): Promise<any[]> => [])
vi.mock('../../contacts-fs', () => ({ listContacts: (d: string) => listContacts(d) }))

const listDeals = vi.fn(async (_dir: string): Promise<any[]> => [])
vi.mock('../../deals-fs', () => ({ listDeals: (d: string) => listDeals(d) }))

const listCalls = vi.fn(async (_dir: string): Promise<any[]> => [])
const getCall = vi.fn(async (_dir: string, _id: string): Promise<any | null> => null)
vi.mock('../../calls-fs', () => ({
  listCalls: (d: string) => listCalls(d),
  getCall: (d: string, id: string) => getCall(d, id)
}))

const extractMemoriesFromCall = vi.fn(
  async (_s: any[], _c: string, _ct: string | null): Promise<any> => ({ candidates: [], aiFailed: false })
)
vi.mock('../extraction', () => ({
  extractMemoriesFromCall: (s: any[], c: string, ct: string | null) => extractMemoriesFromCall(s, c, ct)
}))

vi.mock('../consolidation', () => ({
  consolidateNewCandidate: async () => 'created',
  runLightConsolidation: async () => {}
}))

const { runBackfill } = await import('../backfill')

const FAKE_DB = {} as Database.Database
const DIRS = { callsDir: '/calls', contactsDir: '/contacts', dealsDir: '/deals' }

function summaryOf(id: string) {
  return {
    id,
    title: id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 60_000,
    speakerCount: 2,
    preview: '',
    hasSummary: true,
    attachmentCount: 0,
    hasCoaching: false,
    objectionsMined: false
  }
}
const fullOf = (id: string, o: Record<string, unknown> = {}) => ({
  ...summaryOf(id),
  segments: [{ speaker: 0, text: 'hello there', startMs: 0, endMs: 1000 }],
  ...o
})

const CANDIDATE = {
  scope: 'rep',
  category: 'rep-pattern',
  statement: 's',
  evidence: [{ type: 'transcript', callId: 'x', quote: 'q' }],
  confidence: 0.9,
  importance: 5,
  source: 'auto'
}

async function run(opts: Partial<Record<string, boolean>> = {}) {
  const progress: any[] = []
  await runBackfill(
    FAKE_DB,
    {
      includeContacts: opts.includeContacts ?? false,
      includeDeals: opts.includeDeals ?? false,
      includeCalls: opts.includeCalls ?? true,
      ...DIRS
    },
    (p) => progress.push(p)
  )
  return progress.at(-1)
}

beforeEach(() => {
  vi.clearAllMocks()
  isSalesBrainEnabled.mockReturnValue(true)
  listContacts.mockResolvedValue([])
  listDeals.mockResolvedValue([])
  getCall.mockImplementation(async (_d: string, id: string) => fullOf(id))
  extractMemoriesFromCall.mockResolvedValue({ candidates: [], aiFailed: false })
})

describe('runBackfill — an honest account of what the run did (BUG-057)', () => {
  it('a healthy run reports what it actually learned, not a hardcoded string', async () => {
    listCalls.mockResolvedValue([summaryOf('a'), summaryOf('b')])
    extractMemoriesFromCall.mockResolvedValue({ candidates: [CANDIDATE, CANDIDATE], aiFailed: false })

    const done = await run()

    expect(done.stage).toBe('done')
    expect(done.summary).toContain('Checked 2 calls')
    expect(done.summary).toContain('2 read')
    expect(done.summary).toContain('4 new things')
    expect(done.callsTotalFailure).toBe(false)
  })

  it('states 0 failed EXPLICITLY on a clean run — health asserted, not implied by silence', async () => {
    listCalls.mockResolvedValue([summaryOf('a'), summaryOf('b')])

    const done = await run()

    expect(done.summary).toContain('0 failed')
    expect(done.summary).toContain('0 skipped')
  })

  it('an intermittent failure rate that never trips the breaker is still fully visible', async () => {
    // The hole this closes: the breaker only catches THREE IN A ROW. A run
    // failing ~40% of calls while never failing three consecutively runs to
    // completion and succeeds — so the counts are the only thing separating
    // it from a genuinely healthy run. It must never read as a clean success.
    listCalls.mockResolvedValue(Array.from({ length: 10 }, (_, i) => summaryOf(`c${i}`)))
    let n = 0
    extractMemoriesFromCall.mockImplementation(async () => {
      n++
      // fail on 3,6,9 — never three consecutively, so the breaker never trips
      return n % 3 === 0
        ? { candidates: [], aiFailed: true, failureReason: 'sporadic 429' }
        : { candidates: [CANDIDATE], aiFailed: false }
    })

    const done = await run()

    // All ten attempted: the breaker correctly did NOT stop this run.
    expect(extractMemoriesFromCall).toHaveBeenCalledTimes(10)
    expect(done.summary).not.toContain('Stopped early')
    // ...and the failures are on the face of the summary regardless.
    expect(done.summary).toContain('Checked 10 calls')
    expect(done.summary).toContain('7 read')
    expect(done.summary).toContain('3 failed')
    expect(done.summary).toContain('sporadic 429')
    // Not a total failure — some calls genuinely worked — so the job still
    // succeeds. The counts, not the job state, are what tell the truth here.
    expect(done.callsTotalFailure).toBe(false)
  })

  it('a run where every AI call failed says so, and flags total failure', async () => {
    listCalls.mockResolvedValue([summaryOf('a'), summaryOf('b'), summaryOf('c'), summaryOf('d')])
    extractMemoriesFromCall.mockResolvedValue({
      candidates: [],
      aiFailed: true,
      failureReason: 'Gemini is rate-limiting requests right now.'
    })

    const done = await run()

    expect(done.callsTotalFailure).toBe(true)
    expect(done.summary).toContain('0 read')
    expect(done.summary).toContain('3 failed')
    expect(done.summary).toContain('Stopped early after 3 failures in a row')
    expect(done.summary).toContain('rate-limiting')
  })

  it('the circuit breaker stops after 3 consecutive failures instead of burning a request per call', async () => {
    // The real incident: 99 calls, 99 doomed requests, twice in one morning.
    listCalls.mockResolvedValue(Array.from({ length: 99 }, (_, i) => summaryOf(`c${i}`)))
    extractMemoriesFromCall.mockResolvedValue({ candidates: [], aiFailed: true, failureReason: 'rate limit' })

    await run()

    expect(extractMemoriesFromCall).toHaveBeenCalledTimes(3)
  })

  it('a successful run that genuinely finds nothing is NOT a failure', async () => {
    // The distinction that did not exist: zero memories because there was
    // nothing to learn must never read the same as zero because everything broke.
    listCalls.mockResolvedValue([summaryOf('a'), summaryOf('b')])
    extractMemoriesFromCall.mockResolvedValue({ candidates: [], aiFailed: false })

    const done = await run()

    expect(done.callsTotalFailure).toBe(false)
    expect(done.summary).toContain('2 read')
    expect(done.summary).toContain('Learned 0 new things')
    // "0 failed" is stated rather than omitted — that IS the signal that this
    // empty result is a healthy one, and the reason it can't be confused with
    // the every-call-failed run above.
    expect(done.summary).toContain('0 failed')
  })

  it('excluded / transcript-less calls count as skips, never as failures', async () => {
    // A skip must not trip the breaker — otherwise a library of excluded calls
    // would report "stopped after repeated errors" on a perfectly healthy API.
    listCalls.mockResolvedValue([summaryOf('a'), summaryOf('b'), summaryOf('c'), summaryOf('d')])
    getCall.mockImplementation(async (_d: string, id: string) => fullOf(id, { salesBrainExcluded: true }))

    const done = await run()

    expect(extractMemoriesFromCall).not.toHaveBeenCalled()
    expect(done.callsTotalFailure).toBe(false)
    expect(done.summary).toContain('skipped')
    expect(done.summary).not.toContain('stopped after repeated errors')
  })

  it('partial success is not total failure — some calls worked', async () => {
    listCalls.mockResolvedValue([summaryOf('a'), summaryOf('b')])
    extractMemoriesFromCall
      .mockResolvedValueOnce({ candidates: [CANDIDATE], aiFailed: false })
      .mockResolvedValueOnce({ candidates: [], aiFailed: true, failureReason: 'boom' })

    const done = await run()

    expect(done.callsTotalFailure).toBe(false)
    expect(done.summary).toContain('1 failed')
  })

  it('a contacts/deals-only run has no AI call to fail, and says nothing misleading', async () => {
    const done = await run({ includeCalls: false, includeContacts: true })

    expect(done.callsTotalFailure).toBe(false)
    expect(done.summary).toBe('Import complete.')
  })
})

describe('the job executor turns a total AI failure into a FAILED job', () => {
  it('throws when the calls stage attempted extractions and none succeeded', async () => {
    // The layer that decides green-check vs red-with-Retry. Registered
    // executor is captured and driven directly.
    vi.resetModules()

    let captured: any = null
    vi.doMock('../../jobs/instance', () => ({
      getJobManager: () => ({
        registerType: (cfg: unknown) => {
          captured = cfg
        },
        list: () => [],
        enqueue: () => ({ id: 'job-1' })
      })
    }))
    vi.doMock('../memory-runtime', () => ({ getMemoryDb: () => ({}) }))
    vi.doMock('electron', () => ({
      app: { getPath: () => '/userData' },
      ipcMain: { handle: () => {} }
    }))

    const backfillMock = vi.fn(async (_db: unknown, _o: unknown, onProgress: (p: unknown) => void) => {
      onProgress({
        running: false,
        stage: 'done',
        processed: 0,
        total: 0,
        summary: 'Scanned 0 calls, found 0 new things, 3 failed, stopped after repeated errors (rate limit)',
        callsTotalFailure: true
      })
    })
    vi.doMock('../backfill', () => ({ runBackfill: backfillMock }))

    const { registerBackfill } = await import('../backfill-ipc')
    registerBackfill()

    await expect(
      captured.executor.run({ includeContacts: false, includeDeals: false, includeCalls: true }, {
        reportProgress: () => {}
      })
    ).rejects.toThrow(/stopped after repeated errors/)
  })

  it('returns the real summary — not "Import complete." — on a healthy run', async () => {
    vi.resetModules()

    let captured: any = null
    vi.doMock('../../jobs/instance', () => ({
      getJobManager: () => ({
        registerType: (cfg: unknown) => {
          captured = cfg
        },
        list: () => [],
        enqueue: () => ({ id: 'job-1' })
      })
    }))
    vi.doMock('../memory-runtime', () => ({ getMemoryDb: () => ({}) }))
    vi.doMock('electron', () => ({
      app: { getPath: () => '/userData' },
      ipcMain: { handle: () => {} }
    }))
    vi.doMock('../backfill', () => ({
      runBackfill: async (_db: unknown, _o: unknown, onProgress: (p: unknown) => void) => {
        onProgress({
          running: false,
          stage: 'done',
          processed: 0,
          total: 0,
          summary: 'Scanned 42 calls, found 37 new things',
          callsTotalFailure: false
        })
      }
    }))

    const { registerBackfill } = await import('../backfill-ipc')
    registerBackfill()

    const result = await captured.executor.run(
      { includeContacts: false, includeDeals: false, includeCalls: true },
      { reportProgress: () => {} }
    )
    expect(result).toBe('Scanned 42 calls, found 37 new things')
  })
})
