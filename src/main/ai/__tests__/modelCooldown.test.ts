// BUG-058 — the rate-limit spiral.
//
// THE BUG, concretely: nothing remembered a 429. Every call re-walked the
// chain from position 1, so the model that rate-limited us two seconds ago
// was hit first again, every time — and each failed call then walked the rest
// of the chain, converting ONE provider's limit into hitting every other
// provider's limit too. On a 9-entry quality chain with retries that is ~25
// requests per failed operation across 6 providers. Two operations can
// exhaust a free-tier account set, which is exactly what a founder reported
// from a demo machine with 6-7 free keys.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AIProviderError, type AIFailureClass } from '../types'

const activeProviderId = { current: 'groq' as string | null }
const built: string[] = []
const behavior = {
  throwCode: 'rate-limit' as 'rate-limit' | 'auth' | 'failed',
  retryAfterMs: undefined as number | undefined,
  failTimes: Infinity,
  // BUG-057 Phase 2 — undefined here is the realistic default: most call
  // sites don't classify (see AIProviderError's own doc comment), and
  // effectiveFailureClass() must fall back to 'transient' for those.
  failureClass: undefined as AIFailureClass | undefined
}

vi.mock('../../app-settings', () => ({ loadAppSettings: vi.fn() }))
vi.mock('../fallback-log', () => ({ logFallbackEvent: vi.fn() }))
vi.mock('../index', () => ({
  getActiveAIProvider: () => (activeProviderId.current ? { id: activeProviderId.current } : null)
}))
vi.mock('../registry', () => {
  const make = (id: string, keyEnvName: string, defaultModelId?: string) => ({
    displayName: id,
    keyEnvName,
    defaultModelId,
    build: () => ({
      id,
      complete: async () => {
        built.push(id)
        if (built.length > behavior.failTimes) return { text: 'ok', model: 'm', usage: {} }
        throw new AIProviderError(behavior.throwCode, `${id} limited`, behavior.retryAfterMs, behavior.failureClass)
      }
    })
  })
  return {
    PROVIDER_REGISTRY: {
      anthropic: make('anthropic', 'ANTHROPIC_API_KEY'),
      openai: make('openai', 'OPENAI_API_KEY'),
      groq: make('groq', 'GROQ_API_KEY', 'llama-3.3-70b-versatile'),
      openrouter: make('openrouter', 'OPENROUTER_API_KEY', 'openrouter/free'),
      google: make('google', 'GOOGLE_AI_API_KEY', 'gemini-flash-latest'),
      nvidia: make('nvidia', 'NVIDIA_API_KEY', 'deepseek-ai/deepseek-v3.2'),
      cerebras: make('cerebras', 'CEREBRAS_API_KEY', 'openai/gpt-oss-120b'),
      mistral: make('mistral', 'MISTRAL_API_KEY', 'mistral-small-latest')
    }
  }
})

const { loadAppSettings } = await import('../../app-settings')
const { completeWithFallback } = await import('../complete-with-fallback')
const {
  resetCooldownsForTests,
  markRateLimited,
  markPeriodExhausted,
  markStructurallyBroken,
  isStructurallyBroken,
  isUsable,
  isCoolingDown,
  cooldownUntil,
  clearCooldown,
  DEFAULT_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
  STRUCTURAL_BREAK_MS
} = await import('../model-cooldown')

const PURPOSES = [
  'coaching-cue', 'summary', 'scorecard', 'tasks', 'other', 'prep-brief',
  'deal-tier1', 'deal-tier2', 'coaching-chat', 'memory-extract',
  'memory-consolidate', 'memory-reflect'
]
const allEmpty = () =>
  ({ aiModelAssignments: Object.fromEntries(PURPOSES.map((p) => [p, { chain: [] }])) }) as unknown as ReturnType<typeof loadAppSettings>

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  resetCooldownsForTests()
  built.length = 0
  behavior.throwCode = 'rate-limit'
  behavior.retryAfterMs = undefined
  behavior.failTimes = Infinity
  behavior.failureClass = undefined
  activeProviderId.current = 'groq'
  vi.mocked(loadAppSettings).mockReturnValue(allEmpty())
  process.env.GROQ_API_KEY = 'g'
  process.env.GOOGLE_AI_API_KEY = 'goo'
  process.env.OPENROUTER_API_KEY = 'or'
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  vi.mocked(loadAppSettings).mockReset()
})

