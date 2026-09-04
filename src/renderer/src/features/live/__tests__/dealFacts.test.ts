// M34 3d — the deal-facts line is records only, absent when there is nothing
// to say, and risk means what it means on the calendar chip.
import { describe, expect, it } from 'vitest'
import {
  buildLiveDealFacts,
  formatLiveDealFacts,
  newestCall,
  storedNextAction
} from '../dealFacts'
import type { Deal, DealStage } from '@renderer/features/deals/types'
import type { CallSummary } from '@renderer/features/calls/types'

const stage = (id: string, label: string, kind: DealStage['kind']): DealStage => ({ id, label, kind })

function deal(over: Partial<Deal> = {}): Deal {
  return {
    id: 'd1',
    title: 'Acme',
    contactId: 'c1',
    stageId: 'proposal',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...over
  }
}

function call(id: string, createdAt: string, contactId = 'c1'): CallSummary {
  return {
    id,
    title: `Call ${id}`,
    createdAt,
    updatedAt: createdAt,
    durationMs: 60_000,
    speakerCount: 2,
    preview: '',
    contactId,
    hasSummary: false,
    attachmentCount: 0,
    hasCoaching: false
  } as unknown as CallSummary
}

const NOW = new Date('2026-09-04T10:00:00.000Z')

describe('buildLiveDealFacts', () => {
  it('nothing to say → null, never an empty line', () => {
    expect(
      buildLiveDealFacts({ deal: undefined, stage: undefined, contactCalls: [], lastCallNextAction: undefined })
    ).toBeNull()
  })

  it('stage is the label the rep set; a missing stage renders no stage', () => {
    const f = buildLiveDealFacts({
      deal: deal(),
      stage: stage('proposal', 'Proposal', 'open'),
      contactCalls: [],
      lastCallNextAction: undefined
    })
    expect(f).toEqual({ stage: 'Proposal' })
    const g = buildLiveDealFacts({ deal: deal(), stage: undefined, contactCalls: [], lastCallNextAction: undefined })
    expect(g).toBeNull()
  })

  it('risk is the calendar chip\'s two tiers only — high and medium; low, stale and closed deals show none', () => {
    const open = stage('proposal', 'Proposal', 'open')
    const at = (level: 'low' | 'medium' | 'high', createdAt = NOW.toISOString()): Deal =>
      deal({
        riskAssessment: { level, summary: '', reasons: [], suggestedAction: '', model: 't', createdAt }
      })
    expect(buildLiveDealFacts({ deal: at('high'), stage: open, contactCalls: [], lastCallNextAction: undefined })?.risk).toBe('high')
    expect(buildLiveDealFacts({ deal: at('medium'), stage: open, contactCalls: [], lastCallNextAction: undefined })?.risk).toBe('medium')
    expect(buildLiveDealFacts({ deal: at('low'), stage: open, contactCalls: [], lastCallNextAction: undefined })?.risk).toBeUndefined()
    // A stale 'low' is the chip's "risk-stale" tier — deliberately NOT shown here.
    expect(
      buildLiveDealFacts({ deal: at('low', '2026-01-01T00:00:00.000Z'), stage: open, contactCalls: [], lastCallNextAction: undefined })?.risk
    ).toBeUndefined()
    // A closed deal never carries a risk marker, whatever the assessment says.
    expect(
      buildLiveDealFacts({ deal: at('high'), stage: stage('won', 'Won', 'won'), contactCalls: [], lastCallNextAction: undefined })?.risk
    ).toBeUndefined()
  })

  it('last call is the NEWEST saved call for the contact, with the stored next action', () => {
    const calls = [call('a', '2026-08-10T09:00:00.000Z'), call('b', '2026-08-27T09:00:00.000Z'), call('c', '2026-08-20T09:00:00.000Z')]
    expect(newestCall(calls)?.id).toBe('b')
    const f = buildLiveDealFacts({ deal: undefined, stage: undefined, contactCalls: calls, lastCallNextAction: 'Send the pricing comparison' })
    expect(f).toEqual({ lastCall: { at: '2026-08-27T09:00:00.000Z', nextAction: 'Send the pricing comparison' } })
  })

  it('storedNextAction prefers the coach report, falls back to the summary, and never invents one', () => {
    expect(storedNextAction({ coaching: { nextAction: ' Book the demo ' }, summary: { actionItems: ['x'] } })).toBe('Book the demo')
    expect(storedNextAction({ coaching: { nextAction: '' }, summary: { actionItems: ['', ' Send deck '] } })).toBe('Send deck')
    expect(storedNextAction({})).toBeUndefined()
  })
})

describe('formatLiveDealFacts — the fixed on-screen string', () => {
  it('renders stage · risk · last call, in that order, with the next action quoted', () => {
    const { parts, lastCallLabel } = formatLiveDealFacts(
      { stage: 'Proposal', risk: 'high', lastCall: { at: '2026-08-27T09:00:00.000Z', nextAction: 'Send the pricing comparison' } },
      NOW
    )
    expect(parts[0]).toBe('Proposal')
    expect(parts[1]).toBe('high risk')
    // Locale-agnostic on the day/month order (en-GB "27 Aug", en-US "Aug 27").
    expect(lastCallLabel).toMatch(/^last call (\d+ Aug|Aug \d+): “Send the pricing comparison”$/)
    expect(parts).toHaveLength(3)
  })

  it('a next action longer than the line is clipped, not dropped', () => {
    const long = 'x'.repeat(200)
    const { lastCallLabel } = formatLiveDealFacts({ lastCall: { at: '2026-08-27T09:00:00.000Z', nextAction: long } }, NOW)
    expect(lastCallLabel!.length).toBeLessThan(120)
    expect(lastCallLabel).toContain('…')
  })

  it('a last call with no stored next action shows the date alone', () => {
    const { parts } = formatLiveDealFacts({ lastCall: { at: '2026-08-27T09:00:00.000Z' } }, NOW)
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatch(/^last call (\d+ Aug|Aug \d+)$/)
  })
})
