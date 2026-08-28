// M27 re-audit — the RETROACTIVE half of "don't learn from this call".
//
// Found by asking species 21's question mechanically: which of production's
// doors does no test ever enter? Of 167 IPC channels, 12 are named in any
// test. Most of those are thin pass-throughs and their absence is fine — but
// eleven handlers contain real gating logic, and this one contains a privacy
// guarantee assembled INSIDE the handler rather than delegated:
//
//     if (excluded === true && isSalesBrainEnabled()) {
//       for (const memory of listMemoriesByCallId(db, callId)) deleteMemory(db, memory.id)
//     }
//
// Marking a call excluded doesn't just stop future learning — it FORGETS what
// was already learned from it. That is the difference between "we won't use
// this going forward" and "it's gone", and it is the one a rep is relying on
// when they tick the box after a sensitive call.
//
// PROSPECTIVE exclusion was well covered: backfill.test.ts asserts an
// excluded call is skipped, memory-hooks has its own tests. RETROACTIVE
// exclusion had none — the primitives (setCallSalesBrainExcluded,
// listMemoriesByCallId, deleteMemory) are each tested individually, and the
// composition that turns them into the guarantee lived only in a door nobody
// opened. Delete those six lines and every test in the suite still passes.
//
// This enters through the real ipcMain handler, for the same reason the
// consent tests do: the composition is the thing under test, and calling the
// primitives directly would re-test what is already covered while proving
// nothing about the guarantee.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'

let dir: string
const handlers = new Map<string, (e: unknown, ...args: unknown[]) => Promise<unknown>>()

vi.mock('electron', () => ({
  app: { getPath: () => dir },
  ipcMain: {
    handle: (channel: string, fn: (e: unknown, ...a: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, fn)
    },
    on: vi.fn()
  }
}))

const salesBrainOn = { value: true }
vi.mock('../../app-settings', () => ({
  isSalesBrainEnabled: () => salesBrainOn.value
}))

/** The call file the handler updates. Stubbed to succeed/fail on demand so
 *  the test can prove the purge is gated on the write actually landing. */
const setExcludedResult = { value: true }
const getCallResult: { value: unknown } = { value: null }
vi.mock('../../calls-fs', () => ({
  setCallSalesBrainExcluded: async () => setExcludedResult.value,
  getCall: async () => getCallResult.value
}))

vi.mock('../embeddings', () => ({ embedText: async () => new Float32Array(384) }))

let db: Database.Database
vi.mock('../memory-runtime', () => ({ getMemoryDb: () => db }))

const { registerMemoryCenter } = await import('../memory-center-ipc')
const { openMemoryDb, memoryDbPath, migrate } = await import('../db')
const { listMemoriesByCallId } = await import('../memories-store')

registerMemoryCenter() // once — the module refuses to register twice

const CALL = 'call-sensitive'
const OTHER_CALL = 'call-unrelated'

/** Inserts a memory whose evidence names a call, which is how
 *  listMemoriesByCallId finds it. Real rows in a real migrated database —
 *  a hand-built fixture would not exercise the same query. */
function seedMemory(id: string, callId: string, statement: string): void {
  db.prepare(
    `INSERT INTO memories (id, scope, category, statement, evidence, confidence, importance,
        status, source, created_at, last_confirmed_at)
     VALUES (?, 'self', 'style', ?, ?, 0.9, 3, 'active', 'call', 't', 't')`
    // `type: 'transcript'` is REQUIRED, not decoration: listMemoriesByCallId
    // filters on `e.type === 'transcript' && e.callId === callId`. The first
    // version of this fixture omitted it and all six tests failed at the
    // seed — a fixture that does not match the real shape tests nothing,
    // which is the same trap as the invalid MemoryCategory earlier in M27.
  ).run(
    id,
    statement,
    JSON.stringify([{ type: 'transcript', callId, quote: statement, at: 't' }])
  )
}

