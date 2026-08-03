import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ATTENTION_TIER_RANK,
  contactsWithOpenDeals,
  createContactFollowUpTask,
  createFollowUpTask,
  dealAttentionTier,
  isContactStale,
  isDealStale
} from '../staleness'
import type { Deal, DealStage } from '../types'

const DAY_MS = 24 * 60 * 60 * 1000
const daysAgo = (n: number): string => new Date(Date.now() - n * DAY_MS).toISOString()

const OPEN_STAGE: DealStage = { id: 'open-1', label: 'Discovery', kind: 'open' }
const WON_STAGE: DealStage = { id: 'won-1', label: 'Won', kind: 'won' }

function baseDeal(overrides: Partial<Deal> = {}): Deal {
  return {
    id: 'deal-1',
    title: 'Acme deal',
    contactId: 'contact-1',
    stageId: OPEN_STAGE.id,
    createdAt: daysAgo(100),
    updatedAt: daysAgo(100),
    ...overrides
  }
}

describe('ATTENTION_TIER_RANK', () => {
  it('orders risk-high most urgent, stale least urgent', () => {
    expect(ATTENTION_TIER_RANK['risk-high']).toBeLessThan(ATTENTION_TIER_RANK['risk-medium'])
    expect(ATTENTION_TIER_RANK['risk-medium']).toBeLessThan(ATTENTION_TIER_RANK['risk-stale'])
    expect(ATTENTION_TIER_RANK['risk-stale']).toBeLessThan(ATTENTION_TIER_RANK.stale)
  })
})

describe('dealAttentionTier', () => {
  it('is null for a deal in a closed (won/lost) stage regardless of anything else', () => {
    const deal = baseDeal({ riskAssessment: { level: 'high' } as Deal['riskAssessment'] })
    expect(dealAttentionTier(deal, WON_STAGE, undefined, true, 14)).toBeNull()
  })

  it('is null when the stage is unknown (a reset/hand-edited stage list)', () => {
    const deal = baseDeal()
    expect(dealAttentionTier(deal, undefined, undefined, true, 14)).toBeNull()
  })

  it('a high risk assessment always wins, even over a fresh call', () => {
    const deal = baseDeal({
      riskAssessment: { level: 'high', createdAt: daysAgo(1) } as Deal['riskAssessment']
    })
    expect(dealAttentionTier(deal, OPEN_STAGE, daysAgo(0), true, 14)).toBe('risk-high')
  })

  it('a medium risk assessment ranks below high but above plain cadence', () => {
    const deal = baseDeal({
      riskAssessment: { level: 'medium', createdAt: daysAgo(1) } as Deal['riskAssessment']
    })
    expect(dealAttentionTier(deal, OPEN_STAGE, daysAgo(0), true, 14)).toBe('risk-medium')
  })

  it('a stale LOW risk read is flagged for re-check (risk-stale)', () => {
    const deal = baseDeal({
      riskAssessment: { level: 'low', createdAt: daysAgo(45) } as Deal['riskAssessment']
    })
    expect(dealAttentionTier(deal, OPEN_STAGE, daysAgo(0), true, 14)).toBe('risk-stale')
  })

  it('a fresh LOW risk read is not flagged at all when cadence would not otherwise flag it', () => {
    const deal = baseDeal({
      riskAssessment: { level: 'low', createdAt: daysAgo(2) } as Deal['riskAssessment']
    })
    expect(dealAttentionTier(deal, OPEN_STAGE, daysAgo(0), true, 14)).toBeNull()
  })

  it('falls back to cadence staleness when there is no risk assessment at all', () => {
    const deal = baseDeal()
    expect(dealAttentionTier(deal, OPEN_STAGE, daysAgo(30), true, 14)).toBe('stale')
    expect(dealAttentionTier(deal, OPEN_STAGE, daysAgo(2), true, 14)).toBeNull()
  })

  it('never flags cadence staleness when the cadence feature is off', () => {
    const deal = baseDeal()
    expect(dealAttentionTier(deal, OPEN_STAGE, daysAgo(999), false, 14)).toBeNull()
  })

  it("uses the deal's own createdAt as the anchor when it has never been called", () => {
    const oldDeal = baseDeal({ createdAt: daysAgo(90) })
    const newDeal = baseDeal({ createdAt: daysAgo(1) })
    expect(dealAttentionTier(oldDeal, OPEN_STAGE, undefined, true, 14)).toBe('stale')
    expect(dealAttentionTier(newDeal, OPEN_STAGE, undefined, true, 14)).toBeNull()
  })
})

