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
import { APIError, RateLimitError } from 'openai'
import { RateLimitError as AnthropicRateLimitError } from '@anthropic-ai/sdk'
import { retryAfterMsFrom, toProviderError } from '../providers/openai-compatible'
import { toProviderError as anthropicToProviderError } from '../providers/anthropic'
import { parseGeminiRetryDelayMs } from '../providers/gemini'

function apiError(status: number, message: string): APIError {
  // The SDK populates .message from the provider's response body.
  return new APIError(status, undefined, message, undefined)
}

// A REAL 429 arrives as the SDK's own RateLimitError subclass (with a real
// Headers object), never the bare APIError apiError() above constructs —
// that distinction matters for BUG-058 Phase 3's resetsAt tests below,
// since toProviderError's RateLimitError branch (checked first, no
// keyword short-circuit) is what a genuine 429 actually goes through.
function rateLimitError(message: string, headers: Record<string, string> = {}): RateLimitError {
  return new RateLimitError(429, undefined, message, new Headers(headers))
}

function anthropicRateLimitError(
  message: string,
  headers: Record<string, string> = {}
): AnthropicRateLimitError {
  return new AnthropicRateLimitError(429, undefined, message, new Headers(headers))
}

describe('toProviderError keeps the provider\'s own message', () => {
  it('a 400 carries the real reason, not just the status code', () => {
    const err = toProviderError(
      'Groq',
      'groq',
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
    const err = toProviderError('OpenRouter', 'openrouter', apiError(400, ''))
    expect(err.message).toContain('OpenRouter')
    expect(err.message).toContain('400')
  })

  it('long provider messages are bounded, not dumped whole into the log', () => {
    const err = toProviderError('Groq', 'groq', apiError(400, 'x'.repeat(5000)))
    expect(err.message.length).toBeLessThan(400)
  })

  it('the classified codes are unchanged — only the message got richer', () => {
    // These branches return before the message-preserving one; pinning them
    // stops a future edit from accidentally reclassifying a rate limit as a
    // generic failure, which is what the fallback logic keys off.
    expect(toProviderError('Groq', 'groq', apiError(429, 'slow down')).code).toBe('rate-limit')
    expect(toProviderError('Groq', 'groq', apiError(404, 'no such model')).code).toBe('model-not-found')
    expect(toProviderError('Groq', 'groq', apiError(400, 'You are out of credits')).code).toBe('failed')
    expect(toProviderError('Groq', 'groq', apiError(400, 'You are out of credits')).message).toContain(
      'quota/credits'
    )
  })
})

describe('BUG-058 Phase 3 — resetsAt, real or documented-fixed-schedule only', () => {
  it('Groq: a period-exhausted rate-limit gets a computed next-UTC-midnight resetsAt', () => {
    // 'daily quota' in the message is what classifyFailureClass keys off to
    // call this period-exhausted rather than an ordinary per-minute 429. A
    // REAL 429 always arrives as the SDK's RateLimitError (see
    // rateLimitError() above), which toProviderError checks BEFORE the
    // generic APIError catch-all's own quota-keyword branch — so this must
    // construct a RateLimitError, not the bare-APIError apiError() helper,
    // or it would exercise the wrong branch (that keyword branch only ever
    // fires for a non-429 quota/credits message, e.g. a 400/403).
    const err = toProviderError('Groq', 'groq', rateLimitError('You have exceeded your daily quota'))
    expect(err.failureClass).toBe('period-exhausted')
    expect(err.resetsAt).toBeDefined()
    expect(new Date(err.resetsAt!).getUTCHours()).toBe(0)
    expect(err.resetsAt!).toBeGreaterThan(Date.now())
  })

  it('Groq: an ORDINARY rate-limit (not period-exhausted) gets no resetsAt at all', () => {
    const err = toProviderError('Groq', 'groq', rateLimitError('slow down'))
    expect(err.failureClass).not.toBe('period-exhausted')
    expect(err.resetsAt).toBeUndefined()
  })

  it('OpenRouter: a real X-RateLimit-Reset header is read directly, no computation', () => {
    const resetAt = Date.now() + 3_600_000
    const err = rateLimitError('You exceeded your daily quota', { 'x-ratelimit-reset': String(resetAt) })
    const mapped = toProviderError('OpenRouter', 'openrouter', err)
    expect(mapped.resetsAt).toBe(resetAt)
  })

  it('NVIDIA/Cerebras/Mistral: unconfirmed by research — resetsAt stays undefined even when period-exhausted', () => {
    for (const providerId of ['nvidia', 'cerebras', 'mistral'] as const) {
      const err = toProviderError(providerId, providerId, rateLimitError('daily quota exceeded'))
      expect(err.failureClass).toBe('period-exhausted')
      expect(err.resetsAt).toBeUndefined()
    }
  })

  it('Anthropic: a real anthropic-ratelimit-requests-reset header is read directly', () => {
    const resetAt = new Date(Date.now() + 3_600_000)
    const err = anthropicRateLimitError('You have exceeded your quota', {
      'anthropic-ratelimit-requests-reset': resetAt.toISOString()
    })
    const mapped = anthropicToProviderError(err)
    expect(mapped.failureClass).toBe('period-exhausted')
    expect(mapped.resetsAt).toBe(resetAt.getTime())
  })

  it('Anthropic: when BOTH reset headers are present, takes the LATER one — the block could be from either resource', () => {
    const earlier = new Date(Date.now() + 1_800_000)
    const later = new Date(Date.now() + 3_600_000)
    const err = anthropicRateLimitError('You have exceeded your quota', {
      'anthropic-ratelimit-requests-reset': earlier.toISOString(),
      'anthropic-ratelimit-tokens-reset': later.toISOString()
    })
    const mapped = anthropicToProviderError(err)
    expect(mapped.resetsAt).toBe(later.getTime())
  })

  it('Anthropic: an ordinary (not period-exhausted) rate-limit gets no resetsAt, even with real headers present', () => {
    const err = anthropicRateLimitError('slow down', {
      'anthropic-ratelimit-requests-reset': new Date(Date.now() + 3_600_000).toISOString()
    })
    const mapped = anthropicToProviderError(err)
    expect(mapped.failureClass).not.toBe('period-exhausted')
    expect(mapped.resetsAt).toBeUndefined()
  })

  it('Anthropic: no reset headers at all — resetsAt stays undefined, the honest default', () => {
    const err = anthropicRateLimitError('You have exceeded your quota')
    const mapped = anthropicToProviderError(err)
    expect(mapped.failureClass).toBe('period-exhausted')
    expect(mapped.resetsAt).toBeUndefined()
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