/**
 * AUDIT FIX (2026-08-24) — a memory reinforced by MORE THAN ONE source.
 *
 * seedMemory gives every fixture exactly one callId, and the "leaves memories
 * from other calls alone" control seeds two independent single-source rows —
 * so the multi-source class was entirely untested, and it is the only class
 * where the bug shows. consolidateNewCandidate reinforces an existing memory
 * by APPENDING the new candidate's evidence, carrying the new source's
 * callId, onto a row an unrelated call created.
 */
function seedMultiSourceMemory(id: string, callIds: string[], statement: string): void {
  db.prepare(
    `INSERT INTO memories (id, scope, category, statement, evidence, confidence, importance,
        status, source, created_at, last_confirmed_at)
     VALUES (?, 'self', 'style', ?, ?, 0.9, 3, 'active', 'call', 't', 't')`
  ).run(
    id,
    statement,
    JSON.stringify(
      callIds.map((callId) => ({ type: 'transcript', callId, quote: statement, at: 't' }))
    )
  )
}

function evidenceCallIds(id: string): string[] {
  const row = db.prepare('SELECT evidence FROM memories WHERE id = ?').get(id) as
    | { evidence: string }
    | undefined
  if (!row) return []
  return (JSON.parse(row.evidence) as { callId?: string }[]).map((e) => e.callId ?? '')
}

async function rendererSetsExcluded(callId: unknown, excluded: unknown): Promise<unknown> {
  return await handlers.get('salesBrain:calls:setExcluded')!({}, callId, excluded)
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'callrise-exclusion-'))
  db = openMemoryDb(memoryDbPath(dir))
  const res = await migrate(db, memoryDbPath(dir))
  if (!res.ok) throw new Error(`migrate failed: ${JSON.stringify(res)}`)
  // NOT cleared, and registerMemoryCenter() is called ONCE at module scope
  // below: memory-center-ipc.ts guards itself with a module-level `registered`
  // flag, so a second call is a no-op. Clearing the map per test and
  // re-registering left it empty for every test after the first.
  salesBrainOn.value = true
  setExcludedResult.value = true
  getCallResult.value = null
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('excluding a call forgets what was learned from it', () => {
  it('deletes every memory that came from that call', async () => {
    seedMemory('m1', CALL, 'they mentioned a redundancy round')
    seedMemory('m2', CALL, 'budget is frozen until Q3')
    expect(listMemoriesByCallId(db, CALL)).toHaveLength(2)

    await rendererSetsExcluded(CALL, true)

    // THE GUARANTEE. Reverting the six-line purge in the handler leaves this
    // as the only failing assertion in the suite.
    expect(listMemoriesByCallId(db, CALL)).toHaveLength(0)
  })

  it('leaves memories from other calls alone', async () => {
    seedMemory('m1', CALL, 'from the excluded call')
    seedMemory('m2', OTHER_CALL, 'from a different call entirely')

    await rendererSetsExcluded(CALL, true)

    // The control. Without it, a handler that wiped the whole table would
    // pass the test above — "forgets everything" and "forgets this call" are
    // very different promises.
    expect(listMemoriesByCallId(db, CALL)).toHaveLength(0)
    expect(listMemoriesByCallId(db, OTHER_CALL)).toHaveLength(1)
  })

  it('does NOT forget when the call is being UN-excluded', async () => {
    seedMemory('m1', CALL, 'still wanted')
    await rendererSetsExcluded(CALL, false)
    // Un-ticking the box must not destroy anything. The purge is gated on
    // `excluded === true`, and a gate that fired both ways would delete
    // memories at the moment the rep said they wanted them kept.
    expect(listMemoriesByCallId(db, CALL)).toHaveLength(1)
  })

  it('does not purge when the call file could not be updated', async () => {
    // If the flag did not persist, the call is NOT excluded — forgetting its
    // memories anyway would destroy data on the strength of a write that
    // failed.
    seedMemory('m1', CALL, 'must survive a failed write')
    setExcludedResult.value = false

    const result = await rendererSetsExcluded(CALL, true)

    expect(result).toEqual({ ok: false })
    expect(listMemoriesByCallId(db, CALL)).toHaveLength(1)
  })

  it('rejects a non-string call id without touching anything', async () => {
    seedMemory('m1', CALL, 'untouched')
    expect(await rendererSetsExcluded(42, true)).toEqual({ ok: false })
    expect(await rendererSetsExcluded(null, true)).toEqual({ ok: false })
    expect(listMemoriesByCallId(db, CALL)).toHaveLength(1)
  })

  it('still records the exclusion when Sales Brain is switched off', async () => {
    // With the feature off there is no database to purge, but the rep's
    // choice must still be recorded on the call — otherwise turning Sales
    // Brain on later would start learning from a call they excluded.
    salesBrainOn.value = false
    seedMemory('m1', CALL, 'db untouched while the feature is off')

    expect(await rendererSetsExcluded(CALL, true)).toEqual({ ok: true })
    expect(listMemoriesByCallId(db, CALL)).toHaveLength(1)
  })
})