describe('isDealStale', () => {
  it('is false when the feature is off', () => {
    expect(isDealStale(OPEN_STAGE, daysAgo(999), false, 14)).toBe(false)
  })

  it('is false for a closed-stage deal', () => {
    expect(isDealStale(WON_STAGE, daysAgo(999), true, 14)).toBe(false)
  })

  it('is false for a deal added today with no calls yet, even past the threshold', () => {
    expect(isDealStale(OPEN_STAGE, undefined, true, 14, daysAgo(0))).toBe(false)
  })

  it('is true once a never-called deal record itself is older than the threshold', () => {
    expect(isDealStale(OPEN_STAGE, undefined, true, 14, daysAgo(30))).toBe(true)
  })
})

describe('contactsWithOpenDeals', () => {
  it('includes a contact with an open deal', () => {
    const deals = [baseDeal({ contactId: 'c1', stageId: OPEN_STAGE.id })]
    expect(contactsWithOpenDeals(deals, [OPEN_STAGE, WON_STAGE]).has('c1')).toBe(true)
  })

  it('excludes a contact whose only deal is closed', () => {
    const deals = [baseDeal({ contactId: 'c1', stageId: WON_STAGE.id })]
    expect(contactsWithOpenDeals(deals, [OPEN_STAGE, WON_STAGE]).has('c1')).toBe(false)
  })

  it('treats a deal in an unknown stage as open — a config reset must not hide it', () => {
    const deals = [baseDeal({ contactId: 'c1', stageId: 'stage-that-no-longer-exists' })]
    expect(contactsWithOpenDeals(deals, [OPEN_STAGE, WON_STAGE]).has('c1')).toBe(true)
  })
})

describe('isContactStale', () => {
  it('is false when the contact already has an open deal (flagged on the deal instead)', () => {
    expect(isContactStale(true, daysAgo(999), true, 14)).toBe(false)
  })

  it('is false when the feature is off', () => {
    expect(isContactStale(false, daysAgo(999), false, 14)).toBe(false)
  })

  it('is true for a contact with no open deal who has gone quiet past the threshold', () => {
    expect(isContactStale(false, daysAgo(30), true, 14)).toBe(true)
  })

  it('is false for a contact added today with no calls yet', () => {
    expect(isContactStale(false, undefined, true, 14, daysAgo(0))).toBe(false)
  })
})

describe('createFollowUpTask / createContactFollowUpTask — dedup guard', () => {
  const apiStub = {
    tasks: {
      list: vi.fn(),
      create: vi.fn()
    }
  }

  beforeEach(() => {
    apiStub.tasks.list.mockReset().mockResolvedValue([])
    apiStub.tasks.create.mockReset().mockResolvedValue(undefined)
    ;(globalThis as { window: typeof window }).window = {
      ...(globalThis as unknown as { window?: object }).window,
      api: apiStub
    } as unknown as Window & typeof globalThis
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates a new follow-up task when none is already open', async () => {
    const result = await createFollowUpTask(baseDeal({ title: 'Acme deal' }), 'Jane Doe')
    expect(result).toBe('created')
    expect(apiStub.tasks.create).toHaveBeenCalledOnce()
  })

  it('reports "exists" instead of creating a duplicate open task', async () => {
    apiStub.tasks.list.mockResolvedValue([
      { title: 'Follow up with Jane Doe — Acme deal', status: 'open' }
    ])
    const result = await createFollowUpTask(baseDeal({ title: 'Acme deal' }), 'Jane Doe')
    expect(result).toBe('exists')
    expect(apiStub.tasks.create).not.toHaveBeenCalled()
  })

  it('ignores a same-titled task that is already completed — that is not a duplicate', async () => {
    apiStub.tasks.list.mockResolvedValue([
      { title: 'Follow up with Jane Doe — Acme deal', status: 'completed' }
    ])
    const result = await createFollowUpTask(baseDeal({ title: 'Acme deal' }), 'Jane Doe')
    expect(result).toBe('created')
  })

  it('creates rather than failing when the dedup check itself throws', async () => {
    apiStub.tasks.list.mockRejectedValue(new Error('disk error'))
    const result = await createFollowUpTask(baseDeal(), 'Jane Doe')
    expect(result).toBe('created')
  })

  it('createContactFollowUpTask dedups the same way as the deal variant', async () => {
    apiStub.tasks.list.mockResolvedValue([{ title: 'Follow up with Jane Doe', status: 'open' }])
    const result = await createContactFollowUpTask('contact-1', 'Jane Doe')
    expect(result).toBe('exists')
  })
})
