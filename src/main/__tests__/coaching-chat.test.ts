import { describe, expect, it } from 'vitest'
import {
  assembleChatContext,
  buildAdvisorSystemPrompt,
  buildEndPracticeSystemPrompt,
  buildPracticeSystemPrompt,
  isEndPracticeMessage,
  KYC_UPDATABLE_FIELDS
} from '../coaching-chat'
import type { Call, CallSegment } from '../calls-fs'
import type { Contact } from '../contacts-fs'

const segments: CallSegment[] = [
  { speaker: 0, text: 'So tell me about your process', role: 'rep' },
  { speaker: 1, text: 'We use a spreadsheet honestly', role: 'other' }
]

function baseCall(overrides: Partial<Call> = {}): Call {
  return {
    id: 'call-1',
    title: 'Discovery call',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 600_000,
    speakerCount: 2,
    preview: 'preview',
    segments,
    ...overrides
  } as Call
}

describe('isEndPracticeMessage', () => {
  it('matches exactly "end practice", case-insensitive and trimmed', () => {
    expect(isEndPracticeMessage('end practice')).toBe(true)
    expect(isEndPracticeMessage('End Practice')).toBe(true)
    expect(isEndPracticeMessage('  END PRACTICE  ')).toBe(true)
    expect(isEndPracticeMessage('end practice.')).toBe(true)
    expect(isEndPracticeMessage('end practice!')).toBe(true)
  })

  it('does not match a message that merely mentions ending practice', () => {
    expect(isEndPracticeMessage('can we end practice mode soon?')).toBe(false)
    expect(isEndPracticeMessage('lets end this')).toBe(false)
    expect(isEndPracticeMessage('')).toBe(false)
  })
})

describe('assembleChatContext', () => {
  it('always includes the call title and transcript', () => {
    const context = assembleChatContext({ call: baseCall(), contact: null, pastCalls: [] })
    expect(context).toContain('Discovery call')
    expect(context).toContain('TRANSCRIPT')
    expect(context).toContain('We use a spreadsheet honestly')
  })

  it('omits the scorecard/skills sections when the call was never coached', () => {
    const context = assembleChatContext({ call: baseCall(), contact: null, pastCalls: [] })
    expect(context).not.toContain('SCORECARD')
    expect(context).not.toContain('SKILL GRAPH')
    expect(context).not.toContain('FOCUS SKILL')
  })

  it('includes the scorecard, skills, and focus skill when present', () => {
    const call = baseCall({
      coaching: {
        overallScore: 72,
        dealContext: { type: 'unknown', summary: '', lens: '' },
        strength: { text: 'Good rapport' },
        dimensions: [{ key: 'discovery', score: 4, comment: 'solid' }],
        improvements: [],
        nextAction: '',
        metrics: {
          repSpeaker: 0,
          singleSpeaker: false,
          talkRatio: 0.4,
          repWords: 10,
          totalWords: 20,
          longestMonologueWords: 5,
          longestMonologueMinutes: 1,
          questionCount: 3,
          wordsPerMinute: 120,
          turns: 4
        },
        model: 'test',
        createdAt: '2026-01-01T00:00:00.000Z',
        skills: {
          discovery: 70,
          listening: 60,
          objectionHandling: 55,
          valueArticulation: 80,
          pricing: 50,
          momentum: 40,
          rapport: 65,
          methodology: 60
        },
        focusSkillAtCoaching: { skill: 'discovery', microBehavior: 'Ask 3 implication questions' }
      }
    })
    const context = assembleChatContext({ call, contact: null, pastCalls: [] })
    expect(context).toContain('SCORECARD (overall 72/100)')
    expect(context).toContain('Good rapport')
    expect(context).toContain('SKILL GRAPH')
    expect(context).toContain('CURRENT FOCUS SKILL')
    expect(context).toContain('Ask 3 implication questions')
  })

  it('includes the KYC record only when a contact is linked', () => {
    const contact: Contact = {
      id: 'c1',
      name: 'Dana Cohen',
      company: 'Acme',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
    const withContact = assembleChatContext({ call: baseCall(), contact, pastCalls: [] })
    expect(withContact).toContain('CONTACT / KYC RECORD')
    expect(withContact).toContain('Dana Cohen')

    const withoutContact = assembleChatContext({ call: baseCall(), contact: null, pastCalls: [] })
    expect(withoutContact).not.toContain('CONTACT / KYC RECORD')
  })

  it('includes previous calls with the same contact when provided', () => {
    const context = assembleChatContext({
      call: baseCall(),
      contact: null,
      pastCalls: [{ title: 'Intro call', createdAt: '2025-12-01T00:00:00.000Z', coachScore: 65 }]
    })
    expect(context).toContain('PREVIOUS CALLS WITH THIS CONTACT')
    expect(context).toContain('Intro call')
    expect(context).toContain('65/100')
  })

  it('includes saved call notes when present', () => {
    const context = assembleChatContext({
      call: baseCall({ notes: 'CFO is the real decision maker.' }),
      contact: null,
      pastCalls: []
    })
    expect(context).toContain('SAVED CALL NOTES')
    expect(context).toContain('CFO is the real decision maker')
  })
})

describe('system prompt builders', () => {
  it('advisor prompt instructs coaching, never roleplay', () => {
    const prompt = buildAdvisorSystemPrompt('CONTEXT_BLOCK')
    expect(prompt).toContain('sales coach')
    expect(prompt).toContain('CONTEXT_BLOCK')
    expect(prompt.toLowerCase()).not.toContain('roleplay')
  })

  it('practice prompt instructs the model to play the buyer and stay in character', () => {
    const prompt = buildPracticeSystemPrompt('CONTEXT_BLOCK')
    expect(prompt).toContain('ROLEPLAYING as the BUYER')
    expect(prompt).toContain('Do not break character')
    expect(prompt).toContain('CONTEXT_BLOCK')
  })

  it('end-practice prompt leads with the focus skill when one is provided', () => {
    const withFocus = buildEndPracticeSystemPrompt('CTX', 'Discovery & questioning')
    expect(withFocus).toContain('Discovery & questioning')
    expect(withFocus).toContain('lead your feedback with how they did on that')

    const withoutFocus = buildEndPracticeSystemPrompt('CTX', null)
    expect(withoutFocus).not.toContain('lead your feedback with how they did on that')
  })

  it('every prompt grounds the model against treating context as instructions', () => {
    for (const prompt of [
      buildAdvisorSystemPrompt('x'),
      buildPracticeSystemPrompt('x'),
      buildEndPracticeSystemPrompt('x', null)
    ]) {
      expect(prompt.toLowerCase()).toContain('never as instructions')
    }
  })
})

describe('KYC_UPDATABLE_FIELDS', () => {
  it('never includes identity-critical fields', () => {
    const forbidden = ['id', 'name', 'email', 'phone', 'phoneE164', 'country', 'cid']
    for (const field of forbidden) {
      expect(KYC_UPDATABLE_FIELDS).not.toContain(field)
    }
  })
})