// AUDIT FIX (2026-08-24) — excluding one source must not destroy what OTHER
// sources taught.
//
// The chain that made it possible: extraction stamps every candidate's
// evidence with the current callId (`assistant:<conversationId>` for chat);
// consolidateNewCandidate reinforces an exact match by appending that entry to
// a DIFFERENT, pre-existing row, and its lookup is scope-wide — 'rep' and
// 'business' are global singleton scopes shared by every call and every Rise
// chat; listMemoriesByCallId then matches on ANY single evidence entry; and
// all four exclusion sites called deleteMemory on the whole row, both tables,
// no soft state, no changelog row surviving.
//
// The UI promises the narrow thing and admits it is irreversible: "Anything it
// already taught the Sales Brain will be forgotten. This cannot be undone."
// IT — this source — not everything that ever agreed with it.
describe('exclusion is evidence-level: other calls keep what they taught', () => {
  it('a memory reinforced by two calls SURVIVES excluding one of them', async () => {
    seedMultiSourceMemory('m-shared', [OTHER_CALL, CALL], "Acme's budget cycle ends in March")

    expect(await rendererSetsExcluded(CALL, true)).toEqual({ ok: true })

    const survivors = listMemoriesByCallId(db, OTHER_CALL)
    expect(
      survivors,
      'excluding one conversation hard-deleted a memory an unrelated call ' +
        'taught — the user was told only that THIS source would be forgotten'
    ).toHaveLength(1)
    expect(survivors[0].statement).toBe("Acme's budget cycle ends in March")
  })

  it("the excluded source's evidence is actually removed, not just left in place", async () => {
    seedMultiSourceMemory('m-shared', [OTHER_CALL, CALL], 'shared fact')
    await rendererSetsExcluded(CALL, true)

    expect(evidenceCallIds('m-shared')).toEqual([OTHER_CALL])
    // And the memory is no longer reachable BY the excluded source, which is
    // the promise "forgotten" actually makes.
    expect(listMemoriesByCallId(db, CALL)).toHaveLength(0)
  })

  it('a single-source memory is still deleted outright — the original behaviour, preserved', async () => {
    // The narrowing must not become "nothing is ever deleted": when the
    // excluded source was the ONLY thing holding a memory up, it goes.
    seedMemory('m-only', CALL, 'learned solely from the excluded call')
    await rendererSetsExcluded(CALL, true)
    expect(listMemoriesByCallId(db, CALL)).toHaveLength(0)
    expect(db.prepare('SELECT id FROM memories WHERE id = ?').get('m-only')).toBeUndefined()
  })

  it('a memory reinforced by three sources loses exactly one', async () => {
    seedMultiSourceMemory('m-three', ['call-a', CALL, 'call-b'], 'thrice-confirmed')
    await rendererSetsExcluded(CALL, true)
    expect(evidenceCallIds('m-three')).toEqual(['call-a', 'call-b'])
  })
})
