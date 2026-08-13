// BUG-057 Phase 2 — classifyFailureClass/looksLikeQuotaExhaustion are pure
// functions (no SDK, no provider) so these are direct unit tests, no mocking
// needed. Provider-level tests that prove the classifier is actually WIRED
// into a real adapter's error construction live in realSdkRetryAndCooldown
// test's sibling assertions, not here — this file only tests the function
// itself.
import { describe, expect, it } from 'vitest'
import { classifyFailureClass, looksLikeQuotaExhaustion } from '../failure-class'

describe('looksLikeQuotaExhaustion', () => {
  it.each(['quota', 'billing', 'credit'])('matches the keyword "%s" case-insensitively', (keyword) => {
    expect(looksLikeQuotaExhaustion(`You have exceeded your ${keyword.toUpperCase()} limit.`)).toBe(true)
  })

  it('does not match an ordinary rate-limit message', () => {
    expect(looksLikeQuotaExhaustion('Rate limit exceeded, please try again in a moment.')).toBe(false)
  })

  it('does not match an empty message', () => {
    expect(looksLikeQuotaExhaustion('')).toBe(false)
  })
})

describe('classifyFailureClass', () => {
  it('network -> transient', () => {
    expect(classifyFailureClass('network', { message: '' })).toBe('transient')
  })

  it('timeout -> transient', () => {
    expect(classifyFailureClass('timeout', { message: '' })).toBe('transient')
  })

  it('auth -> structural (never succeeds until the key changes)', () => {
    expect(classifyFailureClass('auth', { message: '' })).toBe('structural')
  })

  it('model-not-found -> structural (a delisted model will not appear)', () => {
    expect(classifyFailureClass('model-not-found', { message: '' })).toBe('structural')
  })

  describe('rate-limit', () => {
    it('an ordinary throttle with no quota language -> transient', () => {
      expect(classifyFailureClass('rate-limit', { message: 'Too many requests, slow down.' })).toBe(
        'transient'
      )
    })

    it('a 429 whose body mentions quota/billing -> period-exhausted, not transient', () => {
      // The exact gap this phase closes: previously the RateLimitError
      // branch never checked quota language at all, so this indistinguishable
      // from a 10-second throttle.
      expect(
        classifyFailureClass('rate-limit', {
          message: 'You have exceeded your current quota, please check your plan and billing details.'
        })
      ).toBe('period-exhausted')
    })
  })

  describe('failed (the generic bucket)', () => {
    it('a message mentioning quota/credit wins even with no status', () => {
      expect(classifyFailureClass('failed', { message: 'Your account is out of credits.' })).toBe(
        'period-exhausted'
      )
    })

    it('status >= 500 -> transient (server-side hiccup, not our request\'s fault)', () => {
      expect(classifyFailureClass('failed', { message: '', status: 500 })).toBe('transient')
      expect(classifyFailureClass('failed', { message: '', status: 503 })).toBe('transient')
    })

    it('status >= 400 and < 500 -> structural (this exact request is rejected)', () => {
      expect(classifyFailureClass('failed', { message: '', status: 400 })).toBe('structural')
      expect(classifyFailureClass('failed', { message: '', status: 422 })).toBe('structural')
    })

    it('no status, no quota keyword -> transient (the ambiguous default, NOT structural)', () => {
      // This is the exact case CHANGES FROM FIRST PASS #2 found backwards:
      // the first pass defaulted an unclassifiable error to 'structural',
      // which — given markStructurallyBroken's original permanent-map shape
      // — meant a low-confidence guess could permanently blacklist a model.
      // The fix makes the ambiguous default the class that self-heals
      // fastest even on a wrong guess.
      expect(classifyFailureClass('failed', { message: 'Something went wrong.' })).toBe('transient')
      expect(classifyFailureClass('failed', { message: '' })).toBe('transient')
    })
  })
})
