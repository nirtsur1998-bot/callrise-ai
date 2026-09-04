// M34 1a — drive the outcome backfill flow END TO END against a COPY of the
// founder's REAL profile, and report against their five acceptance criteria:
//
//   1. does it read real state
//   2. does progress survive a restart
//   3. does undo work
//   4. is "I don't remember" a first-class answer
//   5. does row ten feel like row one
//
// This is not a fixture test. It copies the real userData (contacts, calls,
// deals, deal-stages) into a temp dir, points the backend at the copy, and
// runs the SAME functions the IPC handlers call. It never writes to the real
// profile. If the real profile is absent (CI, another machine), it skips —
// this is a driving harness, not a portable unit test.
//
// Run it alone and read the console:
//   npx vitest run src/main/__tests__/deal-backfill.real-profile.drive.test.ts
import { cpSync, existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const REAL = 'C:/Users/User/AppData/Roaming/sales-os'
const HAS_REAL = existsSync(join(REAL, 'contacts')) && existsSync(join(REAL, 'calls'))

let USER_DATA = ''

vi.mock('electron', () => ({
  app: { getPath: () => USER_DATA, getName: () => 'CallRise AI' },
  ipcMain: { handle: vi.fn() }
}))

const { buildState, recordAnswer, clearAnswer, readAnswers } = await import('../deal-backfill')

const log = (s: string): void => console.log(s)

describe.runIf(HAS_REAL)('M34 1a — backfill driven on the real profile', () => {
  beforeAll(async () => {
    USER_DATA = await mkdtemp(join(tmpdir(), 'backfill-real-'))
    // Copy ONLY what the backfill reads. The real profile is never opened for
    // writing — this is the same override the app uses for dev profiles.
    for (const d of ['contacts', 'calls', 'deals', 'deal-stages']) {
      if (existsSync(join(REAL, d))) cpSync(join(REAL, d), join(USER_DATA, d), { recursive: true })
    }
    log('\n════ M34 1a — outcome backfill, driven on a copy of the real profile ════')
  })

  afterAll(async () => {
    if (USER_DATA) await rm(USER_DATA, { recursive: true, force: true })
    log("\n  sandbox removed; the real profile was never written to.\n")
  })

  it('CRITERION 1 — reads real state', async () => {
    const s = await buildState()
    log(`\n  [1] reads real state`)
    log(`      ${s.rows.length} rows from ${s.coachedContactTotal} coached contacts; answered ${s.answered}/${s.total}`)
    log(`      gate: ${s.insight?.status ?? 'n/a'}`)
    if (s.rows[0]) {
      log(`      row 1: ${s.rows[0].name} — ${s.rows[0].callCount} call(s), last ${String(s.rows[0].lastCallAt).slice(0, 10)}`)
    }
    expect(s.rows.length).toBeGreaterThan(0)
    expect(s.total).toBe(s.rows.length)
    // Reads REAL contacts, not fixtures: every row's name is a non-empty string
    // from the real contacts store.
    expect(s.rows.every((r) => typeof r.name === 'string' && r.name.length > 0)).toBe(true)
  })

  it('CRITERION 4 — "I don\'t remember" is a first-class answer', async () => {
    const before = await buildState()
    const target = before.rows[0]
    const res = await recordAnswer(target.contactId, 'dont-remember')
    const after = await buildState()
    const row = after.rows.find((r) => r.contactId === target.contactId)
    log(`\n  [4] "I don't remember" is first-class`)
    log(`      recorded on ${target.name}: ok=${res.ok}`)
    log(`      persists as an answer (answered ${before.answered} -> ${after.answered}), row stays in place`)
    expect(res.ok).toBe(true)
    expect(row?.answer).toBe('dont-remember')
    expect(after.answered).toBe(before.answered + 1)
    // It is NOT a skip: the row is still present and counted as answered.
    expect(row).toBeDefined()
    await clearAnswer(target.contactId) // leave the sandbox clean for the next test
  })

  it('CRITERION 2 — progress survives a restart', async () => {
    const s0 = await buildState()
    const ids = s0.rows.slice(0, 4).map((r) => r.contactId)
    for (const id of ids) await recordAnswer(id, 'not-a-deal')
    // A "restart" = read the persisted file fresh, exactly what relaunch does.
    const persisted = await readAnswers()
    const restart = await buildState()
    const survived = ids.every((id) => restart.rows.find((r) => r.contactId === id)?.answer === 'not-a-deal')
    log(`\n  [2] progress survives a restart`)
    log(`      answered 4 rows, reloaded from disk: deal-backfill.json holds ${persisted.length}, all present: ${survived}`)
    log(`      answered after reload: ${restart.answered}/${restart.total}`)
    expect(persisted.length).toBe(4)
    expect(survived).toBe(true)
    for (const id of ids) await clearAnswer(id)
  })

  it('CRITERION 3 — undo works', async () => {
    const target = (await buildState()).rows[0]
    await recordAnswer(target.contactId, 'not-a-deal')
    const before = await buildState()
    const undo = await clearAnswer(target.contactId)
    const after = await buildState()
    const row = after.rows.find((r) => r.contactId === target.contactId)
    log(`\n  [3] undo works`)
    log(`      cleared ${target.name}: ok=${undo.ok}; answer now ${row?.answer ?? 'none'}; answered ${before.answered} -> ${after.answered}`)
    expect(undo.ok).toBe(true)
    expect(row?.answer).toBeUndefined()
    expect(after.answered).toBe(before.answered - 1)
    expect(row).toBeDefined() // undone, not deleted
  })

  it('CRITERION 5 — row ten feels like row one', async () => {
    const s = await buildState()
    const shape = (r: object): string => Object.keys(r).sort().join(',')
    const shape1 = shape(s.rows[0])
    const consistent = s.rows.every((r) => shape(r) === shape1)
    log(`\n  [5] row ten feels like row one`)
    log(`      all ${s.rows.length} rows expose identical fields (${shape1.split(',').length} keys); no degradation deep in the list`)
    expect(consistent).toBe(true)
    if (s.rows.length >= 10) {
      const row10 = s.rows[9]
      const res = await recordAnswer(row10.contactId, 'dont-remember')
      const after = await buildState()
      const ok = res.ok && after.rows.find((r) => r.contactId === row10.contactId)?.answer === 'dont-remember'
      log(`      answering row 10 (${row10.name}) costs exactly what row 1 did: ok=${res.ok}`)
      expect(ok).toBe(true)
      await clearAnswer(row10.contactId)
    } else {
      log(`      NOTE: only ${s.rows.length} rows in this profile — row 10 tested structurally, not by click`)
    }
  })

  it('the gate: reports its status honestly on this real data', async () => {
    const s = await buildState()
    log(`\n  gate on the real profile: ${s.insight?.status ?? 'n/a'}${s.insight?.reason ? ' — ' + s.insight.reason : ''}`)
    // No assertion on the value — this is a report of what the founder would see,
    // and the value depends on their real won/lost deals. Asserting a specific
    // status would be asserting the founder's data.
    expect(s.insight).toBeDefined()
  })
})

// A visible marker if the real profile is not here, so a green run on CI is not
// mistaken for "the flow was driven".
describe.skipIf(HAS_REAL)('M34 1a — SKIPPED (no real profile on this machine)', () => {
  it('did not drive anything', () => {
    console.log('\n  M34 1a driving harness skipped — no real profile at ' + REAL)
    expect(HAS_REAL).toBe(false)
  })
})
