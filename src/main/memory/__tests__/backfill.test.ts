// BUG-046 — the salesBrainExcluded/isSalesBrainEnabled backfill gap.
//
// Two fresh-read permission checks were missing from runBackfill's calls
// loop: a call the rep marked "don't learn from this" was extracted anyway,
// and the global Sales Brain switch was only checked once at job-trigger
// time (backfill-ipc.ts), never re-checked during a long-running loop. Per
// memory-hooks.ts's own rule (permissions are read fresh, never snapshotted)
// these must be re-checked on every iteration. These tests drive the real
// runBackfill against fully mocked fs/extraction/consolidation dependencies,
// so the assertion is about the actual gate wired into the loop, not a
// description of it.
import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'

const isSalesBrainEnabled = vi.fn((): boolean => true)
vi.mock('../../app-settings', () => ({ isSalesBrainEnabled: () => isSalesBrainEnabled() }))

const listContacts = vi.fn(async (_dir: string): Promise<any[]> => [])
vi.mock('../../contacts-fs', () => ({ listContacts: (dir: string) => listContacts(dir) }))

const listDeals = vi.fn(async (_dir: string): Promise<any[]> => [])
vi.mock('../../deals-fs', () => ({ listDeals: (dir: string) => listDeals(dir) }))

const listCalls = vi.fn(async (_dir: string): Promise<any[]> => [])
const getCall = vi.fn(async (_dir: string, _id: string): Promise<any | null> => null)
vi.mock('../../calls-fs', () => ({
  listCalls: (dir: string) => listCalls(dir),
  getCall: (dir: string, id: string) => getCall(dir, id)
}))

const extractMemoriesFromCall = vi.fn(
  async (_segments: any[], _callId: string, _contactId: string | null): Promise<any> => ({
    candidates: [],
    aiFailed: false
  })
)
vi.mock('../extraction', () => ({
  extractMemoriesFromCall: (segments: any[], callId: string, contactId: string | null) =>
    extractMemoriesFromCall(segments, callId, contactId)
}))

const consolidateNewCandidate = vi.fn(async (_db: unknown, _candidate: any): Promise<string> => 'created')
const runLightConsolidation = vi.fn(async (_db: unknown, _scope: any): Promise<void> => {})
vi.mock('../consolidation', () => ({
  consolidateNewCandidate: (db: unknown, candidate: any) => consolidateNewCandidate(db, candidate),
  runLightConsolidation: (db: unknown, scope: any) => runLightConsolidation(db, scope)
}))

const { runBackfill } = await import('../backfill')
const { openMemoryDb, memoryDbPath, migrate } = await import('../db')

function callSummary(id: string, overrides: Partial<Record<string, unknown>> = {}) {
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
    objectionsMined: false,
    ...overrides
  }
}

function fullCall(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ...callSummary(id),
    segments: [{ speaker: 0, text: 'hello', startMs: 0, endMs: 1000 }],
    ...overrides
  }
}

// M27 — a REAL database, not `{} as Database`. runBackfill now keeps a
// resume ledger (backfill-ledger.ts) so a run cut short by an exhausted key
// picks up where it stopped, and that ledger is a real table. A stub object
// would either crash on `db.prepare` or force the ledger to be written
// defensively enough to no-op in production too, which is how the resume
// would silently regress. Rebuilt per test so one test's attempts can never
// make the next one skip work it meant to do.
let FAKE_DB: Database.Database
let dbDir: string

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'callrise-backfill-'))
  FAKE_DB = openMemoryDb(memoryDbPath(dbDir))
  const res = await migrate(FAKE_DB, memoryDbPath(dbDir))
  if (!res.ok) throw new Error(`migrate failed: ${JSON.stringify(res)}`)
})

afterEach(() => {
  FAKE_DB.close()
  rmSync(dbDir, { recursive: true, force: true })
})

