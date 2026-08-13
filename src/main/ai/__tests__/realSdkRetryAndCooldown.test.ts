// BUG-058/BUG-059 — the sharpest lesson of this milestone: the BUG-059
// red-check passed and the claim was still false. That test mocked a
// PROVIDER whose complete() directly honoured the abort signal, then proved
// "if the provider honours the signal, our ceiling works" — which begs the
// exact question at issue. The real vendored `openai` SDK's own internal
// retry sleep (internal/utils/sleep.js) never accepts a signal at all, and
// sleeps for whatever the provider's Retry-After header says, UNCAPPED.
//
// STANDING RULE from this finding: when a test mocks the thing whose
// behaviour IS the claim, it proves nothing. These tests exercise the REAL
// `openai` package via the REAL createOpenAICompatibleProvider — nothing
// about the SDK, the provider class, or the registry is mocked. Only
// `fetch` is stubbed, at the network boundary, which is the one thing that
// legitimately should be faked in a unit test (we are not making real HTTP
// calls to Groq).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const activeProviderId = { current: null as string | null }

vi.mock('../../app-settings', () => ({ loadAppSettings: vi.fn() }))
vi.mock('../fallback-log', () => ({ logFallbackEvent: vi.fn() }))
vi.mock('../index', () => ({
  getActiveAIProvider: () => (activeProviderId.current ? { id: activeProviderId.current } : null)
}))

const { loadAppSettings } = await import('../../app-settings')
const { completeWithFallback } = await import('../complete-with-fallback')
const { createOpenAICompatibleProvider } = await import('../providers/openai-compatible')
const { resetCooldownsForTests, isCoolingDown } = await import('../model-cooldown')

const PURPOSES = [
  'coaching-cue', 'summary', 'scorecard', 'tasks', 'other', 'prep-brief',
  'deal-tier1', 'deal-tier2', 'coaching-chat', 'memory-extract',
  'memory-consolidate', 'memory-reflect'
]

function assignments(purpose: string, chain: string[]) {
  return {
    aiModelAssignments: Object.fromEntries(PURPOSES.map((p) => [p, { chain: p === purpose ? chain : [] }]))
  } as unknown as ReturnType<typeof loadAppSettings>
}

const GROQ_CONFIG = {
  id: 'groq' as const,
  displayName: 'Groq',
  baseURL: 'https://api.groq.com/openai/v1',
  defaultModel: 'llama-3.3-70b-versatile'
}

function rateLimitResponse(retryAfterSeconds: number): Response {
  return new Response(JSON.stringify({ error: { message: 'Rate limit exceeded' } }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': String(retryAfterSeconds) }
  })
}

function okResponse(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: 'ok', tool_calls: undefined } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 }
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )
}

const ORIGINAL_ENV = { ...process.env }
const ORIGINAL_FETCH = globalThis.fetch

beforeEach(() => {
  resetCooldownsForTests()
  activeProviderId.current = null
  process.env.GROQ_API_KEY = 'test-key-not-real'
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  globalThis.fetch = ORIGINAL_FETCH
  vi.mocked(loadAppSettings).mockReset()
  vi.useRealTimers()
})

describe('the REAL openai SDK, maxRetries: 0', () => {
  it('does not internally sleep on a 429 — the promise settles with no timer needing to fire', async () => {
    // The load-bearing assertion. Fake timers never auto-advance, so if the
    // real SDK's own retry path still required a setTimeout to elapse
    // before this promise could settle, awaiting it here would hang for
    // real and the test would time out — it cannot silently pass.
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => rateLimitResponse(3600))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = createOpenAICompatibleProvider(GROQ_CONFIG, 'test-key-not-real')

    const err = await provider
      .complete({ purpose: 'memory-extract', maxTokens: 50, messages: [{ role: 'user', content: 'hi' }] })
      .catch((e: unknown) => e)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(err).toMatchObject({ code: 'rate-limit', retryAfterMs: 3_600_000 })
  })

  it('a REAL SDK RateLimitError still classifies correctly via toProviderError', async () => {
    // Confirms the fix didn't accidentally change what error the real SDK
    // throws for a 429 — only whether it retries before throwing it.
    const fetchMock = vi.fn(async () => rateLimitResponse(20))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const provider = createOpenAICompatibleProvider(GROQ_CONFIG, 'test-key-not-real')

    const err = await provider
      .complete({ purpose: 'memory-extract', maxTokens: 50, messages: [{ role: 'user', content: 'hi' }] })
      .catch((e: unknown) => e)

    expect(err).toMatchObject({ code: 'rate-limit', retryAfterMs: 20_000 })
  })
})

