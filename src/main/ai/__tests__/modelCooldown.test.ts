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
import { AIProviderError } from '../types'

const activeProviderId = { current: 'groq' as string | null }
const built: string[] = []
const behavior = { throwCode: 'rate-limit' as 'rate-limit' | 'auth' | 'failed', retryAfterMs: undefined as number | undefined, failTimes: Infinity }

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
        throw new AIProviderError(behavior.throwCode, `${id} limited`, behavior.retryAfterMs)
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
  isCoolingDown,
  cooldownUntil,
  clearCooldown,
  DEFAULT_COOLDOWN_MS,
  MAX_COOLDOWN_MS
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