describe('runBackfill — BUG-046 fresh-permission checks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isSalesBrainEnabled.mockReturnValue(true)
    consolidateNewCandidate.mockResolvedValue('created')
  })

  it('skips a call marked salesBrainExcluded and still processes the others', async () => {
    listCalls.mockResolvedValue([callSummary('call-a'), callSummary('call-b'), callSummary('call-c')])
    getCall.mockImplementation(async (_dir: string, id: string) => {
      if (id === 'call-b') return fullCall('call-b', { salesBrainExcluded: true })
      return fullCall(id)
    })

    const progress: unknown[] = []
    await runBackfill(
      FAKE_DB,
      {
        includeContacts: false,
        includeDeals: false,
        includeCalls: true,
        callsDir: '/calls',
        contactsDir: '/contacts',
        dealsDir: '/deals'
      },
      (p) => progress.push(p)
    )

    const extractedIds = extractMemoriesFromCall.mock.calls.map((c) => c[1])
    expect(extractedIds).toEqual(['call-a', 'call-c'])
    expect(progress.at(-1)).toMatchObject({ stage: 'done' })
  })

  it('the global switch is checked fresh — turning it off mid-run halts the rest of the backfill', async () => {
    listCalls.mockResolvedValue([callSummary('call-a'), callSummary('call-b'), callSummary('call-c')])
    getCall.mockImplementation(async (_dir: string, id: string) => fullCall(id))

    // Enabled through the top-level check and call-a's own check, then the
    // rep turns Sales Brain off before call-b's check runs.
    let calls = 0
    isSalesBrainEnabled.mockImplementation(() => {
      calls++
      return calls <= 2
    })

    const progress: Array<{ stage: string; lastError?: string }> = []
    await runBackfill(
      FAKE_DB,
      {
        includeContacts: false,
        includeDeals: false,
        includeCalls: true,
        callsDir: '/calls',
        contactsDir: '/contacts',
        dealsDir: '/deals'
      },
      (p) => progress.push(p as { stage: string; lastError?: string })
    )

    expect(extractMemoriesFromCall).toHaveBeenCalledTimes(1)
    expect(extractMemoriesFromCall.mock.calls[0][1]).toBe('call-a')
    const last = progress.at(-1)
    expect(last?.stage).toBe('error')
    expect(last?.lastError).toMatch(/turned off/i)
  })

  it('already disabled before the run starts processes nothing at all', async () => {
    isSalesBrainEnabled.mockReturnValue(false)

    const progress: Array<{ stage: string }> = []
    await runBackfill(
      FAKE_DB,
      {
        includeContacts: true,
        includeDeals: true,
        includeCalls: true,
        callsDir: '/calls',
        contactsDir: '/contacts',
        dealsDir: '/deals'
      },
      (p) => progress.push(p as { stage: string })
    )

    expect(listContacts).not.toHaveBeenCalled()
    expect(listDeals).not.toHaveBeenCalled()
    expect(listCalls).not.toHaveBeenCalled()
    expect(progress.at(-1)?.stage).toBe('error')
  })

  it('mid-run disable during the contacts stage also stops before the calls stage starts', async () => {
    listContacts.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }])
    listCalls.mockResolvedValue([callSummary('call-a')])
    getCall.mockImplementation(async (_dir: string, id: string) => fullCall(id))

    let calls = 0
    isSalesBrainEnabled.mockImplementation(() => {
      calls++
      // Pass the top-level assert and the first contact's assert, then go off.
      return calls <= 2
    })

    await runBackfill(
      FAKE_DB,
      {
        includeContacts: true,
        includeDeals: false,
        includeCalls: true,
        callsDir: '/calls',
        contactsDir: '/contacts',
        dealsDir: '/deals'
      },
      () => {}
    )

    expect(listCalls).not.toHaveBeenCalled()
    expect(extractMemoriesFromCall).not.toHaveBeenCalled()
  })

  it('a call with no salesBrainExcluded field behaves exactly as before (not excluded)', async () => {
    listCalls.mockResolvedValue([callSummary('call-a')])
    getCall.mockResolvedValue(fullCall('call-a'))

    await runBackfill(
      FAKE_DB,
      {
        includeContacts: false,
        includeDeals: false,
        includeCalls: true,
        callsDir: '/calls',
        contactsDir: '/contacts',
        dealsDir: '/deals'
      },
      () => {}
    )

    expect(extractMemoriesFromCall).toHaveBeenCalledTimes(1)
  })
})
