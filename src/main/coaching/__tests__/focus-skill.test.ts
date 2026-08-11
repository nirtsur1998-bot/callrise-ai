import { describe, expect, it } from 'vitest'
import { ROTATE_AFTER_STREAK, selectFocusSkill, type FocusSkillState } from '../focus-skill'
import { SKILL_TARGET, type SkillProgress } from '../skill-graph'
import type { CoachingReport, SkillKey } from '../../calls-fs'

function progressFor(scores: Partial<Record<SkillKey, number>>, streak: SkillKey): SkillProgress[] {
  const keys: SkillKey[] = [
    'discovery',
    'listening',
    'objectionHandling',
    'valueArticulation',
    'pricing',
    'momentum',
    'rapport',
    'methodology'
  ]
  return keys.map((key) => ({
    key,
    history: [{ callId: 'c1', createdAt: '2026-01-01T00:00:00Z', score: scores[key] ?? 60 }],
    current: scores[key] ?? 60,
    trend: null,
    streakAboveTarget: key === streak ? ROTATE_AFTER_STREAK : 0
  }))
}

const minimalReport: CoachingReport = {
  overallScore: 70,
  dealContext: { type: 'unknown', summary: '', lens: '' },
  strength: { text: '' },
  dimensions: [],
  improvements: [],
  nextAction: '',
  metrics: {
    repSpeaker: 0,
    singleSpeaker: false,
    talkRatio: null,
    repWords: 0,
    totalWords: 0,
    longestMonologueWords: 0,
    longestMonologueMinutes: null,
    questionCount: 0,
    wordsPerMinute: null,
    turns: 0
  },
  model: 'test',
  createdAt: '2026-01-01T00:00:00Z'
}

describe('selectFocusSkill', () => {
  it('picks the lowest-scoring skill when there is no current focus', () => {
    const progress = progressFor({ pricing: 20, discovery: 90 }, 'discovery')
    const next = selectFocusSkill(progress, null, minimalReport, 'call-1', '2026-01-02T00:00:00Z')
    expect(next.skill).toBe('pricing')
    expect(next.since).toBe('2026-01-02T00:00:00Z')
  })

  it('keeps the current focus when its streak has not reached the rotation threshold', () => {
    const progress: SkillProgress[] = [
      {
        key: 'rapport',
        history: [{ callId: 'c1', createdAt: '2026-01-01T00:00:00Z', score: SKILL_TARGET }],
        current: SKILL_TARGET,
        trend: 'up',
        streakAboveTarget: 1 // below ROTATE_AFTER_STREAK
      }
    ]
    const current: FocusSkillState = {
      skill: 'rapport',
      microBehavior: 'reflect back what they said',
      since: '2025-12-01T00:00:00Z'
    }
    const next = selectFocusSkill(progress, current, minimalReport, 'call-2', '2026-01-02T00:00:00Z')
    expect(next.skill).toBe('rapport')
    expect(next.since).toBe('2025-12-01T00:00:00Z') // unchanged — no rotation
  })

  it('rotates away once the current focus has a sustained streak', () => {
    const progress = progressFor({ pricing: 20, rapport: 95 }, 'rapport')
    const current: FocusSkillState = {
      skill: 'rapport',
      microBehavior: 'reflect back what they said',
      since: '2025-12-01T00:00:00Z'
    }
    const next = selectFocusSkill(progress, current, minimalReport, 'call-3', '2026-01-03T00:00:00Z')
    expect(next.skill).toBe('pricing')
    expect(next.since).toBe('2026-01-03T00:00:00Z')
  })

  it('reuses a matching mechanical improvement as the micro-behavior when one exists', () => {
    const progress = progressFor({ discovery: 20 }, 'discovery')
    const report: CoachingReport = {
      ...minimalReport,
      improvements: [
        {
          kind: 'mechanical',
          title: 'Ask one more open question before pitching',
          detail: '',
          evidence: { quote: 'so what do you think', speaker: 0, verified: true }
        }
      ]
    }
    const next = selectFocusSkill(progress, null, report, 'call-4', '2026-01-04T00:00:00Z')
    expect(next.skill).toBe('discovery')
    expect(next.microBehavior).toBe('Ask one more open question before pitching')
  })

  it('falls back to a template micro-behavior when no matching improvement exists', () => {
    const progress = progressFor({ pricing: 20 }, 'pricing')
    const next = selectFocusSkill(progress, null, minimalReport, 'call-5', '2026-01-05T00:00:00Z')
    expect(next.skill).toBe('pricing')
    expect(next.microBehavior.length).toBeGreaterThan(0)
  })

  it('always stamps the latest call id as the source', () => {
    const progress = progressFor({ momentum: 20 }, 'momentum')
    const next = selectFocusSkill(progress, null, minimalReport, 'call-6', '2026-01-06T00:00:00Z')
    expect(next.sourceCallId).toBe('call-6')
  })

  it('never throws when given an empty progress array', () => {
    expect(() =>
      selectFocusSkill([], null, minimalReport, 'call-7', '2026-01-07T00:00:00Z')
    ).not.toThrow()
  })
})
