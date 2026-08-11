import { describe, expect, it } from 'vitest'
import { summarizeLiveCallState } from '../summarize'
import { createInitialState, type LiveCallState } from '../types'

const withPatch = (patch: Partial<LiveCallState>): LiveCallState => ({
  ...createInitialState(0),
  ...patch
})

describe('summarizeLiveCallState', () => {
  it('always includes elapsed time and stage', () => {
    const s = summarizeLiveCallState(withPatch({ lastUpdatedAtMs: 90_000, callStage: 'discovery' }))
    expect(s).toContain('1:30')
    expect(s).toContain('discovery')
  })

  it('omits the talk-ratio line entirely when there is not enough signal yet', () => {
    const s = summarizeLiveCallState(withPatch({ talkRatio: null }))
    expect(s).not.toContain('Talk ratio')
  })

  it('includes talk ratio as a percentage once known', () => {
    const s = summarizeLiveCallState(withPatch({ talkRatio: 0.62 }))
    expect(s).toContain('62%')
  })

  it('flags an in-progress monologue only once it has run a while', () => {
    const short = summarizeLiveCallState(withPatch({ currentRepMonologueMs: 5_000 }))
    expect(short).not.toContain('mid-monologue')

    const long = summarizeLiveCallState(withPatch({ currentRepMonologueMs: 45_000 }))
    expect(long).toContain('mid-monologue')
  })

  it('says explicitly when no objections have been raised', () => {
    const s = summarizeLiveCallState(withPatch({ objections: [] }))
    expect(s).toContain('No objections raised yet')
  })

  it('summarizes raised objections with type, status, and recency', () => {
    const s = summarizeLiveCallState(
      withPatch({
        lastUpdatedAtMs: 120_000,
        objections: [
          {
            type: 'price',
            status: 'raised',
            raisedEvidence: { role: 'other', text: 'too expensive', atMs: 60_000 },
            lastMentionedAtMs: 60_000
          }
        ]
      })
    )
    expect(s).toContain('price (raised')
    expect(s).toContain('1:00 ago')
  })

  it('lists budget and timeline mentions by term when present, omits them when absent', () => {
    const withMentions = summarizeLiveCallState(
      withPatch({
        budgetMentions: [{ term: 'budget', evidence: [{ role: 'other', text: 'x', atMs: 0 }] }],
        timelineMentions: [
          { term: 'next quarter', evidence: [{ role: 'other', text: 'y', atMs: 0 }] }
        ]
      })
    )
    expect(withMentions).toContain('Budget mentions: "budget"')
    expect(withMentions).toContain('Timeline mentions: "next quarter"')

    const without = summarizeLiveCallState(withPatch({}))
    expect(without).not.toContain('Budget mentions')
    expect(without).not.toContain('Timeline mentions')
  })

  it('reports agenda coverage split between covered and not-yet-covered topics', () => {
    const s = summarizeLiveCallState(
      withPatch({
        agendaTopics: ['pricing', 'integration', 'onboarding'],
        topicsCovered: ['pricing']
      })
    )
    expect(s).toContain('Agenda topics covered: pricing.')
    expect(s).toContain('Not yet covered: integration, onboarding.')
  })

  it('omits the agenda line entirely when no agenda was configured', () => {
    const s = summarizeLiveCallState(withPatch({ agendaTopics: [] }))
    expect(s).not.toContain('Agenda topics')
  })

  it('summarizes recent sentiment as a coarse trend, and omits it when there is none yet', () => {
    const positive = summarizeLiveCallState(
      withPatch({
        sentimentTrajectory: [
          { atMs: 0, score: 0.5 },
          { atMs: 1000, score: 0.5 }
        ]
      })
    )
    expect(positive).toContain('trending positive')

    const none = summarizeLiveCallState(withPatch({ sentimentTrajectory: [] }))
    expect(none).not.toContain('sentiment')
  })
})
