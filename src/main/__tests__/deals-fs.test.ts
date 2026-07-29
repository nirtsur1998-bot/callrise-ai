import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createDeal,
  deleteDeal,
  getDeal,
  importDeal,
  isSafeId,
  listDeals,
  listDealsUsingStage,
  setDealRiskAssessment,
  updateDeal
} from '../deals-fs'

const CONTACT = 'contact-1'
const STAGE_A = 'stage-a'
const STAGE_B = 'stage-b'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'callrise-deals-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('isSafeId', () => {
  it('accepts a plain alphanumeric id', () => {
    expect(isSafeId('abc-123')).toBe(true)
  })

  it('rejects anything that could be used for path traversal', () => {
    expect(isSafeId('../../etc/passwd')).toBe(false)
    expect(isSafeId('a/b')).toBe(false)
    expect(isSafeId(undefined)).toBe(false)
    expect(isSafeId(42)).toBe(false)
  })
})

describe('createDeal', () => {
  it('rejects a deal missing title, contactId, or stageId', async () => {
    expect(await createDeal(dir, { contactId: CONTACT, stageId: STAGE_A })).toBeNull()
    expect(await createDeal(dir, { title: 'Acme', stageId: STAGE_A })).toBeNull()
    expect(await createDeal(dir, { title: 'Acme', contactId: CONTACT })).toBeNull()
  })

  it('rejects an unsafe contactId/stageId even with a valid title', async () => {
    expect(await createDeal(dir, { title: 'Acme', contactId: '../x', stageId: STAGE_A })).toBeNull()
  })

  describe('money value sanitization', () => {
    it('rounds a value to cents', async () => {
      const deal = await createDeal(dir, {
        title: 'Acme',
        contactId: CONTACT,
        stageId: STAGE_A,
        value: 1234.5678
      })
      expect(deal?.value).toBe(1234.57)
    })

    it('accepts a numeric string', async () => {
      const deal = await createDeal(dir, {
        title: 'Acme',
        contactId: CONTACT,
        stageId: STAGE_A,
        value: '5000'
      })
      expect(deal?.value).toBe(5000)
    })

    it('drops a negative value rather than storing garbage', async () => {
      const deal = await createDeal(dir, {
        title: 'Acme',
        contactId: CONTACT,
        stageId: STAGE_A,
        value: -100
      })
      expect(deal?.value).toBeUndefined()
    })

    it('drops NaN/non-numeric input', async () => {
      const deal = await createDeal(dir, {
        title: 'Acme',
        contactId: CONTACT,
        stageId: STAGE_A,
        value: 'not a number'
      })
      expect(deal?.value).toBeUndefined()
    })

    it('caps an implausibly large value at the ceiling rather than storing it raw', async () => {
      const deal = await createDeal(dir, {
        title: 'Acme',
        contactId: CONTACT,
        stageId: STAGE_A,
        value: 999_999_999_999
      })
      expect(deal?.value).toBe(1_000_000_000)
    })
  })

  describe('date sanitization', () => {
    it('accepts a valid date and normalizes to YYYY-MM-DD', async () => {
      const deal = await createDeal(dir, {
        title: 'Acme',
        contactId: CONTACT,
        stageId: STAGE_A,
        expectedCloseDate: '2026-06-15T10:00:00Z'
      })
      expect(deal?.expectedCloseDate).toBe('2026-06-15')
    })

    it('drops an unparseable date rather than storing garbage', async () => {
      const deal = await createDeal(dir, {
        title: 'Acme',
        contactId: CONTACT,
        stageId: STAGE_A,
        expectedCloseDate: 'not a date'
      })
      expect(deal?.expectedCloseDate).toBeUndefined()
    })
  })

  it('persists a multi-line notes field without collapsing it to one line', async () => {
    const deal = await createDeal(dir, {
      title: 'Acme',
      contactId: CONTACT,
      stageId: STAGE_A,
      notes: 'Line one\nLine two'
    })
    expect(deal?.notes).toBe('Line one\nLine two')
  })
})

describe('stage-history on update', () => {
  it('records a transition when stageId actually changes', async () => {
    const created = await createDeal(dir, { title: 'Acme', contactId: CONTACT, stageId: STAGE_A })
    const updated = await updateDeal(dir, created!.id, { stageId: STAGE_B })
    expect(updated?.stageId).toBe(STAGE_B)
    expect(updated?.stageHistory).toHaveLength(1)
    expect(updated?.stageHistory?.[0].stageId).toBe(STAGE_A)
  })

  it('does not append a history entry when the stage is unchanged', async () => {
    const created = await createDeal(dir, { title: 'Acme', contactId: CONTACT, stageId: STAGE_A })
    const updated = await updateDeal(dir, created!.id, { stageId: STAGE_A })
    expect(updated?.stageHistory ?? []).toHaveLength(0)
  })

  it('appends to existing history across multiple transitions, oldest first', async () => {
    const created = await createDeal(dir, { title: 'Acme', contactId: CONTACT, stageId: STAGE_A })
    await updateDeal(dir, created!.id, { stageId: STAGE_B })
    const final = await updateDeal(dir, created!.id, { stageId: 'stage-c' })
    expect(final?.stageHistory).toEqual([
      expect.objectContaining({ stageId: STAGE_A }),
      expect.objectContaining({ stageId: STAGE_B })
    ])
  })

  it('never blanks out the title on an update with an empty patch value', async () => {
    const created = await createDeal(dir, { title: 'Acme', contactId: CONTACT, stageId: STAGE_A })
    const updated = await updateDeal(dir, created!.id, { title: '' })
    expect(updated?.title).toBe('Acme')
  })
})

