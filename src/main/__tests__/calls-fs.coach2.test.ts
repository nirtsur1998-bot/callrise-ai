import { describe, expect, it } from 'vitest'
import { sanitizeCoaching, type CallSegment } from '../calls-fs'

const segments: CallSegment[] = [
  { speaker: 0, text: 'So tell me about your current process', role: 'rep' },
  { speaker: 1, text: 'We use a spreadsheet honestly', role: 'other' },
  { speaker: 0, text: 'Got it, and whats your budget range', role: 'rep' },
  { speaker: 1, text: 'Somewhere around ten thousand', role: 'other' }
]

const sixDimensions = [
  { key: 'discovery', score: 4, comment: 'good', evidence: undefined },
  { key: 'engagement', score: 3, comment: 'ok', evidence: undefined },
  { key: 'objection', score: 3, comment: 'ok', evidence: undefined },
  { key: 'value', score: 4, comment: 'good', evidence: undefined },
  { key: 'nextStep', score: 2, comment: 'vague', evidence: undefined },
  { key: 'control', score: 3, comment: 'ok', evidence: undefined }
]

function baseRawReport(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    overallScore: 65,
    dealContext: { type: 'transactional', summary: '', lens: 'SPIN' },
    strength: { text: 'good rapport' },
    dimensions: sixDimensions,
    improvements: [],
    nextAction: 'Send a proposal by Friday',
    metrics: { repSpeaker: 0 },
    model: 'claude-test',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...extra
  }
}

const allSkills = {
  discovery: 70,
  listening: 60,
  objectionHandling: 55,
  valueArticulation: 80,
  pricing: 50,
  momentum: 40,
  rapport: 65,
  methodology: 60
}

describe('sanitizeCoaching — M23 backward compatibility', () => {
  it('sanitizes a pre-M23 report (no M23 fields at all) exactly as before, with every new field undefined', () => {
    const report = sanitizeCoaching(baseRawReport(), segments)
    expect(report).not.toBeNull()
    expect(report!.dimensions).toHaveLength(6)
    expect(report!.callType).toBeUndefined()
    expect(report!.skills).toBeUndefined()
    expect(report!.methodologyAdherence).toBeUndefined()
    expect(report!.focusSkillAtCoaching).toBeUndefined()
    // Regression test: the 6 new CoachMetrics sub-fields used to be
    // fabricated with default 0/null/false values on every save, even for
    // a report that never had them — silently growing the persisted shape
    // of every coached call regardless of the Coach 2.0 toggle.
    expect(Object.keys(report!.metrics).sort()).toEqual(
      [
        'repSpeaker',
        'singleSpeaker',
        'talkRatio',
        'repWords',
        'totalWords',
        'longestMonologueWords',
        'longestMonologueMinutes',
        'questionCount',
        'wordsPerMinute',
        'turns'
      ].sort()
    )
  })

  it('never lets a malformed M23 field null out the base six-dimension report', () => {
    const report = sanitizeCoaching(
      baseRawReport({ callType: 'not-a-real-type', skills: { discovery: 70 }, methodologyAdherence: 'nonsense' }),
      segments
    )
    expect(report).not.toBeNull()
    expect(report!.dimensions).toHaveLength(6) // the core gate is untouched
    expect(report!.callType).toBeUndefined() // invalid enum value dropped
    expect(report!.skills).toBeUndefined() // partial skill set dropped, not partially shown
    expect(report!.methodologyAdherence).toBeUndefined() // malformed shape dropped
  })
})

describe('sanitizeCoaching — M23 new fields', () => {
  it('round-trips a valid callType', () => {
    const report = sanitizeCoaching(baseRawReport({ callType: 'discovery' }), segments)
    expect(report!.callType).toBe('discovery')
  })

  it('round-trips the 6 new metrics sub-fields when the source actually has them', () => {
    const report = sanitizeCoaching(
      baseRawReport({
        metrics: {
          repSpeaker: 0,
          questionSpread: 0.7,
          buyerQuestionCount: 3,
          buyerLongestMonologueWords: 42,
          pricingMentions: 2,
          pricingMentionsLatePct: 0.5,
          nextStepsLocked: true
        }
      }),
      segments
    )
    expect(report!.metrics.questionSpread).toBe(0.7)
    expect(report!.metrics.buyerQuestionCount).toBe(3)
    expect(report!.metrics.buyerLongestMonologueWords).toBe(42)
    expect(report!.metrics.pricingMentions).toBe(2)
    expect(report!.metrics.pricingMentionsLatePct).toBe(0.5)
    expect(report!.metrics.nextStepsLocked).toBe(true)
  })

  it('round-trips a complete, valid skill set', () => {
    const report = sanitizeCoaching(baseRawReport({ skills: allSkills }), segments)
    expect(report!.skills).toEqual(allSkills)
  })

  it('clamps out-of-range skill scores into 0-100', () => {
    const report = sanitizeCoaching(
      baseRawReport({ skills: { ...allSkills, momentum: 150, pricing: -20 } }),
      segments
    )
    expect(report!.skills!.momentum).toBe(100)
    expect(report!.skills!.pricing).toBe(0)
  })

  it('keeps the methodology score even when its evidence is unverified, but only shows verified evidence (same leniency as a rubric dimension)', () => {
    const grounded = sanitizeCoaching(
      baseRawReport({
        methodologyAdherence: {
          methodology: 'meddic',
          score: 4,
          comment: 'surfaced budget',
          evidence: { quote: 'Somewhere around ten thousand', speaker: 1 }
        }
      }),
      segments
    )
    // evidence must be the REP's own words to verify (same rule as every
    // other evidence field) — speaker 1 is the buyer, so evidence is
    // dropped, but the score/comment survive (dimension-style leniency).
    expect(grounded!.methodologyAdherence?.methodology).toBe('meddic')
    expect(grounded!.methodologyAdherence?.score).toBe(4)
    expect(grounded!.methodologyAdherence?.evidence).toBeUndefined()

    const repGrounded = sanitizeCoaching(
      baseRawReport({
        methodologyAdherence: {
          methodology: 'meddic',
          score: 4,
          comment: 'asked about budget',
          evidence: { quote: 'whats your budget range', speaker: 0 }
        }
      }),
      segments
    )
    expect(repGrounded!.methodologyAdherence?.methodology).toBe('meddic')
    expect(repGrounded!.methodologyAdherence?.evidence?.verified).toBe(true)

    const ungrounded = sanitizeCoaching(
      baseRawReport({
        methodologyAdherence: {
          methodology: 'meddic',
          score: 4,
          comment: 'x',
          evidence: { quote: 'something never actually said', speaker: 0 }
        }
      }),
      segments
    )
    expect(ungrounded!.methodologyAdherence?.methodology).toBe('meddic')
    expect(ungrounded!.methodologyAdherence?.evidence).toBeUndefined()
  })

  it('round-trips focusSkillAtCoaching for a recognized skill key', () => {
    const report = sanitizeCoaching(
      baseRawReport({ focusSkillAtCoaching: { skill: 'pricing', microBehavior: 'ask about budget earlier' } }),
      segments
    )
    expect(report!.focusSkillAtCoaching).toEqual({
      skill: 'pricing',
      microBehavior: 'ask about budget earlier'
    })
  })

  it('drops focusSkillAtCoaching for an unrecognized skill key', () => {
    const report = sanitizeCoaching(
      baseRawReport({ focusSkillAtCoaching: { skill: 'not-a-skill', microBehavior: 'x' } }),
      segments
    )
    expect(report!.focusSkillAtCoaching).toBeUndefined()
  })
})