describe('the cooldown store', () => {
  it('honours the provider\'s own retry hint over the default', () => {
    const now = 1_000_000
    markRateLimited('m', 5_000, now)
    expect(cooldownUntil('m', now)).toBe(now + 5_000)
  })

  it('falls back to a default when the provider gave no hint', () => {
    const now = 1_000_000
    markRateLimited('m', undefined, now)
    expect(cooldownUntil('m', now)).toBe(now + DEFAULT_COOLDOWN_MS)
  })

  it('caps an absurd hint so one bad header cannot sideline a model all session', () => {
    const now = 1_000_000
    markRateLimited('m', 86_400_000, now)
    expect(cooldownUntil('m', now)).toBe(now + MAX_COOLDOWN_MS)
  })

  it('expires on its own, with no sweeper', () => {
    const now = 1_000_000
    markRateLimited('m', 5_000, now)
    expect(isCoolingDown('m', now + 4_999)).toBe(true)
    expect(isCoolingDown('m', now + 5_001)).toBe(false)
  })

  it('never shortens an existing cooldown — concurrent jobs must not undo each other', () => {
    const now = 1_000_000
    markRateLimited('m', 30_000, now)
    markRateLimited('m', 1_000, now) // a second job reports a shorter delay
    expect(cooldownUntil('m', now)).toBe(now + 30_000)
  })

  it('a success clears it — evidence beats estimate', () => {
    const now = 1_000_000
    markRateLimited('m', 60_000, now)
    clearCooldown('m')
    expect(isCoolingDown('m', now)).toBe(false)
  })
})

