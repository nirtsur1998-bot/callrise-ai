// BUG-184 — a backfill-created deal must survive the loss of its answer record.
//
// Deals ride the cloud backup; deal-backfill.json does not. On 2026-09-01 a
// Lost deal came back from somewhere with no record beside it and sat on the
// founder's board: excluded from the backfill (the contact "has a deal"),
// unreachable by ✕, and the only data point on the lost side. The fix makes
// the deal carry its own provenance (`origin: 'backfill'`) and makes the
// backfill rebuild the record from the deal when the file has none.
import { mkdtemp, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let USER_DATA = ''

vi.mock('electron', () => ({
  app: { getPath: () => USER_DATA, getName: () => 'CallRise AI' },
  ipcMain: { handle: vi.fn() }
}))

const { saveCall, listCalls, setCallCoaching, setCallContact, setCallDeal } =
  await import('../calls-fs')
const { createContact } = await import('../contacts-fs')
const { listDeals, createDeal, importDeal, getDeal } = await import('../deals-fs')
const { recordAnswer, clearAnswer, buildState, readAnswers } = await import('../deal-backfill')
const { setDealStages } = await import('../deal-stages')

const STAGES = [
  { id: 'st-open', label: 'Working', kind: 'open' as const },
  { id: 'st-won', label: 'Won', kind: 'won' as const },
  { id: 'st-lost', label: 'Lost', kind: 'lost' as const },
  { id: 'st-quiet', label: 'Went quiet', kind: 'went-quiet' as const }
]

const callsDir = (): string => join(USER_DATA, 'calls')
const dealsDir = (): string => join(USER_DATA, 'deals')
const answersFile = (): string => join(USER_DATA, 'deal-backfill.json')

async function seedContactWithCoachedCalls(name: string, n: number): Promise<string> {
  const contact = await createContact(join(USER_DATA, 'contacts'), { name } as never)
  const contactId = (contact as { id: string }).id
  for (let i = 0; i < n; i++) {
    const s = await saveCall(callsDir(), {
      startedAt: new Date(Date.now() - i * 86_400_000).toISOString(),
      durationMs: 60_000,
      segments: [{ speaker: 0, text: 'hello', startMs: 0, endMs: 500 }]
    } as never)
    const linked = await setCallContact(callsDir(), (s as { id: string }).id, contactId)
    if (linked?.contactId !== contactId) throw new Error('fixture failed: contact link not saved')
    const coached = await setCallCoaching(callsDir(), (s as { id: string }).id, {
      overallScore: 70,
      dealContext: {},
      strength: { text: 'clear framing' },
      dimensions: ['discovery', 'engagement', 'objection', 'value', 'nextStep', 'control'].map(
        (key) => ({ key, score: 4, comment: 'ok' })
      ),
      improvements: [],
      nextAction: 'follow up',
      metrics: {},
      model: 'test',
      createdAt: new Date().toISOString()
    } as never)
    if (!coached?.coaching) throw new Error('fixture failed: setCallCoaching saved nothing')
  }
  return contactId
}

/** The failure being fixed: the record is gone, the deal is not. */
async function loseTheAnswersFile(): Promise<void> {
  await unlink(answersFile())
  expect(await readAnswers(), 'fixture failed: the answers file is still there').toEqual([])
}

describe('BUG-184 — the answers file is not load-bearing', () => {
  beforeEach(async () => {
    USER_DATA = await mkdtemp(join(tmpdir(), 'callrise-backfill-orphan-'))
    expect(setDealStages(STAGES).ok, 'stage seed failed').toBe(true)
  })
  afterEach(async () => {
    await rm(USER_DATA, { recursive: true, force: true })
  })

  it('the deal an answer creates carries origin: backfill, on disk and through the sanitizer', async () => {
    const contactId = await seedContactWithCoachedCalls('Ada', 1)
    await recordAnswer(contactId, 'lost')
    const [deal] = await listDeals(dealsDir())
    expect(deal.origin).toBe('backfill')
    // The backup restore path re-runs the sanitizer on the payload: the field
    // must come out the other side, or a restore is exactly the loss again.
    const restored = await importDeal(join(USER_DATA, 'deals-restored'), { ...deal })
    expect(restored?.origin, 'origin did not survive importDeal').toBe('backfill')
    // And a hand-made deal never gets it, whatever the caller passes.
    const hand = await createDeal(dealsDir(), {
      title: 'Hand-made',
      contactId,
      stageId: 'st-open',
      origin: 'anything-else'
    })
    expect(hand?.origin).toBeUndefined()
  })

  it('with the file gone, the row is rebuilt from the deal — and the ✕ still removes the deal', async () => {
    const contactId = await seedContactWithCoachedCalls('Ada', 2)
    await recordAnswer(contactId, 'lost')
    await loseTheAnswersFile()

    const state = await buildState()
    const row = state.rows.find((r) => r.contactId === contactId)
    expect(row, 'the contact vanished from the backfill — the orphan shape').toBeDefined()
    expect(row?.answer).toBe('lost')
    expect(row?.reconstructed).toBe(true)
    expect(row?.linkedCallCount).toBe(2)
    expect(state.answered).toBe(1)

    const undo = await clearAnswer(contactId)
    expect(undo.ok).toBe(true)
    expect(await listDeals(dealsDir()), 'the orphan deal survived the undo').toHaveLength(0)
    const calls = await listCalls(callsDir())
    expect(calls.map((c) => c.dealId)).toEqual([undefined, undefined])
    expect((await buildState()).rows.find((r) => r.contactId === contactId)?.answer).toBeUndefined()
  })

  it('a rebuilt answer counts for the gate exactly like a recorded one', async () => {
    const contactId = await seedContactWithCoachedCalls('Ada', 1)
    await recordAnswer(contactId, 'won')
    const before = await buildState()
    await loseTheAnswersFile()
    const after = await buildState()
    if (before.insight.status !== 'insufficient' || after.insight.status !== 'insufficient') {
      throw new Error('unreachable at N=1')
    }
    expect(after.insight.usable).toEqual(before.insight.usable)
    expect(after.insight.counts.won).toBe(before.insight.counts.won)
  })

  it('correcting a rebuilt answer replaces the deal exactly once', async () => {
    const contactId = await seedContactWithCoachedCalls('Ada', 2)
    await recordAnswer(contactId, 'won')
    await loseTheAnswersFile()
    const res = await recordAnswer(contactId, 'lost')
    expect(res.ok).toBe(true)
    const deals = await listDeals(dealsDir())
    expect(deals, 'the correction left the orphan behind — one contact in both arms').toHaveLength(1)
    expect(deals[0].stageId).toBe('st-lost')
    expect(new Set((await listCalls(callsDir())).map((c) => c.dealId))).toEqual(new Set([deals[0].id]))
  })

  it("a legacy backfill deal — the note, no origin field — is recognised too (the founder's orphan shape)", async () => {
    const contactId = await seedContactWithCoachedCalls('Ada', 1)
    const deal = await createDeal(dealsDir(), {
      title: 'Ada',
      contactId,
      stageId: 'st-lost',
      notes: 'Recorded from past calls.'
    })
    expect(deal?.origin, 'fixture: a legacy deal must have no origin').toBeUndefined()
    const row = (await buildState()).rows.find((r) => r.contactId === contactId)
    expect(row?.answer).toBe('lost')
    expect(row?.reconstructed).toBe(true)
    expect(row?.linkedCallCount, 'nothing points at a legacy orphan, and the row must say 0, not lie').toBe(0)
  })

  it('a hand-made deal with no provenance is NOT mistaken for an answer', async () => {
    const contactId = await seedContactWithCoachedCalls('Ada', 1)
    await createDeal(dealsDir(), { title: 'Ada', contactId, stageId: 'st-lost', notes: 'They passed.' })
    const state = await buildState()
    expect(state.rows.find((r) => r.contactId === contactId)).toBeUndefined()
    expect(state.answered).toBe(0)
  })

  it('a backfill deal moved by hand into an open stage is a deal now, not an answer', async () => {
    const contactId = await seedContactWithCoachedCalls('Ada', 1)
    await recordAnswer(contactId, 'won')
    const [deal] = await listDeals(dealsDir())
    const { updateDeal } = await import('../deals-fs')
    await updateDeal(dealsDir(), deal.id, { stageId: 'st-open' })
    expect((await getDeal(dealsDir(), deal.id))?.stageId).toBe('st-open')
    await loseTheAnswersFile()
    const state = await buildState()
    expect(state.rows.find((r) => r.contactId === contactId)).toBeUndefined()
    // ...and the calls the answer linked stay linked: nothing was undone by inference.
    expect((await listCalls(callsDir()))[0].dealId).toBe(deal.id)
    void setCallDeal
  })

  it('the file, when present, wins over the deal — a recorded answer is never overwritten by reconstruction', async () => {
    const contactId = await seedContactWithCoachedCalls('Ada', 1)
    await recordAnswer(contactId, 'won')
    const state = await buildState()
    const row = state.rows.find((r) => r.contactId === contactId)
    expect(row?.reconstructed).toBeUndefined()
    expect((await readAnswers())[0].reconstructed).toBeUndefined()
  })

  it("the residual gap: a NEWER pulled row with no origin key — an older build's push — keeps the local origin", async () => {
    // Measured on the founder's real store 2026-09-04: two builds shared one
    // account, the older one re-stamped and pushed the deal without the field,
    // and the pull stripped the marker here. Same three-way rule as
    // outcomeReason: absent key preserves, present key sets.
    const contactId = await seedContactWithCoachedCalls('Ada', 1)
    await recordAnswer(contactId, 'lost')
    const [deal] = await listDeals(dealsDir())
    expect(deal.origin, 'fixture: the answer did not mark the deal').toBe('backfill')

    const { origin: _dropped, ...olderBuildRow } = deal
    const newer = { ...olderBuildRow, updatedAt: new Date(Date.parse(deal.updatedAt) + 60_000).toISOString() }
    expect(Object.prototype.hasOwnProperty.call(newer, 'origin'), 'fixture: key must be ABSENT').toBe(false)
    const imported = await importDeal(dealsDir(), newer, { onlyIfNewer: true })
    expect(imported, 'fixture: the newer row was not applied, so nothing was tested').not.toBeNull()

    const after = await getDeal(dealsDir(), deal.id)
    expect(after?.updatedAt, 'the newer row did not win — the pull path was not exercised').toBe(newer.updatedAt)
    expect(after?.origin, 'the pull stripped the provenance marker').toBe('backfill')
    // ...and it is still recognisable to the backfill without the answers file.
    await loseTheAnswersFile()
    expect((await buildState()).rows.find((r) => r.contactId === contactId)?.reconstructed).toBe(true)
  })

  it('a hand-made deal never GAINS an origin from preservation — absent on both sides stays absent', async () => {
    const contactId = await seedContactWithCoachedCalls('Ada', 1)
    const hand = await createDeal(dealsDir(), { title: 'Ada', contactId, stageId: 'st-open' })
    const newer = { ...hand, updatedAt: new Date(Date.parse(hand!.updatedAt) + 60_000).toISOString() }
    await importDeal(dealsDir(), newer, { onlyIfNewer: true })
    expect((await getDeal(dealsDir(), hand!.id))?.origin).toBeUndefined()
  })
})
