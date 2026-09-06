// M27 re-audit — the Memory Center's IPC doors.
//
// Continuing the species-21 sweep that found the retroactive-exclusion gap:
// of the eleven IPC handlers containing real gating logic, seven live in
// memory-center-ipc.ts and NONE of them was entered by any test. Their
// primitives (listMemories, deleteMemory, forgetEverything, ...) are all
// covered by memories-store.test.ts; what had no coverage is the gate each
// handler puts in front of its primitive.
//
// THE INVARIANT THIS FILE EXISTS FOR: with Sales Brain switched off, no
// handler serves memory data and no handler mutates it. That is a promise the
// settings toggle makes — "off" has to mean off, not "hidden in the UI" — and
// it was enforced in seven places by seven independent `isSalesBrainEnabled()`
// checks that nothing verified. Delete any one of them and the suite stayed
// green while that door quietly started answering.
//
// Written as a table-driven sweep rather than seven bespoke tests, precisely
// because the risk is one door drifting out of line with the others.
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
vi.mock('../../app-settings', () => ({ isSalesBrainEnabled: () => salesBrainOn.value }))
vi.mock('../../calls-fs', () => ({
  setCallSalesBrainExcluded: async () => true,
  getCall: async () => null
}))
vi.mock('../embeddings', () => ({ embedText: async () => new Float32Array(384) }))

let db: Database.Database | null = null
const initDetail = { value: 'migration failed: {"ok":false}' }
vi.mock('../memory-runtime', () => ({
  getMemoryDb: () => db,
  // AUDIT FIX (2026-08-24) — salesBrain:status reports WHY the brain is
  // unreachable, so the handler needs the last init result.
  getLastInitResult: () => ({ ok: false, detail: initDetail.value })
}))

const { registerMemoryCenter } = await import('../memory-center-ipc')
const { openMemoryDb, memoryDbPath, migrate } = await import('../db')
const { listMemories } = await import('../memories-store')

registerMemoryCenter() // once — the module refuses to register twice

const CALL = 'call-1'

function seed(id: string, statement: string, callId = CALL): void {
  db!.prepare(
    `INSERT INTO memories (id, scope, category, statement, evidence, confidence, importance,
        status, source, created_at, last_confirmed_at)
     VALUES (?, 'self', 'style', ?, ?, 0.9, 3, 'active', 'call', 't', 't')`
  ).run(id, statement, JSON.stringify([{ type: 'transcript', callId, quote: statement, at: 't' }]))
}

const call = (channel: string, ...args: unknown[]): Promise<unknown> =>
  handlers.get(channel)!({}, ...args)

const countMemories = (): number => listMemories(db!, {}).length

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'callrise-mc-gates-'))
  db = openMemoryDb(memoryDbPath(dir))
  const res = await migrate(db, memoryDbPath(dir))
  if (!res.ok) throw new Error(`migrate failed: ${JSON.stringify(res)}`)
  salesBrainOn.value = true
})

afterEach(() => {
  db?.close()
  db = null
  rmSync(dir, { recursive: true, force: true })
})

// M36 Stage 3 item 5, step 5 — the backfill's record, gated like every other door.
describe('salesBrain:temporal:record', () => {
  it('OFF → null, even when a record exists', async () => {
    const { runTemporalBackfill } = await import('../temporal-backfill')
    runTemporalBackfill(db!, new Map())
    salesBrainOn.value = false
    expect(await call('salesBrain:temporal:record')).toBeNull()
  })
  it('ON with no run yet → null; after a run → the counts; after a skip → the skip', async () => {
    expect(await call('salesBrain:temporal:record')).toBeNull()
    const { recordTemporalBackfillSkipped, runTemporalBackfill } = await import('../temporal-backfill')
    recordTemporalBackfillSkipped(db!, 'connection replaced during startup')
    expect(await call('salesBrain:temporal:record')).toMatchObject({ status: 'skipped', reason: 'connection replaced during startup' })
    seed('m1', 'something learned')
    runTemporalBackfill(db!, new Map())
    expect(await call('salesBrain:temporal:record')).toMatchObject({ status: 'ran', total: 1, validFrom: { call: 0, stated: 0, approx: 1 } })
  })
})

describe('with Sales Brain OFF, no door serves memory data', () => {
  // Read paths. "Off" must mean the data is not handed out, not merely that
  // the UI stops asking for it — a renderer bug, a devtools call or a future
  // caller must all get nothing.
  const readers: Array<[string, unknown[]]> = [
    ['salesBrain:memories:list', [{}]],
    ['salesBrain:memories:changelog', ['self']],
    ['salesBrain:memories:byCall', [CALL]]
  ]

  it.each(readers)('%s returns empty', async (channel, args) => {
    seed('m1', 'something learned')
    expect(countMemories()).toBe(1) // the data IS there; the gate is what hides it

    salesBrainOn.value = false
    expect(await call(channel, ...(args as unknown[]))).toEqual([])
  })

  it('and each of them DOES serve while it is on — the control', async () => {
    seed('m1', 'something learned')
    for (const [channel, args] of readers) {
      const out = (await call(channel, ...(args as unknown[]))) as unknown[]
      expect(out.length).toBeGreaterThan(0)
    }
  })
})

describe('with Sales Brain OFF, no door mutates memory data', () => {
  const mutators: Array<[string, unknown[]]> = [
    ['salesBrain:memories:update', ['m1', 'rewritten']],
    ['salesBrain:memories:setPinned', ['m1', true]],
    ['salesBrain:memories:delete', ['m1']],
    ['salesBrain:memories:forgetEverything', []]
  ]

  it.each(mutators)('%s refuses', async (channel, args) => {
    seed('m1', 'must survive')
    salesBrainOn.value = false

    expect(await call(channel, ...(args as unknown[]))).toEqual({ ok: false })
    expect(countMemories()).toBe(1)
  })
})

