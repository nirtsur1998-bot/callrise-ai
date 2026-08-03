import { describe, expect, it } from 'vitest'
import { formatBriefForPush, type PrepBrief } from '../prep-brief'

const BRIEF: PrepBrief = {
  whoYoureMeeting: 'Sarah Chen, VP Eng at Acme — third call, evaluating for a Q3 rollout.',
  dealStatus: 'Proposal stage, $42k ARR, targeting a decision by end of quarter.',
  lastTime: 'She asked for a security review before looping in procurement.',
  openCommitments: ['Send the SOC 2 report', 'Book the technical deep-dive'],
  likelyObjections: ['Budget approval needs a second signer'],
  openers: [
    'How did the SOC 2 report land with your security team?',
    'Any movement on getting Dana looped in?',
    'What would need to be true for this to close by end of quarter?'
  ],
  model: 'test-model',
  generatedAt: '2026-07-30T00:00:00.000Z'
}

describe('formatBriefForPush', () => {
  it('combines who-you-are-meeting, deal status, and the first opener', () => {
    const text = formatBriefForPush(BRIEF)
    expect(text).toContain('Sarah Chen, VP Eng at Acme')
    expect(text).toContain('Proposal stage, $42k ARR')
    expect(text).toContain('Opener: "How did the SOC 2 report land with your security team?"')
  })

  it('never includes more than the first opener', () => {
    const text = formatBriefForPush(BRIEF)
    expect(text).not.toContain('Any movement on getting Dana')
  })

  it('hard-caps at maxChars, ending with an ellipsis when truncated', () => {
    const text = formatBriefForPush(BRIEF, 40)
    expect(text.length).toBeLessThanOrEqual(40)
    expect(text.endsWith('…')).toBe(true)
  })

  it('omits sections that are empty rather than leaving blank gaps', () => {
    const text = formatBriefForPush({ ...BRIEF, dealStatus: '', openers: [] })
    expect(text).toBe(BRIEF.whoYoureMeeting)
  })

  it('produces an empty string when every section is empty', () => {
    expect(formatBriefForPush({ ...BRIEF, whoYoureMeeting: '', dealStatus: '', openers: [] })).toBe(
      ''
    )
  })
})
