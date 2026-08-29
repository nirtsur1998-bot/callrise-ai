import { describe, expect, it } from 'vitest'
import { briefEligibleEvents, buildChipContext, resolveRisk } from '../chipContext'
import type { ChipContextSources } from '../chipContext'
import type { CalendarEvent, CalendarItem } from '../types'
import type { Deal, DealStage } from '@renderer/features/deals/types'
import type { Contact } from '@renderer/features/contacts/types'

const NOW = new Date('2026-08-29T09:00:00Z')

const OPEN_STAGE: DealStage = { id: 's1', label: 'Proposal', kind: 'open' }
const WON_STAGE: DealStage = { id: 's2', label: 'Won', kind: 'won' }

function deal(patch: Partial<Deal> = {}): Deal {
  return {
    id: 'd1',
    title: 'Super Fund renewal',
    contactId: 'c1',
    stageId: 's1',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...patch
  } as Deal
}

function event(patch: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'e1',
    title: 'Renewal call',
    start: '2026-09-01T11:00:00.000Z',
    end: '2026-09-01T11:30:00.000Z',
    allDay: false,
    source: 'local',
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z',
    ...patch
  }
}

function item(ev: CalendarEvent, patch: Partial<CalendarItem> = {}): CalendarItem {
  return {
    key: `event-${ev.id}`,
    kind: 'event',
    title: ev.title,
    start: new Date(ev.start),
    end: new Date(ev.end),
    allDay: false,
    event: ev,
    ...patch
  }
}

function sources(patch: Partial<ChipContextSources> = {}): ChipContextSources {
  return {
    contactById: new Map<string, Contact>([['c1', { id: 'c1', name: 'Ben Carter' } as Contact]]),
    dealById: new Map<string, Deal>([['d1', deal()]]),
    stageById: new Map<string, DealStage>([
      ['s1', OPEN_STAGE],
      ['s2', WON_STAGE]
    ]),
    briefStatusByEventId: new Map(),
    ...patch
  }
}

describe('resolveRisk', () => {
  it('surfaces high and medium risk', () => {
    expect(resolveRisk(deal({ riskAssessment: { level: 'high' } } as Partial<Deal>), OPEN_STAGE)).toBe('high')
    expect(resolveRisk(deal({ riskAssessment: { level: 'medium' } } as Partial<Deal>), OPEN_STAGE)).toBe(
      'medium'
    )
  })

  it('shows nothing for a low-risk deal', () => {
    expect(resolveRisk(deal({ riskAssessment: { level: 'low' } } as Partial<Deal>), OPEN_STAGE)).toBeUndefined()
  })

  it('shows nothing for a deal with no risk assessment at all', () => {
    expect(resolveRisk(deal(), OPEN_STAGE)).toBeUndefined()
  })

  it('shows nothing once the deal is closed, even at high risk', () => {
    expect(
      resolveRisk(deal({ stageId: 's2', riskAssessment: { level: 'high' } } as Partial<Deal>), WON_STAGE)
    ).toBeUndefined()
  })

  it('never surfaces the staleness tiers the calendar has no data for', () => {
    // An old low-risk read would be 'risk-stale' on the follow-up digest.
    // The chip must stay silent rather than imply a risk level it can't back.
    const stale = deal({
      riskAssessment: { level: 'low', createdAt: '2026-01-01T00:00:00.000Z' }
    } as Partial<Deal>)
    expect(resolveRisk(stale, OPEN_STAGE)).toBeUndefined()
  })
})

