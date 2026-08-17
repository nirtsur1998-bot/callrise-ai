// M27 — the import's progress bar must count against the WHOLE call
// library, not just what this run has left to do.
//
// The resume mechanism (backfill-ledger.ts) already worked: a run cut short
// by an exhausted key picked up where it stopped rather than restarting.
// What it never did was SHOW that on screen. Every run's onProgress reported
// `total: withTranscripts.length` — the count of calls STILL REMAINING after
// filtering out already-attempted ones — so a resumed run's progress bar
// read "0 / 103" instead of "10 / 113". The denominator shrank and the
// numerator reset to zero on every single run, which is indistinguishable
// from "starting over" to anyone watching, even though the underlying work
// was genuinely cumulative. The founder's own report of this — "it needs to
// pick up where it reached and continue from that point" — described a
// mechanism that already existed; what was missing was visibility into it.
//
// These drive the REAL runBackfill, capturing every onProgress call across
// two separate runs, the same infra backfill-tally.test.ts's resume test
// uses.
import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
const { openMemoryDb, memoryDbPath, migrate } = await import('../db')

let FAKE_DB: Database.Database
let dbDir: string

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'callrise-cumulative-progress-'))
  FAKE_DB = openMemoryDb(memoryDbPath(dbDir))
  const res = await migrate(FAKE_DB, memoryDbPath(dbDir))
  if (!res.ok) throw new Error(`migrate failed: ${JSON.stringify(res)}`)
  vi.clearAllMocks()
  isSalesBrainEnabled.mockReturnValue(true)
  listContacts.mockResolvedValue([])
  listDeals.mockResolvedValue([])
})

afterEach(() => {
  FAKE_DB.close()
  rmSync(dbDir, { recursive: true, force: true })
})

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

function fullOf(id: string) {
  return { ...summaryOf(id), segments: [{ speaker: 0, text: 'hello', startMs: 0, endMs: 1000 }] }
}

/** All progress payloads from one run, in order — not just the last, which
 *  is all the shared `run()` helper elsewhere in this suite keeps. The
 *  cumulative behaviour is only visible in the sequence. */
async function runCapturingProgress(): Promise<any[]> {
  const progress: any[] = []
  await runBackfill(
    FAKE_DB,
    { includeContacts: false, includeDeals: false, includeCalls: true, ...DIRS },
    (p) => progress.push(p)
  )
  return progress
}

const CALLS = ['a', 'b', 'c', 'd', 'e']

describe('cumulative progress across a resumed run', () => {
  it('the FIRST run counts against the whole eligible set from the start', async () => {
    listCalls.mockResolvedValue(CALLS.map(summaryOf))
    getCall.mockImplementation(async (_d: string, id: string) => fullOf(id))
    extractMemoriesFromCall.mockResolvedValue({ candidates: [], aiFailed: false })

    const progress = await runCapturingProgress()
    const callsStage = progress.filter((p) => p.stage === 'calls')

    // total is the WHOLE eligible set (5) on every single payload, never the
    // shrinking "remaining" count.
    expect(callsStage.every((p) => p.total === 5)).toBe(true)
    // processed climbs 0 -> 1 -> 2 -> 3 -> 4 -> 5, ending at the true total.
    expect(callsStage.map((p) => p.processed)).toEqual([0, 1, 2, 3, 4, 5])
  })

  // THE CASE THAT MATTERS. Two calls succeed, then the key runs out — three
  // failures trip the breaker with two calls never attempted. Resuming must
  // show progress starting at 2 (not 0) and total staying at 5 (not
  // shrinking to 3), i.e. "2 of 5" advancing to "5 of 5", never "0 of 3".
  it('a RESUMED run starts counting from what was already done, against the same total', async () => {
    listCalls.mockResolvedValue(CALLS.map(summaryOf))
    getCall.mockImplementation(async (_d: string, id: string) => fullOf(id))

    // Run 1: a and b succeed, then the key is spent — c, d, e fail and the
    // breaker trips on the third consecutive failure.
    extractMemoriesFromCall.mockImplementation(async (_s: any[], id: string) =>
      id === 'a' || id === 'b'
        ? { candidates: [], aiFailed: false }
        : { candidates: [], aiFailed: true, failureReason: 'rate-limited' }
    )
    await runCapturingProgress()

    // Run 2: quota restored. c, d, e (the failed ones) get retried.
    extractMemoriesFromCall.mockClear()
    extractMemoriesFromCall.mockImplementation(async () => ({ candidates: [], aiFailed: false }))
    const progress = await runCapturingProgress()
    const callsStage = progress.filter((p) => p.stage === 'calls')

    // RED without the fix: this run's own `withTranscripts` is only [c,d,e]
    // (a and b are already attempted), so the old code reported
    // total: 3, processed: 0,1,2,3 — a progress bar that looks like it
    // restarted at zero against a smaller total, even though two calls were
    // already done and nothing was lost.
    expect(callsStage.every((p) => p.total === 5)).toBe(true)
    // Starts at 2 (the two done in run 1), climbs to 5 as c, d, e complete —
    // continuous progress across the run boundary, not a reset.
    expect(callsStage.map((p) => p.processed)).toEqual([2, 3, 4, 5])
  })

  it('a call excluded from Sales Brain still counts toward cumulative progress', async () => {
    // Skipped calls are recorded in the ledger (backfill.ts) and must move
    // the counter exactly like a successful or failed one — the bar should
    // never look stuck on a call the user deliberately excluded.
    listCalls.mockResolvedValue(CALLS.map(summaryOf))
    getCall.mockImplementation(async (_d: string, id: string) =>
      id === 'c' ? { ...fullOf(id), salesBrainExcluded: true } : fullOf(id)
    )
    extractMemoriesFromCall.mockResolvedValue({ candidates: [], aiFailed: false })

    const progress = await runCapturingProgress()
    const callsStage = progress.filter((p) => p.stage === 'calls')

    expect(callsStage.map((p) => p.processed)).toEqual([0, 1, 2, 3, 4, 5])
    expect(callsStage.every((p) => p.total === 5)).toBe(true)
  })
})
