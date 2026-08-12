import { describe, expect, it } from 'vitest'
import { verifyEvidenceQuote, verifyAndBuild, type RawCandidate } from '../extraction'
import { clientScope } from '../types'

describe('verifyEvidenceQuote', () => {
  const source = 'I always struggle when they bring up competitors directly on a call.'

  it('accepts a genuinely-present, substantial quote', () => {
    expect(verifyEvidenceQuote('I always struggle when they bring up competitors', source)).toBe(true)
  })

  it('rejects a bare/minimal quote — same class of gap as the contact-intelligence bug', () => {
    expect(verifyEvidenceQuote('struggle', source)).toBe(false)
    expect(verifyEvidenceQuote('they bring', source)).toBe(false)
  })

  it('rejects a quote that was never actually said', () => {
    expect(verifyEvidenceQuote('I love talking about pricing on every call', source)).toBe(false)
  })

  it('is case-insensitive and whitespace-tolerant', () => {
    expect(verifyEvidenceQuote('I ALWAYS   struggle when they bring up competitors', source)).toBe(true)
  })

  it('rejects an empty quote', () => {
    expect(verifyEvidenceQuote('', source)).toBe(false)
  })
})

describe('verifyAndBuild — the extraction guardrails', () => {
  const source = "I always struggle when they bring up competitors directly on a call, it throws me off."

  function candidate(overrides: Partial<RawCandidate> = {}): RawCandidate {
    return {
      scopeKind: 'rep',
      category: 'stated-struggle',
      statement: 'Struggles when competitors are brought up mid-call',
      quote: 'I always struggle when they bring up competitors directly on a call',
      confidence: 0.9,
      importance: 6,
      ...overrides
    }
  }

  it('accepts a well-formed, grounded, category-consistent candidate', () => {
    const result = verifyAndBuild(candidate(), source, null)
    expect(result).not.toBeNull()
    expect(result?.scope).toBe('rep')
    expect(result?.category).toBe('stated-struggle')
    expect(result?.source).toBe('auto')
  })

  it('rejects a category outside the fixed allowlist', () => {
    expect(verifyAndBuild(candidate({ category: 'medical-condition' }), source, null)).toBeNull()
  })

  it('rejects when category and scopeKind contradict each other', () => {
    // 'stated-struggle' belongs to 'rep', not 'business' — a model claiming
    // both is self-contradictory, dropped rather than guessed at.
    expect(verifyAndBuild(candidate({ scopeKind: 'business' }), source, null)).toBeNull()
  })

  it('rejects a client-scope candidate when there is no real contact to attach it to', () => {
    const result = verifyAndBuild(
      candidate({ scopeKind: 'client', category: 'client-fact' }),
      'The client mentioned they use Salesforce today.',
      null
    )
    expect(result).toBeNull()
  })

  it('accepts a client-scope candidate and resolves it to the real contact scope', () => {
    const result = verifyAndBuild(
      candidate({
        scopeKind: 'client',
        category: 'client-fact',
        statement: 'Currently uses Salesforce',
        quote: 'The client mentioned they use Salesforce today'
      }),
      'The client mentioned they use Salesforce today.',
      'contact-123'
    )
    expect(result?.scope).toBe(clientScope('contact-123'))
  })

  it('rejects an ungrounded quote (the core anti-hallucination check)', () => {
    expect(verifyAndBuild(candidate({ quote: 'This exact sentence was never said' }), source, null)).toBeNull()
  })

  it('rejects a bare-name-style minimal quote', () => {
    expect(verifyAndBuild(candidate({ quote: 'struggle' }), source, null)).toBeNull()
  })

  it('rejects a missing statement or quote', () => {
    expect(verifyAndBuild(candidate({ statement: '' }), source, null)).toBeNull()
    expect(verifyAndBuild(candidate({ quote: '' }), source, null)).toBeNull()
  })

  it('clamps confidence to [0,1] and importance to [1,10]', () => {
    const result = verifyAndBuild(candidate({ confidence: 5, importance: 99 }), source, null)
    expect(result?.confidence).toBe(1)
    expect(result?.importance).toBe(10)
  })

  it('never extracts anything framed as personal/health/emotional state, per the category allowlist', () => {
    // There is no category for this in MEMORY_CATEGORIES at all — the
    // allowlist itself is the guardrail (spec section 5), so any attempt to
    // claim one is simply not a recognized category and gets dropped here
    // the same way a truly invalid category would.
    expect(
      verifyAndBuild(
        candidate({ category: 'emotional-state', statement: 'Seems anxious about quota' }),
        'The rep sounded anxious about hitting quota this month.',
        null
      )
    ).toBeNull()
  })
})