describe('listDeals / listDealsUsingStage / getDeal', () => {
  it('excludes deleted deals by default and includes them when asked', async () => {
    const deal = await createDeal(dir, { title: 'Acme', contactId: CONTACT, stageId: STAGE_A })
    await deleteDeal(dir, deal!.id)
    expect(await listDeals(dir)).toEqual([])
    expect(await listDeals(dir, { includeDeleted: true })).toHaveLength(1)
    expect(await getDeal(dir, deal!.id)).toBeNull() // a tombstone reads as "gone"
  })

  it('listDealsUsingStage finds only non-deleted deals on the given stages', async () => {
    const a = await createDeal(dir, { title: 'A', contactId: CONTACT, stageId: STAGE_A })
    await createDeal(dir, { title: 'B', contactId: CONTACT, stageId: STAGE_B })
    const deletedOnA = await createDeal(dir, { title: 'C', contactId: CONTACT, stageId: STAGE_A })
    await deleteDeal(dir, deletedOnA!.id)

    const matches = listDealsUsingStage(dir, [STAGE_A])
    expect(matches.map((d) => d.id)).toEqual([a!.id])
  })
})

describe('importDeal — the race-guard', () => {
  it('preserves the original id (idempotent re-import)', async () => {
    const payload = {
      id: 'deal-fixed-id',
      title: 'Acme',
      contactId: CONTACT,
      stageId: STAGE_A,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
    const imported = await importDeal(dir, payload)
    expect(imported?.id).toBe('deal-fixed-id')
    expect(await getDeal(dir, 'deal-fixed-id')).toMatchObject({ title: 'Acme' })
  })

  it('rejects a payload with an unsafe id or missing required fields', async () => {
    expect(await importDeal(dir, { id: '../evil', title: 'x' })).toBeNull()
    expect(await importDeal(dir, { id: 'ok-id' })).toBeNull() // no title/contactId/stageId
    expect(await importDeal(dir, null)).toBeNull()
  })

  it('onlyIfNewer refuses to clobber a local record that is the same age or newer', async () => {
    const id = 'deal-race'
    await importDeal(dir, {
      id,
      title: 'Local edit',
      contactId: CONTACT,
      stageId: STAGE_A,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-10T00:00:00.000Z'
    })
    // An older cloud payload arrives after — must not overwrite the newer local one.
    const result = await importDeal(
      dir,
      {
        id,
        title: 'Stale cloud copy',
        contactId: CONTACT,
        stageId: STAGE_A,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-05T00:00:00.000Z'
      },
      { onlyIfNewer: true }
    )
    expect(result).toBeNull()
    expect(await getDeal(dir, id)).toMatchObject({ title: 'Local edit' })
  })

  it('onlyIfNewer applies a genuinely newer cloud payload', async () => {
    const id = 'deal-race-2'
    await importDeal(dir, {
      id,
      title: 'Old',
      contactId: CONTACT,
      stageId: STAGE_A,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    })
    const result = await importDeal(
      dir,
      {
        id,
        title: 'Newer cloud copy',
        contactId: CONTACT,
        stageId: STAGE_A,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-20T00:00:00.000Z'
      },
      { onlyIfNewer: true }
    )
    expect(result?.title).toBe('Newer cloud copy')
    expect(await getDeal(dir, id)).toMatchObject({ title: 'Newer cloud copy' })
  })

  it('onlyIfNewer proceeds normally when there is no existing local record', async () => {
    const result = await importDeal(
      dir,
      {
        id: 'brand-new',
        title: 'First time',
        contactId: CONTACT,
        stageId: STAGE_A,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      },
      { onlyIfNewer: true }
    )
    expect(result?.title).toBe('First time')
  })

  it('re-sanitizes the payload fully — a tampered field never reaches disk raw', async () => {
    const imported = await importDeal(dir, {
      id: 'deal-tamper',
      title: 'Acme',
      contactId: CONTACT,
      stageId: STAGE_A,
      value: -500, // invalid — must be dropped, not stored
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    })
    expect(imported?.value).toBeUndefined()
  })
})

describe('setDealRiskAssessment', () => {
  const assessment = {
    level: 'high' as const,
    summary: 'No recent activity.',
    reasons: [{ text: 'No calls in 30 days' }],
    suggestedAction: 'Schedule a check-in.',
    model: 'test-model',
    createdAt: '2026-01-01T00:00:00.000Z'
  }

  it('sets the first assessment with no history yet', async () => {
    const deal = await createDeal(dir, { title: 'Acme', contactId: CONTACT, stageId: STAGE_A })
    const updated = await setDealRiskAssessment(dir, deal!.id, assessment)
    expect(updated?.riskAssessment?.level).toBe('high')
    expect(updated?.riskAssessmentHistory ?? []).toHaveLength(0)
  })

  it('pushes the previous assessment into history when a new one is set', async () => {
    const deal = await createDeal(dir, { title: 'Acme', contactId: CONTACT, stageId: STAGE_A })
    await setDealRiskAssessment(dir, deal!.id, assessment)
    const second = await setDealRiskAssessment(dir, deal!.id, { ...assessment, level: 'low' })
    expect(second?.riskAssessment?.level).toBe('low')
    expect(second?.riskAssessmentHistory).toHaveLength(1)
    expect(second?.riskAssessmentHistory?.[0].level).toBe('high')
  })

  it('rejects a malformed assessment', async () => {
    const deal = await createDeal(dir, { title: 'Acme', contactId: CONTACT, stageId: STAGE_A })
    const result = await setDealRiskAssessment(dir, deal!.id, { level: 'not-a-level' } as never)
    expect(result).toBeNull()
  })
})
