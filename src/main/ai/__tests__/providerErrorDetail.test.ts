// BUG-057 — a provider's own explanation of WHY it rejected a request must
// survive into the error we log.
//
// This mapping used to collapse every non-429/404 APIError to
// "<provider> returned an error (400)." and discard err.message. The result:
// two days of chain-exhaustion logs that recorded, 71 times, that two
// different providers rejected the request — and not one word about why. The
// same class of loss as the bug this milestone is about: the information
// existed and was thrown away before it could reach anyone.
import { describe, expect, it } from 'vitest'
import { APIError } from 'openai'
import { retryAfterMsFrom, toProviderError } from '../providers/openai-compatible'
import { parseGeminiRetryDelayMs } from '../providers/gemini'

function apiError(status: number, message: string): APIError {
  // The SDK populates .message from the provider's response body.
  return new APIError(status, undefined, message, undefined)
}

describe('toProviderError keeps the provider\'s own message', () => {
  it('a 400 carries the real reason, not just the status code', () => {
    const err = toProviderError(
      'Groq',
      apiError(400, 'tool_use_failed: Failed to call a function. Please adjust your prompt.')
    )
    expect(err.code).toBe('failed')
    expect(err.message).toContain('400')
    // The part that was missing for two days.
    expect(err.message).toContain('tool_use_failed')
  })

  it('still names the provider and status when the body carried no explanation', () => {
    // The SDK never hands back a truly empty message — with no response body
    // it synthesizes its own ("400 status code (no body)"), which is itself
    // worth keeping: "the provider returned 400 and said nothing" is a
    // materially different diagnosis from "the provider explained itself".
    const err = toProviderError('OpenRouter', apiError(400, ''))
    expect(err.message).toContain('OpenRouter')
    expect(err.message).toContain('400')
  })

  it('long provider messages are bounded, not dumped whole into the log', () => {
    const err = toProviderError('Groq', apiError(400, 'x'.repeat(5000)))
    expect(err.message.length).toBeLessThan(400)
  })

  it('the classified codes are unchanged — only the message got richer', () => {
    // These branches return before the message-preserving one; pinning them
    // stops a future edit from accidentally reclassifying a rate limit as a
    // generic failure, which is what the fallback logic keys off.
    expect(toProviderError('Groq', apiError(429, 'slow down')).code).toBe('rate-limit')
    expect(toProviderError('Groq', apiError(404, 'no such model')).code).toBe('model-not-found')
    expect(toProviderError('Groq', apiError(400, 'You are out of credits')).code).toBe('failed')
    expect(toProviderError('Groq', apiError(400, 'You are out of credits')).message).toContain(
      'quota/credits'
    )
  })
})

// ---------------------------------------------------------------------------

describe('BUG-058 — providers\' own "come back in N seconds" is now read', () => {
  it('reads retry-after-ms in preference to retry-after', () => {
    const err = Object.assign(new Error('limited'), {
      headers: { 'retry-after-ms': '2500', 'retry-after': '99' }
    })
    expect(retryAfterMsFrom(err)).toBe(2500)
  })

  it('reads retry-after in seconds', () => {
    expect(retryAfterMsFrom(Object.assign(new Error('x'), { headers: { 'retry-after': '20' } }))).toBe(20_000)
  })

  it('is undefined when the provider said nothing — callers use their own default', () => {
    expect(retryAfterMsFrom(Object.assign(new Error('x'), { headers: {} }))).toBeUndefined()
    expect(retryAfterMsFrom(new Error('x'))).toBeUndefined()
  })

  it('parses Gemini\'s RetryInfo.retryDelay, which lives in the BODY not a header', () => {
    // Gemini is the first entry in the quality chain and had zero backoff of
    // any kind, so this hint mattered more here than anywhere else.
    const body = {
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.QuotaFailure' },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '23s' }
        ]
      }
    }
    expect(parseGeminiRetryDelayMs(body)).toBe(23_000)
  })

  it('handles fractional Gemini delays and ignores malformed ones', () => {
    expect(parseGeminiRetryDelayMs({ error: { details: [{ retryDelay: '1.5s' }] } })).toBe(1500)
    expect(parseGeminiRetryDelayMs({ error: { details: [{ retryDelay: 'soon' }] } })).toBeUndefined()
    expect(parseGeminiRetryDelayMs({ error: {} })).toBeUndefined()
    expect(parseGeminiRetryDelayMs(null)).toBeUndefined()
  })
})
