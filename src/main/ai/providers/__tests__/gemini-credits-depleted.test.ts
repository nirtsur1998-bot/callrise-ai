// BUG-197 (2026-09-06) — a Google AI Studio project with no prepaid credit
// answers 429 RESOURCE_EXHAUSTED with "Your prepayment credits are depleted.
// Please go to AI Studio at https://ai.studio/projects to manage your project
// and billing." The classifier already read that as period-exhausted, but the
// adapter replaced Google's sentence with "Gemini is rate-limiting requests
// right now." — so the founder waited for a reset that cannot come. The copy
// now says what Google said and what fixes it; the class is unchanged.
import { describe, expect, it } from 'vitest'
import { looksLikeCreditsDepleted, toProviderError } from '../gemini'

const google429 = (message: string): Response =>
  new Response(JSON.stringify({ error: { code: 429, message, status: 'RESOURCE_EXHAUSTED' } }), {
    status: 429,
    headers: { 'content-type': 'application/json' }
  })

describe('Gemini 429 copy (BUG-197)', () => {
  it('"prepayment credits are depleted" → names the cause and the fix, and is not called a rate limit', async () => {
    const err = await toProviderError(
      'Gemini',
      google429(
        'Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing. Learn more at https://ai.google.dev/gemini-api/docs/billing#prepay. '
      )
    )
    expect(err.code).toBe('rate-limit') // the chain's handling of the class is unchanged
    expect(err.failureClass).toBe('period-exhausted')
    expect(err.message).toContain('no prepaid credit left')
    expect(err.message).toContain('ai.studio/projects')
    expect(err.message).toContain('waiting will not clear it')
    expect(err.message).not.toContain('is rate-limiting requests right now')
  })

  it('an ordinary quota 429 keeps the generic copy and its period-exhausted class', async () => {
    const err = await toProviderError('Gemini', google429('Resource has been exhausted (e.g. check quota).'))
    expect(err.code).toBe('rate-limit')
    expect(err.failureClass).toBe('period-exhausted')
    expect(err.message).toBe('Gemini is rate-limiting requests right now.')
  })

  it('a per-minute throttle keeps the generic copy and is transient', async () => {
    const err = await toProviderError('Gemini', google429('Too many requests, slow down.'))
    expect(err.code).toBe('rate-limit')
    expect(err.failureClass).toBe('transient')
    expect(err.message).toBe('Gemini is rate-limiting requests right now.')
  })

  it('the keyword check matches Google\'s wording and its likely rewordings, and nothing else', () => {
    expect(looksLikeCreditsDepleted('Your prepayment credits are depleted.')).toBe(true)
    expect(looksLikeCreditsDepleted('No prepayment credit remains on this project')).toBe(true)
    expect(looksLikeCreditsDepleted('Resource has been exhausted (e.g. check quota).')).toBe(false)
    expect(looksLikeCreditsDepleted('')).toBe(false)
  })
})
