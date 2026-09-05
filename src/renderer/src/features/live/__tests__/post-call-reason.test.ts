// M34 3e — the reason prompt at call end: decided from records, skippable,
// retiring on a consistent skip streak, never guessing a deal.
import { describe, expect, it } from 'vitest'
import { decidePostCallReason, resolvePostCallReason } from '../post-call-reason'
import type { Deal, DealStage } from '@renderer/features/deals/types'

const stage = (id: string, label: string, kind: DealStage['kind']): DealStage => ({ id, label, kind })
const deal = (over: Partial<Deal> = {}): Deal => ({
  id: 'd1',
  title: 'Acme',
  contactId: 'c1',
  stageId: 'lost',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...over
})
const asking = { retired: () => false, announceStopping: () => false }

describe('decidePostCallReason', () => {
  it('a closed deal with no reason earns the prompt, with the question keyed to how it ended', () => {
    for (const kind of ['won', 'lost', 'went-quiet'] as const) {
      const d = decidePostCallReason({ deal: deal({ stageId: kind }), stage: stage(kind, kind, kind) }, asking)
      expect(d).toEqual({ kind: 'prompt', dealId: 'd1', dealTitle: 'Acme', end: kind, stageLabel: kind })
    }
  })

  it('an OPEN deal never prompts — nothing has ended', () => {
    expect(decidePostCallReason({ deal: deal({ stageId: 'p' }), stage: stage('p', 'Proposal', 'open') }, asking)).toEqual({ kind: 'none' })
  })

  it('a deal that already has a reason is not asked again', () => {
    expect(decidePostCallReason({ deal: deal({ outcomeReason: 'price' }), stage: stage('lost', 'Lost', 'lost') }, asking)).toEqual({ kind: 'none' })
    // whitespace is not a reason
    expect(decidePostCallReason({ deal: deal({ outcomeReason: '   ' }), stage: stage('lost', 'Lost', 'lost') }, asking).kind).toBe('prompt')
  })

  it('no deal, or a deal whose stage no longer exists → none, never a guess', () => {
    expect(decidePostCallReason({ deal: undefined, stage: undefined }, asking)).toEqual({ kind: 'none' })
    expect(decidePostCallReason({ deal: deal(), stage: undefined }, asking)).toEqual({ kind: 'none' })
  })

  it('once the skip streak retires the prompt, it says so ONCE and is then silent', () => {
    const input = { deal: deal(), stage: stage('lost', 'Lost', 'lost') }
    let told = false
    const pref = { retired: () => true, announceStopping: () => (told ? false : (told = true)) }
    expect(decidePostCallReason(input, pref)).toEqual({ kind: 'retired-notice' })
    expect(decidePostCallReason(input, pref)).toEqual({ kind: 'none' })
    expect(decidePostCallReason(input, pref)).toEqual({ kind: 'none' })
  })
})

describe('resolvePostCallReason — which deal the ended call belongs to', () => {
  const deals = [deal({ id: 'linked', stageId: 'lost' }), deal({ id: 'meeting-deal', stageId: 'won' })]
  const stages = [stage('lost', 'Lost', 'lost'), stage('won', 'Won', 'won')]
  const api = (callDealId: string | undefined) => ({
    getCall: async () => ({ dealId: callDealId }),
    listDeals: async () => deals,
    getStages: async () => stages
  })

  it("the saved call's own deal link wins over the matched meeting's deal", async () => {
    const d = await resolvePostCallReason('call', 'meeting-deal', api('linked'))
    expect(d.kind === 'prompt' && d.dealId).toBe('linked')
  })

  it("with no link on the call, the matched meeting's deal is used", async () => {
    const d = await resolvePostCallReason('call', 'meeting-deal', api(undefined))
    expect(d.kind === 'prompt' && d.dealId).toBe('meeting-deal')
  })

  it('with neither, nothing — and a failed lookup is also nothing', async () => {
    expect((await resolvePostCallReason('call', undefined, api(undefined))).kind).toBe('none')
    const broken = { getCall: async () => { throw new Error('ipc down') }, listDeals: async () => deals, getStages: async () => stages }
    expect((await resolvePostCallReason('call', 'meeting-deal', broken)).kind).toBe('none')
  })
})
