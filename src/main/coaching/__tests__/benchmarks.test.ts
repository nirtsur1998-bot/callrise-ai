import { describe, expect, it } from 'vitest'
import {
  computeBuyerEngagement,
  computePricingSignal,
  computeQuestionSpread,
  detectCallType,
  nextStepsLocked
} from '../benchmarks'
import type { CallSegment, Commitment } from '../../calls-fs'

const seg = (speaker: number, text: string): CallSegment => ({ speaker, text })

describe('detectCallType', () => {
  it('detects demo from the title', () => {
    expect(detectCallType('Product Demo with Acme')).toBe('demo')
  })
  it('detects cold-call from the title', () => {
    expect(detectCallType('Cold call — Acme prospecting')).toBe('cold-call')
  })
  it('detects closing from the title', () => {
    expect(detectCallType('Contract negotiation call')).toBe('closing')
  })
  it('defaults to discovery when nothing matches', () => {
    expect(detectCallType('Call with Sarah')).toBe('discovery')
  })
  it('defaults to discovery for an empty/undefined title', () => {
    expect(detectCallType(undefined)).toBe('discovery')
    expect(detectCallType('')).toBe('discovery')
  })
})

describe('computeQuestionSpread', () => {
  it('reports null evenness with too few questions to say anything', () => {
    const segments = [seg(0, 'How are you?'), seg(1, 'Good.')]
    const result = computeQuestionSpread(segments, 0)
    expect(result.count).toBe(1)
    expect(result.evenness).toBeNull()
  })

  it('scores high evenness when questions are spread across all three thirds', () => {
    // 9 rep turns, one question in each of turns 1, 4, 7 — one per third.
    const segments: CallSegment[] = []
    for (let i = 0; i < 9; i++) {
      const text = i === 0 || i === 4 || i === 7 ? 'What matters here?' : 'ok, got it'
      segments.push(seg(0, text))
      segments.push(seg(1, 'mhm')) // breaks turn merging
    }
    const result = computeQuestionSpread(segments, 0)
    expect(result.count).toBe(3)
    expect(result.evenness).not.toBeNull()
    expect(result.evenness as number).toBeGreaterThan(0.8)
  })

  it('scores low evenness when every question is front-loaded', () => {
    const segments: CallSegment[] = []
    for (let i = 0; i < 9; i++) {
      const text = i < 3 ? 'What about this?' : 'ok, got it'
      segments.push(seg(0, text))
      segments.push(seg(1, 'mhm'))
    }
    const result = computeQuestionSpread(segments, 0)
    expect(result.count).toBe(3)
    expect(result.evenness as number).toBeLessThan(0.5)
  })

  it('is empty-safe when the rep never spoke', () => {
    const result = computeQuestionSpread([seg(1, 'hello?')], 0)
    expect(result.count).toBe(0)
    expect(result.evenness).toBeNull()
  })

  it('never counts a buyer-tagged question as the reps, even when repSpeaker is unresolved', () => {
    // Regression test: repSpeaker null used to make this function treat
    // EVERY turn (including the buyer's) as the rep's.
    const segments: CallSegment[] = [
      { speaker: 0, text: 'what brings you in today?', role: 'rep' },
      { speaker: 1, text: 'what do you mean, is this a demo?', role: 'other' }
    ]
    const result = computeQuestionSpread(segments, null)
    // Only the rep's own question counts (1) — the buyer's question must
    // NOT be folded in just because repSpeaker is unresolved.
    expect(result.count).toBe(1)
  })
})

describe('computeBuyerEngagement', () => {
  it('counts buyer questions and longest buyer monologue, excluding the rep', () => {
    const segments = [
      seg(0, 'Tell me about your process'),
      seg(1, 'Well we currently use a spreadsheet and it is quite painful honestly'),
      seg(0, 'I see'),
      seg(1, 'What would you recommend?')
    ]
    const result = computeBuyerEngagement(segments, 0)
    expect(result.questionCount).toBe(1)
    expect(result.longestMonologueWords).toBe(12)
  })

  it('still classifies correctly by ROLE tag even when repSpeaker is unresolved (e.g. ambiguous across a reconnect)', () => {
    // isRepSegment trusts a turn's own recorded `role` before ever
    // consulting `repSpeaker` — repSpeaker being null (unresolved) must not
    // make a role-tagged buyer turn get treated as the rep's.
    const segments: CallSegment[] = [
      { speaker: 0, text: 'tell me more', role: 'rep' },
      { speaker: 1, text: 'sure, what do you want to know?', role: 'other' }
    ]
    const result = computeBuyerEngagement(segments, null)
    expect(result.questionCount).toBe(1)
    expect(result.longestMonologueWords).toBeGreaterThan(0)
  })

  it('falls back to counting every turn as buyer-side when there is neither a role tag nor a resolved repSpeaker (very old, pre-role calls)', () => {
    // No role field and repSpeaker null: isRepSegment can't identify the
    // rep at all, so nothing is excluded as "the rep's words" — the same
    // graceful-degradation direction coach.ts's own computeMetrics takes
    // for question counting when repSpeaker is unidentified.
    const result = computeBuyerEngagement([seg(0, 'hi'), seg(1, 'hi?')], null)
    expect(result.questionCount).toBe(1)
    expect(result.longestMonologueWords).toBeGreaterThan(0)
  })
})

describe('computePricingSignal', () => {
  it('counts buyer-side pricing mentions and their position', () => {
    const segments: CallSegment[] = [
      seg(0, 'so tell me about your team'),
      seg(1, 'we are a team of ten'),
      seg(0, 'got it, and your goals'),
      seg(1, 'grow revenue this year'),
      seg(0, 'makes sense'),
      seg(1, 'whats the pricing on this'), // back half
      seg(0, 'let me explain'),
      seg(1, 'and whats the cost per seat') // back half
    ]
    const result = computePricingSignal(segments, 0)
    expect(result.buyerMentions).toBe(2)
    expect(result.latePct).toBe(1) // both mentions landed in the back half
  })

  it('never counts a rep-side mention', () => {
    const segments = [seg(0, 'our pricing starts at $99'), seg(1, 'ok noted')]
    const result = computePricingSignal(segments, 0)
    expect(result.buyerMentions).toBe(0)
    expect(result.latePct).toBeNull()
  })

  it('never counts a role-tagged rep mention, even when repSpeaker is unresolved', () => {
    // Regression test: repSpeaker null used to make this function skip NO
    // segment at all, folding the rep's own pricing statements into
    // buyerMentions.
    const segments: CallSegment[] = [
      { speaker: 0, text: 'our pricing starts at $99 per seat', role: 'rep' },
      { speaker: 1, text: 'ok noted, thanks', role: 'other' }
    ]
    const result = computePricingSignal(segments, null)
    expect(result.buyerMentions).toBe(0)
  })

  it('is empty-safe for an empty transcript', () => {
    expect(computePricingSignal([], 0)).toEqual({ buyerMentions: 0, latePct: null })
  })
})

describe('nextStepsLocked', () => {
  it('is true when a commitment has a due date', () => {
    const commitments: Commitment[] = [{ owner: 'rep', text: 'send proposal', dueDate: '2026-09-01' }]
    expect(nextStepsLocked('I will follow up', commitments)).toBe(true)
  })

  it('is true when the next-action text itself names a concrete date/day', () => {
    expect(nextStepsLocked('Send the contract by Friday')).toBe(true)
    expect(nextStepsLocked('Follow up next Tuesday')).toBe(true)
  })

  it('is false for a vague next action with no commitments', () => {
    expect(nextStepsLocked('I will follow up soon')).toBe(false)
  })
})
