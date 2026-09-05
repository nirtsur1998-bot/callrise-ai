// M34 — "Link all N coached calls": a closed deal whose contact has coached
// calls on no deal is offered them, one click links exactly those, and the
// gate counts the deal the moment it happens. Records only.
//
// The second describe drives the same functions against a COPY of the
// founder's real profile (skipped where that profile is absent): it is how the
// "4 won on the board, 0 counted" gap was measured, and how the fix is proven
// to close it — on the copy, never on the real store.
import { cpSync, existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let USER_DATA = ''

vi.mock('electron', () => ({
  app: { getPath: () => USER_DATA, getName: () => 'CallRise AI' },
  ipcMain: { handle: vi.fn() }
}))

const { saveCall, listCalls, setCallCoaching, setCallContact, setCallDeal } = await import('../calls-fs')
const { createContact } = await import('../contacts-fs')
const { createDeal, listDeals } = await import('../deals-fs')
const { linkSuggestions, linkCoachedCalls, linkAllSuggested, buildState } = await import('../deal-backfill')
const { setDealStages } = await import('../deal-stages')

const STAGES = [
  { id: 'st-open', label: 'Working', kind: 'open' as const },
  { id: 'st-won', label: 'Won', kind: 'won' as const },
  { id: 'st-lost', label: 'Lost', kind: 'lost' as const }
]
const callsDir = (): string => join(USER_DATA, 'calls')
const dealsDir = (): string => join(USER_DATA, 'deals')

async function seedContact(name: string): Promise<string> {
  const c = await createContact(join(USER_DATA, 'contacts'), { name } as never)
  return (c as { id: string }).id
}
async function seedCall(contactId: string, coached: boolean, daysAgo = 0): Promise<string> {
  const s = await saveCall(callsDir(), {
    startedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
    durationMs: 60_000,
    segments: [{ speaker: 0, text: 'hello', startMs: 0, endMs: 500 }]
  } as never)
  const id = (s as { id: string }).id
  const linked = await setCallContact(callsDir(), id, contactId)
  if (linked?.contactId !== contactId) throw new Error('fixture: contact link not saved')
  if (coached) {
    const r = await setCallCoaching(callsDir(), id, {
      overallScore: 70, dealContext: {}, strength: { text: 'x' },
      dimensions: ['discovery', 'engagement', 'objection', 'value', 'nextStep', 'control'].map((key) => ({ key, score: 4, comment: 'ok' })),
      improvements: [], nextAction: 'follow up', metrics: {}, model: 'test', createdAt: new Date().toISOString()
    } as never)
    if (!r?.coaching) throw new Error('fixture: coaching not saved')
  }
  return id
}

describe('link suggestions and one-click linking', () => {
  beforeEach(async () => {
    USER_DATA = await mkdtemp(join(tmpdir(), 'callrise-link-'))
    expect(setDealStages(STAGES).ok).toBe(true)
  })
  afterEach(async () => {
    await rm(USER_DATA, { recursive: true, force: true })
  })

  it('the fixture really produces an offer (control)', async () => {
    const c = await seedContact('Emma')
    await seedCall(c, true); await seedCall(c, true); await seedCall(c, false)
    await createDeal(dealsDir(), { title: 'Emma deal', contactId: c, stageId: 'st-won' })
    const s = await linkSuggestions()
    expect(s.deals).toHaveLength(1)
    expect(s.deals[0].coachedCallIds, 'the uncoached call must not be offered').toHaveLength(2)
    expect(s.totalCalls).toBe(2)
    expect(s.deals[0].stageLabel).toBe('Won')
  })

  it('an OPEN deal is never offered — the gate only counts closed ones', async () => {
    const c = await seedContact('Emma')
    await seedCall(c, true)
    await createDeal(dealsDir(), { title: 'Emma deal', contactId: c, stageId: 'st-open' })
    expect((await linkSuggestions()).deals).toHaveLength(0)
  })

  it('a deal that already has a coached call linked is not offered — it already counts', async () => {
    const c = await seedContact('Emma')
    const a = await seedCall(c, true); await seedCall(c, true)
    const d = await createDeal(dealsDir(), { title: 'Emma deal', contactId: c, stageId: 'st-won' })
    await setCallDeal(callsDir(), a, d!.id)
    expect((await linkSuggestions()).deals).toHaveLength(0)
  })

  it('one click links exactly the offered calls, never one that belongs to another deal, and the gate counts it', async () => {
    const c = await seedContact('Emma')
    const mine1 = await seedCall(c, true); const mine2 = await seedCall(c, true); const theirs = await seedCall(c, true)
    const won = await createDeal(dealsDir(), { title: 'Emma won', contactId: c, stageId: 'st-won' })
    const other = await createDeal(dealsDir(), { title: 'Other', contactId: c, stageId: 'st-lost' })
    await setCallDeal(callsDir(), theirs, other!.id)
    const before = await buildState()
    if (before.insight.status !== 'insufficient') throw new Error('unreachable')
    expect(before.insight.usable.won).toBe(0)

    const r = await linkCoachedCalls(won!.id)
    expect(r.ok).toBe(true)
    expect(r.linked).toBe(2)
    const calls = await listCalls(callsDir())
    expect(calls.find((x) => x.id === mine1)?.dealId).toBe(won!.id)
    expect(calls.find((x) => x.id === mine2)?.dealId).toBe(won!.id)
    expect(calls.find((x) => x.id === theirs)?.dealId, 'stole a call from another deal').toBe(other!.id)
    if (r.state.insight.status !== 'insufficient') throw new Error('unreachable')
    expect(r.state.insight.usable.won, 'the deal did not become countable').toBe(1)
    expect(r.suggestions.deals.find((d) => d.dealId === won!.id), 'still offered after linking').toBeUndefined()
  })

  it('an unknown deal id links nothing and says so', async () => {
    const r = await linkCoachedCalls('nope')
    expect(r.ok).toBe(false)
    expect(r.linked).toBe(0)
  })

  it('link all: every offered deal, the whole set, sequentially', async () => {
    const ids: string[] = []
    for (const name of ['Emma', 'Kevin', 'Jack']) {
      const c = await seedContact(name); ids.push(c)
      await seedCall(c, true); await seedCall(c, true)
      await createDeal(dealsDir(), { title: name, contactId: c, stageId: 'st-won' })
    }
    expect((await linkSuggestions()).totalCalls).toBe(6)
    const r = await linkAllSuggested()
    expect(r.linked).toBe(6)
    expect(r.suggestions.deals).toHaveLength(0)
    if (r.state.insight.status !== 'insufficient') throw new Error('unreachable')
    expect(r.state.insight.usable.won).toBe(3)
    expect((await listDeals(dealsDir())).length, 'linking must never create or delete a deal').toBe(3)
  })
})

// ── the founder's real profile, on a COPY ──────────────────────────────────
const REAL = 'C:/Users/User/AppData/Roaming/sales-os'
const HAS_REAL = existsSync(join(REAL, 'deals')) && existsSync(join(REAL, 'calls'))

describe.runIf(HAS_REAL)('the founder\'s four won deals, on a copy of the real profile', () => {
  beforeEach(async () => {
    USER_DATA = await mkdtemp(join(tmpdir(), 'callrise-link-real-'))
    for (const d of ['contacts', 'calls', 'deals']) cpSync(join(REAL, d), join(USER_DATA, d), { recursive: true })
    cpSync(join(REAL, 'deal-stages.json'), join(USER_DATA, 'deal-stages.json'))
  })
  afterEach(async () => {
    await rm(USER_DATA, { recursive: true, force: true })
  })

  it('offers the closed deals with unlinked coached calls, and linking them all makes the won column countable — on the copy', async () => {
    const before = await linkSuggestions()
    console.log(`\n  real profile (copy): ${before.deals.length} closed deal(s) offered, ${before.totalCalls} coached calls: ` +
      before.deals.map((d) => `${d.stageLabel}:${d.coachedCallIds.length}`).join(', '))
    const s0 = await buildState()
    const r = await linkAllSuggested()
    if (s0.insight.status !== 'insufficient' || r.state.insight.status !== 'insufficient') throw new Error('unreachable at this volume')
    console.log(`  usable won ${s0.insight.usable.won} -> ${r.state.insight.usable.won}; linked ${r.linked}; still offered ${r.suggestions.deals.length}`)
    expect(r.linked).toBe(before.totalCalls)
    expect(r.suggestions.deals).toHaveLength(0)
    expect(r.state.insight.usable.won).toBeGreaterThanOrEqual(s0.insight.usable.won)
  })
})
