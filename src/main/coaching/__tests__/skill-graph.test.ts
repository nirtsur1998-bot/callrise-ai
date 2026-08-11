import { describe, expect, it } from 'vitest'
import { computeSkillProgress, computeSkillScores, SKILL_TARGET } from '../skill-graph'
import type { CoachDimension, CoachMetrics } from '../../calls-fs'
import type { BenchmarkSnapshot } from '../benchmarks'

const dims = (overrides: Partial<Record<CoachDimension['key'], number>>): CoachDimension[] =>
  (['discovery', 'engagement', 'objection', 'value', 'nextStep', 'control'] as const).map((key) => ({
    key,
    score: overrides[key] ?? 3,
    comment: ''
  }))

const baseMetrics: CoachMetrics = {
  repSpeaker: 0,
  singleSpeaker: false,
  talkRatio: 0.43,
  repWords: 430,
  totalWords: 1000,
  longestMonologueWords: 50,
  longestMonologueMinutes: 1,
  questionCount: 12,
  wordsPerMinute: 130,
  turns: 40
}

const baseBenchmark: BenchmarkSnapshot = {
  callType: 'discovery',
  questionSpread: { count: 12, evenness: 0.8 },
  buyerEngagement: { questionCount: 5, longestMonologueWords: 80 },
  pricing: { buyerMentions: 3, latePct: 0.6 },
  nextStepsLocked: true,
  durationMinutes: 45
}

describe('computeSkillScores', () => {
  it('produces all 8 skills, each within 0-100', () => {
    const scores = computeSkillScores(dims({}), baseMetrics, baseBenchmark)
    for (const key of Object.keys(scores) as (keyof typeof scores)[]) {
      expect(scores[key]).toBeGreaterThanOrEqual(0)
      expect(scores[key]).toBeLessThanOrEqual(100)
    }
  })

  it('scores listening at 100 when the rep talks at or under the call-type target', () => {
    const scores = computeSkillScores(
      dims({}),
      { ...baseMetrics, talkRatio: 0.4 }, // discovery target is 43%
      baseBenchmark
    )
    expect(scores.listening).toBe(100)
  })

  it('penalizes listening the further the rep talks past the target', () => {
    const over = computeSkillScores(dims({}), { ...baseMetrics, talkRatio: 0.5 }, baseBenchmark)
    const wayOver = computeSkillScores(dims({}), { ...baseMetrics, talkRatio: 0.6 }, baseBenchmark)
    expect(over.listening).toBeGreaterThan(wayOver.listening)
  })

  it('treats no pricing mentions as neutral (50), not a penalty', () => {
    const scores = computeSkillScores(dims({}), baseMetrics, {
      ...baseBenchmark,
      pricing: { buyerMentions: 0, latePct: null }
    })
    expect(scores.pricing).toBe(50)
  })

  it('rewards the healthy 3-4 pricing-mention zone', () => {
    const healthy = computeSkillScores(dims({}), baseMetrics, {
      ...baseBenchmark,
      pricing: { buyerMentions: 3, latePct: null },
      durationMinutes: 10 // short call — timing shouldn't matter
    })
    const excessive = computeSkillScores(dims({}), baseMetrics, {
      ...baseBenchmark,
      pricing: { buyerMentions: 12, latePct: null },
      durationMinutes: 10
    })
    expect(healthy.pricing).toBeGreaterThan(excessive.pricing)
  })

  it('boosts momentum when next steps were locked, penalizes when not', () => {
    const locked = computeSkillScores(dims({ nextStep: 3 }), baseMetrics, {
      ...baseBenchmark,
      nextStepsLocked: true
    })
    const notLocked = computeSkillScores(dims({ nextStep: 3 }), baseMetrics, {
      ...baseBenchmark,
      nextStepsLocked: false
    })
    expect(locked.momentum).toBeGreaterThan(notLocked.momentum)
  })

  it('uses the explicit methodology assessment when provided', () => {
    const scores = computeSkillScores(dims({}), baseMetrics, baseBenchmark, {
      methodology: 'meddic',
      score: 5,
      comment: ''
    })
    expect(scores.methodology).toBe(100)
  })

  it('falls back to a discovery/value blend when no methodology assessment is provided', () => {
    const scores = computeSkillScores(dims({ discovery: 5, value: 5 }), baseMetrics, baseBenchmark)
    expect(scores.methodology).toBe(100)
  })

  it('reads objection/value straight from their rubric dimensions', () => {
    const scores = computeSkillScores(dims({ objection: 5, value: 1 }), baseMetrics, baseBenchmark)
    expect(scores.objectionHandling).toBe(100)
    expect(scores.valueArticulation).toBe(20)
  })

  it('rewards a discovery question count inside the 11-14 healthy zone', () => {
    const inZone = computeSkillScores(dims({}), baseMetrics, {
      ...baseBenchmark,
      questionSpread: { count: 12, evenness: null }
    })
    const wayUnder = computeSkillScores(dims({}), baseMetrics, {
      ...baseBenchmark,
      questionSpread: { count: 2, evenness: null }
    })
    expect(inZone.discovery).toBeGreaterThan(wayUnder.discovery)
  })

  it('penalizes listening once the rep monologue crosses the flag threshold', () => {
    const short = computeSkillScores(dims({}), { ...baseMetrics, longestMonologueMinutes: 1 }, baseBenchmark)
    const long = computeSkillScores(dims({}), { ...baseMetrics, longestMonologueMinutes: 2 }, baseBenchmark) // 120s > 90s flag
    expect(long.listening).toBeLessThan(short.listening)
  })

  it('boosts rapport when the buyer was genuinely engaged (asked questions, got real airtime)', () => {
    const engaged = computeSkillScores(dims({ engagement: 3 }), baseMetrics, {
      ...baseBenchmark,
      buyerEngagement: { questionCount: 4, longestMonologueWords: 60 }
    })
    const checkedOut = computeSkillScores(dims({ engagement: 3 }), baseMetrics, {
      ...baseBenchmark,
      buyerEngagement: { questionCount: 0, longestMonologueWords: 5 }
    })
    expect(engaged.rapport).toBeGreaterThan(checkedOut.rapport)
  })
})