describe('buildChipContext', () => {
  it('carries contact name and deal stage for a linked meeting', () => {
    const ctx = buildChipContext(item(event({ contactId: 'c1', dealId: 'd1' })), sources())
    expect(ctx?.contactName).toBe('Ben Carter')
    expect(ctx?.dealStage).toBe('Proposal')
  })

  it('returns undefined when there is nothing to show', () => {
    expect(buildChipContext(item(event()), sources())).toBeUndefined()
  })

  it('omits a contact name for a link pointing at a contact that no longer exists', () => {
    const ctx = buildChipContext(item(event({ contactId: 'ghost' })), sources())
    expect(ctx).toBeUndefined()
  })

  it('never attaches context to a task chip', () => {
    const task: CalendarItem = {
      key: 'task-1',
      kind: 'task',
      title: 'Send the proposal',
      start: NOW,
      end: NOW,
      allDay: true
    }
    expect(buildChipContext(task, sources())).toBeUndefined()
  })

  it('never attaches context to a read-only Google/Outlook overlay item', () => {
    const overlay: CalendarItem = {
      key: 'google-x',
      kind: 'google',
      title: 'Standup',
      start: NOW,
      end: NOW,
      allDay: false
    }
    expect(buildChipContext(overlay, sources())).toBeUndefined()
  })

  describe('the brief dot — the piece most able to lie', () => {
    it("shows 'ready' only when main said ready", () => {
      const ev = event({ contactId: 'c1' })
      const ctx = buildChipContext(
        item(ev),
        sources({ briefStatusByEventId: new Map([['e1', 'ready']]) })
      )
      expect(ctx?.brief).toBe('ready')
    })

    it("passes 'outdated' straight through rather than rounding it up to ready", () => {
      const ev = event({ contactId: 'c1' })
      const ctx = buildChipContext(
        item(ev),
        sources({ briefStatusByEventId: new Map([['e1', 'outdated']]) })
      )
      expect(ctx?.brief).toBe('outdated')
    })

    it("shows no dot at all for 'none' — an absent brief is not a state worth a marker", () => {
      const ev = event({ contactId: 'c1' })
      const ctx = buildChipContext(
        item(ev),
        sources({ briefStatusByEventId: new Map([['e1', 'none']]) })
      )
      expect(ctx?.brief).toBeUndefined()
    })

    it('shows no dot when main returned no status for this event', () => {
      const ctx = buildChipContext(item(event({ contactId: 'c1' })), sources())
      expect(ctx?.brief).toBeUndefined()
    })

    it('shows no dot for an event with no contact or deal — there is nothing to brief on', () => {
      const ctx = buildChipContext(
        item(event()),
        sources({ briefStatusByEventId: new Map([['e1', 'ready']]) })
      )
      expect(ctx?.brief).toBeUndefined()
    })
  })
})

describe('the recorded-call link — plan joined to outcome', () => {
  it('carries the call id when the meeting has a real link', () => {
    const ctx = buildChipContext(item(event({ callId: 'call-1', contactId: 'c1' })), sources())
    expect(ctx?.callId).toBe('call-1')
  })

  it('shows nothing when no call was recorded during the meeting', () => {
    const ctx = buildChipContext(item(event({ contactId: 'c1' })), sources())
    expect(ctx?.callId).toBeUndefined()
  })

  it('never invents a link from a shared contact and an overlapping time', () => {
    // The heuristic this feature deliberately does NOT implement: a meeting
    // and a call that share a contact and overlap in time. Without the hard
    // link written at save time, the chip must stay silent — a match that is
    // usually right teaches trust before the case where it misleads.
    const ctx = buildChipContext(item(event({ contactId: 'c1' })), sources())
    expect(ctx?.callId).toBeUndefined()
    expect(Object.keys(ctx ?? {})).not.toContain('callId')
  })

  it('is a fact, not a confidence — there is no partial/probable variant', () => {
    const ctx = buildChipContext(item(event({ callId: 'call-1' })), sources())
    // Present or absent, nothing in between: the shape itself refuses to
    // express "probably this call".
    expect(ctx?.callId).toBe('call-1')
    expect(typeof ctx?.callId).toBe('string')
  })

  it('never attaches a call link to a task or an overlay item', () => {
    const overlay: CalendarItem = {
      key: 'google-x',
      kind: 'google',
      title: 'Standup',
      start: NOW,
      end: NOW,
      allDay: false
    }
    expect(buildChipContext(overlay, sources())?.callId).toBeUndefined()
  })

  it('can carry a call link on a past meeting, where the brief dot is excluded', () => {
    // A past meeting is not brief-eligible (nothing to prepare for), but it
    // is exactly where the outcome matters — the two markers cover opposite
    // halves of a meeting's life, which is why a chip never shows both.
    const past = event({
      callId: 'call-1',
      contactId: 'c1',
      start: '2026-08-01T10:00:00.000Z',
      end: '2026-08-01T11:00:00.000Z'
    })
    const ctx = buildChipContext(item(past), sources())
    expect(ctx?.callId).toBe('call-1')
    expect(ctx?.brief).toBeUndefined()
    expect(briefEligibleEvents([item(past)], NOW)).toHaveLength(0)
  })
})

describe('briefEligibleEvents', () => {
  it('includes a future linked meeting', () => {
    expect(briefEligibleEvents([item(event({ contactId: 'c1' }))], NOW)).toHaveLength(1)
  })

  it('excludes a meeting that already happened', () => {
    const past = event({ contactId: 'c1', start: '2026-08-01T10:00:00.000Z', end: '2026-08-01T10:30:00.000Z' })
    expect(briefEligibleEvents([item(past)], NOW)).toHaveLength(0)
  })

  it('excludes an unlinked meeting', () => {
    expect(briefEligibleEvents([item(event())], NOW)).toHaveLength(0)
  })

  it('excludes tasks and overlay items', () => {
    const task: CalendarItem = {
      key: 'task-1',
      kind: 'task',
      title: 'x',
      start: new Date('2026-09-05T09:00:00Z'),
      end: new Date('2026-09-05T09:00:00Z'),
      allDay: true
    }
    expect(briefEligibleEvents([task], NOW)).toHaveLength(0)
  })
})