describe('BUG-058 cooldown, re-verified against the REAL SDK path', () => {
  it('a rate limit from the REAL SDK populates the cooldown, which suppresses the very next real call', async () => {
    // This is the founder's own concern, proven rather than assumed: the
    // walker's markRateLimited() can only fire once provider.complete()
    // RETURNS. If the SDK were still internally sleeping out the full
    // Retry-After before returning, the cooldown would still be correct in
    // principle but would engage only after the same doomed wait it exists
    // to prevent. This test drives the REAL registry, the REAL provider
    // class, and the REAL completeWithFallback walker — nothing but fetch
    // is a stand-in.
    vi.mocked(loadAppSettings).mockReturnValue(assignments('memory-extract', ['groq-gpt-oss-120b']))
    const fetchMock = vi.fn(async () => rateLimitResponse(5))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const req = { purpose: 'memory-extract' as const, maxTokens: 50, messages: [{ role: 'user' as const, content: 'hi' }] }

    // Call 1 — nothing cooling yet, the real chain walk happens for real.
    await expect(completeWithFallback(req)).rejects.toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(isCoolingDown('groq-gpt-oss-120b', Date.now())).toBe(true)

    // Call 2 — "the very next call". If the cooldown populated by the REAL
    // SDK's real error is actually wired into the walker, this must be
    // refused BEFORE any network attempt. fetchMock staying at 1 is the
    // whole proof.
    const err2 = await completeWithFallback(req).catch((e: unknown) => e)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(err2).toMatchObject({ code: 'rate-limit' })
    expect((err2 as Error).message).toMatch(/try again in about \d+s/i)
  })
})

describe('same-model retry, against the REAL SDK connection-error path', () => {
  it('retries the SAME model on a real connection failure, since the SDK no longer will', async () => {
    // With maxRetries:0 the SDK will never again silently absorb a
    // transient blip — proving our own walker-level retry (the required
    // replacement) actually fires, driven by a REAL rejected fetch, not a
    // provider double built to cooperate.
    let calls = 0
    const fetchMock = vi.fn(async () => {
      calls++
      if (calls === 1) throw new TypeError('fetch failed') // real fetch-level connection failure shape
      return okResponse()
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    vi.mocked(loadAppSettings).mockReturnValue(assignments('memory-extract', ['groq-gpt-oss-120b']))

    const result = await completeWithFallback({
      purpose: 'memory-extract',
      maxTokens: 50,
      messages: [{ role: 'user', content: 'hi' }]
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.text).toBe('ok')

    // HONEST LIMITATION, not swept under the rug: this assertion alone does
    // NOT discriminate "our walker retried" from "the SDK's own retry
    // (still present if this file's maxRetries:0 change were reverted) also
    // produced a second fetch call" — a connection failure with no
    // Retry-After header falls back to the SDK's short DEFAULT backoff,
    // which is fast enough that reverting this fix would likely still pass
    // this specific assertion. The genuinely load-bearing, red-check-proof
    // tests are the three above and below that involve a large
    // provider-stated wait (429 + Retry-After): those hang for real on
    // revert, because only a real uncapped unabortable sleep explains that.
    // This test's job is narrower and still real — proving retry-on-
    // connection-failure is CORRECT behavior today, using the real SDK
    // rather than a cooperative mock — not proving which code path earned it.
  })

  it('does NOT retry the same model on a real 429 — that is the cooldown\'s job, not a resend', async () => {
    const fetchMock = vi.fn(async () => rateLimitResponse(30))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    vi.mocked(loadAppSettings).mockReturnValue(assignments('memory-extract', ['groq-gpt-oss-120b']))

    await expect(
      completeWithFallback({
        purpose: 'memory-extract',
        maxTokens: 50,
        messages: [{ role: 'user', content: 'hi' }]
      })
    ).rejects.toBeTruthy()

    // Exactly one real request for this whole call — a same-model retry
    // here would just repeat the 429; advancing/cooling is the correct
    // response, and that happens at the walker's outer level, not inside
    // the retry helper.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