describe('the destructive doors do what they say — while enabled', () => {
  it('delete removes exactly the one named', async () => {
    seed('m1', 'goes')
    seed('m2', 'stays')

    expect(await call('salesBrain:memories:delete', 'm1')).toEqual({ ok: true })

    const left = listMemories(db!, {})
    expect(left).toHaveLength(1)
    expect(left[0].id).toBe('m2')
  })

  it('forgetEverything really does empty it', async () => {
    seed('m1', 'a')
    seed('m2', 'b')
    seed('m3', 'c')

    expect(await call('salesBrain:memories:forgetEverything')).toEqual({ ok: true })
    expect(countMemories()).toBe(0)
  })

  it('forgetEverything is not a no-op that merely reports success', async () => {
    // The control for the test above: a handler that returned { ok: true }
    // and did nothing would pass a weaker assertion. Seeding first and
    // counting after is what makes the claim real.
    seed('m1', 'a')
    expect(countMemories()).toBe(1)
    await call('salesBrain:memories:forgetEverything')
    expect(countMemories()).toBe(0)
  })
})

describe('every door validates its arguments', () => {
  // These come over IPC from a renderer. A renderer bug that sends undefined
  // must not reach the database layer, where an unexpected type is a
  // different and worse kind of failure.
  it.each([
    ['salesBrain:memories:update', [42, 'text']],
    ['salesBrain:memories:setPinned', [null, true]],
    ['salesBrain:memories:delete', [undefined]]
  ])('%s refuses a non-string id', async (channel, args) => {
    seed('m1', 'untouched')
    expect(await call(channel, ...(args as unknown[]))).toEqual({ ok: false })
    expect(countMemories()).toBe(1)
  })

  it('byCall refuses a non-string call id', async () => {
    seed('m1', 'untouched')
    expect(await call('salesBrain:memories:byCall', 99)).toEqual([])
  })
})

describe('with no database open, every door fails safe', () => {
  // getMemoryDb() returns null when init failed or has not finished. Reads
  // must return empty and writes must refuse — never throw into the IPC
  // handler, which reaches the renderer as a rejected promise and shows the
  // user nothing at all (the 1.2.1 "button does nothing" failure).
  it.each([
    ['salesBrain:memories:list', [{}], []],
    ['salesBrain:memories:changelog', ['self'], []],
    ['salesBrain:memories:byCall', [CALL], []],
    ['salesBrain:memories:update', ['m1', 'x'], { ok: false }],
    ['salesBrain:memories:setPinned', ['m1', true], { ok: false }],
    ['salesBrain:memories:delete', ['m1'], { ok: false }],
    ['salesBrain:memories:forgetEverything', [], { ok: false }]
  ])('%s returns a safe value rather than throwing', async (channel, args, expected) => {
    const realDb = db
    db = null
    try {
      await expect(call(channel, ...(args as unknown[]))).resolves.toEqual(expected)
    } finally {
      db = realDb
    }
  })
})

// AUDIT FIX (2026-08-24) — OFF vs UNAVAILABLE vs EMPTY vs READY.
//
// 'salesBrain:memories:list' returns [] and never rejects for THREE unrelated
// reasons — Sales Brain off (the shipping default, EMPTY_SALES_BRAIN is
// { enabled: false }), the DB unavailable because migration failed and left
// db null while the flag stayed on, and a genuinely empty brain. Rise read
// `rows.length === 0` as proof of the third and told new users "your Sales
// Brain is empty — import your call history". Importing cannot help in the
// other two: initSalesBrain() returns before creating the DB file when the
// flag is off, and every extraction hook is master-gated. So the copy named a
// wrong cause and prescribed futile work, in the state most new installs are
// actually in.
//
// Each case below is a state the OLD boolean could not tell apart. If the
// handler ever collapses them again, the three assertions that matter here
// all fail together.
describe('salesBrain:status — the three ways an empty list can happen', () => {
  it('OFF: reports off, not empty — the shipping default', async () => {
    salesBrainOn.value = false
    expect(await call('salesBrain:status')).toEqual({ state: 'off' })
  })

  it('UNAVAILABLE: on, but the DB never opened — and it says why', async () => {
    salesBrainOn.value = true
    const realDb = db
    db = null
    const status = (await call('salesBrain:status')) as { state: string; detail?: string }
    db = realDb
    expect(status.state).toBe('unavailable')
    expect(status.detail).toContain('migration failed')
  })

  it('EMPTY: on, DB open, nothing learned yet', async () => {
    salesBrainOn.value = true
    expect(await call('salesBrain:status')).toEqual({ state: 'empty' })
  })

  it('READY: on, DB open, memories present — with the count', async () => {
    salesBrainOn.value = true
    seed('m-status-1', 'the rep opens with a recap')
    expect(await call('salesBrain:status')).toEqual({ state: 'ready', count: 1 })
  })

  it('the four states are mutually distinguishable', async () => {
    // The actual defect was three states collapsing to one value. Asserting
    // the SET is distinct is what a boolean could never satisfy.
    salesBrainOn.value = false
    const off = (await call('salesBrain:status')) as { state: string }
    salesBrainOn.value = true
    const realDb = db
    db = null
    const unavailable = (await call('salesBrain:status')) as { state: string }
    db = realDb
    const empty = (await call('salesBrain:status')) as { state: string }
    seed('m-status-2', 'discovery runs long on enterprise calls')
    const ready = (await call('salesBrain:status')) as { state: string }

    const states = [off.state, unavailable.state, empty.state, ready.state]
    expect(new Set(states).size, `states collapsed: ${states.join(', ')}`).toBe(4)
  })
})
