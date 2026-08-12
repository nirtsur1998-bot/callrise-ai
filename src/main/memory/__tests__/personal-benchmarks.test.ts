import { describe, expect, it } from 'vitest'
import {
  MIN_SAMPLE_SIZE,
  computePersonalQuestionTarget,
  computePersonalTalkRatioTarget
} from '../personal-benchmarks'

const POPULATION_DEFAULT = { repTargetPct: 43, warnAbovePct: 65 }

describe('computePersonalTalkRatioTarget — the "never confidently wrong from too few calls" guardrail', () => {
  it('returns null with fewer than MIN_SAMPLE_SIZE real samples', () => {
    const samples = Array.from({ length: MIN_SAMPLE_SIZE - 1 }, () => ({ talkRatio: 0.5 }))
    expect(computePersonalTalkRatioTarget(samples, POPULATION_DEFAULT)).toBeNull()
  })

  it('returns a personalized target once there are enough samples', () => {
    const samples = Array.from({ length: MIN_SAMPLE_SIZE }, () => ({ talkRatio: 0.3 }))
    const result = computePersonalTalkRatioTarget(samples, POPULATION_DEFAULT)
    expect(result).not.toBeNull()
    expect(result?.repTargetPct).toBe(30)
  })

  it('preserves the population default\'s MARGIN above target, not a re-derived one', () => {
    const samples = Array.from({ length: MIN_SAMPLE_SIZE }, () => ({ talkRatio: 0.3 }))
    const result = computePersonalTalkRatioTarget(samples, POPULATION_DEFAULT)
    const populationMargin = POPULATION_DEFAULT.warnAbovePct - POPULATION_DEFAULT.repTargetPct
    expect(result!.warnAbovePct - result!.repTargetPct).toBe(populationMargin)
  })

  it('ignores null talkRatio samples (uncoached/unscored calls) when counting toward the minimum', () => {
    const samples = [
      ...Array.from({ length: MIN_SAMPLE_SIZE - 1 }, () => ({ talkRatio: 0.4 })),
      { talkRatio: null },
      { talkRatio: null }
    ]
    // Only MIN_SAMPLE_SIZE - 1 real samples exist, despite the array being longer.
    expect(computePersonalTalkRatioTarget(samples, POPULATION_DEFAULT)).toBeNull()
  })

  it('averages across real samples correctly', () => {
    const samples = [
      { talkRatio: 0.2 },
      { talkRatio: 0.4 },
      { talkRatio: 0.3 },
      { talkRatio: 0.3 },
      { talkRatio: 0.3 }
    ]
    const result = computePersonalTalkRatioTarget(samples, POPULATION_DEFAULT)
    expect(result?.repTargetPct).toBe(30)
  })
})

describe('computePersonalQuestionTarget', () => {
  it('returns null with fewer than MIN_SAMPLE_SIZE samples', () => {
    const samples = Array.from({ length: MIN_SAMPLE_SIZE - 1 }, () => ({ count: 12 }))
    expect(computePersonalQuestionTarget(samples)).toBeNull()
  })

  it('builds a narrow band around the personal median, not the full range', () => {
    const samples = [{ count: 5 }, { count: 8 }, { count: 8 }, { count: 8 }, { count: 20 }]
    const result = computePersonalQuestionTarget(samples)
    expect(result).toEqual({ min: 6, max: 10 })
  })

  it('never returns a negative minimum', () => {
    const samples = [{ count: 0 }, { count: 0 }, { count: 0 }, { count: 1 }, { count: 1 }]
    const result = computePersonalQuestionTarget(samples)
    expect(result!.min).toBeGreaterThanOrEqual(0)
  })
})