describe('computeSkillProgress', () => {
  const call = (id: string, createdAt: string, discovery: number) => ({
    id,
    createdAt,
    skills: {
      discovery,
      listening: 50,
      objectionHandling: 50,
      valueArticulation: 50,
      pricing: 50,
      momentum: 50,
      rapport: 50,
      methodology: 50
    }
  })

  it('ignores calls with no skills set', () => {
    const progress = computeSkillProgress([
      { id: 'a', createdAt: '2026-01-01T00:00:00Z' }, // no skills
      call('b', '2026-01-02T00:00:00Z', 70)
    ])
    const discovery = progress.find((p) => p.key === 'discovery')!
    expect(discovery.history).toHaveLength(1)
  })

  it('computes a trend from a balanced 1-vs-1 window with just 2 calls (not null)', () => {
    const progress = computeSkillProgress([
      call('1', '2026-01-01T00:00:00Z', 40),
      call('2', '2026-01-02T00:00:00Z', 90)
    ])
    expect(progress.find((p) => p.key === 'discovery')!.trend).toBe('up')
  })

  it('sorts history chronologically regardless of input order', () => {
    const progress = computeSkillProgress([
      call('later', '2026-01-05T00:00:00Z', 80),
      call('earlier', '2026-01-01T00:00:00Z', 60)
    ])
    const discovery = progress.find((p) => p.key === 'discovery')!
    expect(discovery.history.map((h) => h.callId)).toEqual(['earlier', 'later'])
    expect(discovery.current).toBe(80)
  })

  it('computes an up trend when recent calls clearly beat prior ones', () => {
    const progress = computeSkillProgress([
      call('1', '2026-01-01T00:00:00Z', 40),
      call('2', '2026-01-02T00:00:00Z', 42),
      call('3', '2026-01-03T00:00:00Z', 80),
      call('4', '2026-01-04T00:00:00Z', 82),
      call('5', '2026-01-05T00:00:00Z', 85)
    ])
    expect(progress.find((p) => p.key === 'discovery')!.trend).toBe('up')
  })

  it('counts a streak of consecutive calls at/above SKILL_TARGET', () => {
    const progress = computeSkillProgress([
      call('1', '2026-01-01T00:00:00Z', 40),
      call('2', '2026-01-02T00:00:00Z', SKILL_TARGET),
      call('3', '2026-01-03T00:00:00Z', SKILL_TARGET + 5),
      call('4', '2026-01-04T00:00:00Z', SKILL_TARGET + 10)
    ])
    expect(progress.find((p) => p.key === 'discovery')!.streakAboveTarget).toBe(3)
  })

  it('resets the streak the moment a call drops below target', () => {
    const progress = computeSkillProgress([
      call('1', '2026-01-01T00:00:00Z', SKILL_TARGET + 5),
      call('2', '2026-01-02T00:00:00Z', SKILL_TARGET - 5)
    ])
    expect(progress.find((p) => p.key === 'discovery')!.streakAboveTarget).toBe(0)
  })
})