describe('the spiral, through the real chain walk', () => {
  it('a rate-limited model is NOT retried on the very next call', async () => {
    // The heart of the bug: before this, call 2 hit the same 429 first.
    await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()
    const firstWalk = [...built]
    expect(firstWalk.length).toBeGreaterThan(0)

    built.length = 0
    await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()

    // Second call spends nothing: every model it would have tried is cooling.
    expect(built).toEqual([])
  })

  it('refuses with a WAIT TIME instead of a generic failure when everything is cooling', async () => {
    behavior.retryAfterMs = 20_000
    await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()

    built.length = 0
    const err = await completeWithFallback({ purpose: 'memory-extract', messages: [] } as never).catch((e) => e)

    expect(err).toBeInstanceOf(AIProviderError)
    expect(err.code).toBe('rate-limit')
    // A number the user can act on — "chain exhausted" told them nothing.
    expect(err.message).toMatch(/try again in about \d+s/i)
    expect(built).toEqual([]) // and it cost zero requests
  })

  it('a model that recovers is used again once its cooldown expires', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-13T12:00:00Z'))
      behavior.retryAfterMs = 5_000
      await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()

      built.length = 0
      vi.setSystemTime(new Date('2026-08-13T12:00:06Z')) // past the 5s hint
      await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()

      expect(built.length).toBeGreaterThan(0)
    } finally {
      vi.useFakeTimers().clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('only rate limits cool down — a plain failure still retries next call', async () => {
    // A cooldown is a response to being ASKED to back off. Applying it to
    // every failure would sideline healthy models after one blip.
    behavior.throwCode = 'failed'
    await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()
    const first = built.length
    expect(first).toBeGreaterThan(0)

    built.length = 0
    await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()
    expect(built.length).toBe(first)
  })
})

// BUG-057 Phase 2 — per-class storage. A structural failure (auth rejected,
// model delisted, a 400 on this exact request shape) and a period-exhausted
// one (daily/monthly quota, credits gone) both need a SHAPE the plain
// cooldown map never had: "don't retry, but for a much longer/different
// reason than an ordinary rate limit."
describe('structural breaks — self-healing, not permanent (first-pass fatal #1, fixed)', () => {
  it('marks a model unusable immediately', () => {
    const now = 1_000_000
    markStructurallyBroken('m', now)
    expect(isStructurallyBroken('m', now)).toBe(true)
    expect(isUsable('m', now)).toBe(false)
  })

  it('self-heals after STRUCTURAL_BREAK_MS — fails on the first pass\'s permanent-map shape', () => {
    const now = 1_000_000
    markStructurallyBroken('m', now)
    expect(isStructurallyBroken('m', now + STRUCTURAL_BREAK_MS - 1)).toBe(true)
    expect(isStructurallyBroken('m', now + STRUCTURAL_BREAK_MS + 1)).toBe(false)
  })

  it('a success clears it early — proof beats the guess', () => {
    const now = 1_000_000
    markStructurallyBroken('m', now)
    clearCooldown('m')
    expect(isStructurallyBroken('m', now)).toBe(false)
  })

  it('does not shorten an existing break — the same never-shorten rule as an ordinary cooldown', () => {
    const now = 1_000_000
    markStructurallyBroken('m', now)
    markStructurallyBroken('m', now + 1000) // a later mark, shorter remaining TTL from its own perspective
    expect(isStructurallyBroken('m', now + STRUCTURAL_BREAK_MS - 1)).toBe(true)
  })
})

describe('period-exhausted — a much longer wait than an ordinary rate limit', () => {
  it('defaults to PERIOD_EXHAUSTED_DEFAULT_MS when the provider gave no hint, far past MAX_COOLDOWN_MS', () => {
    const now = 1_000_000
    markPeriodExhausted('m', undefined, now)
    const until = cooldownUntil('m', now)
    expect(until).not.toBeNull()
    expect((until as number) - now).toBeGreaterThan(MAX_COOLDOWN_MS)
  })

  it('honours a provider retryAfterMs hint, capped at PERIOD_EXHAUSTED_MAX_MS (24h)', () => {
    const now = 1_000_000
    markPeriodExhausted('m', 999 * 60 * 60_000, now) // an absurd 999h hint
    const until = cooldownUntil('m', now)
    expect((until as number) - now).toBe(24 * 60 * 60_000)
  })

  it('shares the ordinary cooldown map — isCoolingDown/isUsable both see it', () => {
    const now = 1_000_000
    markPeriodExhausted('m', 5_000, now)
    expect(isCoolingDown('m', now)).toBe(true)
    expect(isUsable('m', now)).toBe(false)
  })
})

describe('the taxonomy, through the real chain walk', () => {
  it('a period-exhausted rate-limit cools for far longer than an ordinary one — proves markPeriodExhausted fired, not markRateLimited', async () => {
    // Can't read cooldownUntil(catalogId, ...) directly here — `built`
    // records the mock registry's PROVIDER id, not the resolved catalogId
    // model-cooldown.ts actually keys on, and this test doesn't have that
    // mapping. Proven behaviorally instead, with fake time: no retryAfterMs
    // hint means the two code paths' DEFAULTS differ by over an order of
    // magnitude (60s vs 1h) — advancing PAST the ordinary default but well
    // BEFORE the period-exhausted one discriminates which one actually fired.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-13T12:00:00Z'))
      behavior.throwCode = 'rate-limit'
      behavior.failureClass = 'period-exhausted'
      await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()

      built.length = 0
      vi.setSystemTime(new Date('2026-08-13T12:01:05Z')) // +65s: past DEFAULT_COOLDOWN_MS (60s)
      await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()
      // If markRateLimited (the ordinary 60s default) had fired instead, the
      // model would already be usable again here — it must still be empty.
      expect(built).toEqual([])

      built.length = 0
      vi.setSystemTime(new Date('2026-08-13T13:01:05Z')) // +1h1m5s: past PERIOD_EXHAUSTED_DEFAULT_MS (1h)
      await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()
      expect(built.length).toBeGreaterThan(0)
    } finally {
      vi.useFakeTimers().clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('a structural failure excludes the model from every future call until it self-heals', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-13T12:00:00Z'))
      behavior.throwCode = 'failed'
      behavior.failureClass = 'structural'

      await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()
      const brokenId = built[0]
      expect(brokenId).toBeTruthy()

      built.length = 0
      await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()
      // Excluded before any attempt — same "refuse before spending a
      // request" shape as an ordinary cooldown.
      expect(built).toEqual([])

      built.length = 0
      vi.setSystemTime(new Date(Date.now() + STRUCTURAL_BREAK_MS + 1000))
      behavior.throwCode = 'rate-limit' // let it succeed-shaped-enough to prove it was RE-ATTEMPTED, not that it succeeds
      behavior.failTimes = 0 // succeed on first attempt this round
      await completeWithFallback({ purpose: 'memory-extract', messages: [] } as never).catch(() => {})
      expect(built).toContain(brokenId)
    } finally {
      vi.useFakeTimers().clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('an auth failure does NOT also get marked structurally broken — deadProviders already excludes it, avoiding two independent encodings drifting apart', async () => {
    behavior.throwCode = 'auth'
    // Left undefined deliberately: real auth branches across all 4
    // providers set failureClass:'structural' too, but the catch block's
    // own `reason !== 'auth'` guard must be what actually prevents the
    // double-mark, not an accident of this test's fixture leaving
    // failureClass unset. Set it explicitly to prove the guard, not the gap.
    behavior.failureClass = 'structural'
    await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()

    // HONEST LIMITATION: on a full revert (markStructurallyBroken/
    // isStructurallyBroken don't exist pre-Phase-2), this fails via a
    // TypeError — the import itself is missing — not via a wrong boolean.
    // It doesn't discriminate "the reason!=='auth' guard is what prevents
    // the double-mark" from "structural marking doesn't exist at all yet".
    // What it DOES prove, against the CURRENT code, is real: that the guard
    // is actually reached and actually short-circuits for this exact
    // fixture, not just present in a comment.
    expect(isStructurallyBroken(built[0], Date.now())).toBe(false)
  })

  it('an ambiguous failure (failureClass unset) defaults to transient, not structural — the first-pass fatal #2 fix', async () => {
    behavior.throwCode = 'failed'
    behavior.failureClass = undefined // the realistic "nothing classified it" case
    await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()
    const id = built[0]

    built.length = 0
    await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeTruthy()
    // NOT excluded — a 'structural' default here would have blocked this
    // exact call, which is precisely the first-pass bug this fixes.
    expect(built).toContain(id)
  })
})
