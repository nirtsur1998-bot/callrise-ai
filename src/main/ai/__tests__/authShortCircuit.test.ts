// BUG-057 — an invalid/revoked key fails IDENTICALLY on every model that
// provider offers, so once one step returns 'auth', every remaining step on
// the same provider is a guaranteed-doomed request.
//
// This is what keeps the new fallback tail from being "just slower failure"
// for the single-key user with a bad key — the exact objection raised against
// adding fallback at all. Deliberately NOT extended to 'rate-limit': Groq and
// Gemini rate-limit per-MODEL, so a different model on the same key really
// can succeed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AIProviderError } from '../types'

const activeProviderId = { current: 'groq' as string | null }
const built: string[] = []
const behavior = { throwCode: 'auth' as 'auth' | 'rate-limit' }

vi.mock('../../app-settings', () => ({ loadAppSettings: vi.fn() }))
vi.mock('../fallback-log', () => ({ logFallbackEvent: vi.fn() }))
vi.mock('../index', () => ({
  getActiveAIProvider: () => (activeProviderId.current ? { id: activeProviderId.current } : null)
}))

// A stand-in registry: every provider builds a client that records the
// attempt and then fails with the configured code. Keeps the real catalog
// (so providerIds/modelIds are genuine) while making failures deterministic.
vi.mock('../registry', () => {
  const make = (id: string, keyEnvName: string, defaultModelId?: string) => ({
    displayName: id,
    keyEnvName,
    defaultModelId,
    build: () => ({
      id,
      complete: async () => {
        built.push(id)
        throw new AIProviderError(behavior.throwCode, `${id} says no`)
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
const { completeWithFallback, resolveConfiguredChain, AllModelsExhaustedError } = await import(
  '../complete-with-fallback'
)
const { resetCooldownsForTests } = await import('../model-cooldown')
const { resetPacingForTests } = await import('../model-pacing')
// BUG-148 — provider demotion is module-global like cooldowns and pacing, so it
// leaks between tests the same way. Without this, a file that drives two auth
// failures demotes the provider partway through and every LATER test in it
// silently exercises a REORDERED chain — passing, while no longer covering the
// path it names. That was measured here, not assumed.
const { resetDemotionsForTests } = await import('../provider-demotion')

const PURPOSES = [
  'coaching-cue', 'summary', 'scorecard', 'tasks', 'other', 'prep-brief',
  'deal-tier1', 'deal-tier2', 'coaching-chat', 'memory-extract',
  'memory-consolidate', 'memory-reflect'
]

function allEmpty() {
  return {
    aiModelAssignments: Object.fromEntries(PURPOSES.map((p) => [p, { chain: [] }]))
  } as unknown as ReturnType<typeof loadAppSettings>
}

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  built.length = 0
  behavior.throwCode = 'auth'
  // BUG-058's cooldown map is module-level (a rate-limited model is limited
  // for every purpose, so that is correct at runtime) — which means one
  // test's 429s would otherwise silently suppress the next test's attempts.
  resetCooldownsForTests()
  resetDemotionsForTests()
  resetPacingForTests()
  activeProviderId.current = 'groq'
  vi.mocked(loadAppSettings).mockReturnValue(allEmpty())
  process.env.GROQ_API_KEY = 'g'
  delete process.env.GOOGLE_AI_API_KEY
  delete process.env.OPENROUTER_API_KEY
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  vi.mocked(loadAppSettings).mockReset()
})

describe('auth failures skip the rest of that provider', () => {
  it('a bad key costs ONE request, not one per model', async () => {
    // Single-key user, bad key. resolveChain legitimately offers 2 steps
    // (legacy + one same-provider retry); the auth result must collapse that
    // to a single actual request.
    expect(resolveConfiguredChain('memory-extract').length).toBe(2)

    await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeInstanceOf(
      AllModelsExhaustedError
    )

    expect(built).toEqual(['groq'])
  })

  it('a RATE LIMIT does not skip — a different model on the same key can still work', async () => {
    behavior.throwCode = 'rate-limit'

    await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeInstanceOf(
      AllModelsExhaustedError
    )

    // Both steps attempted: per-model rate limiting is real, so the second
    // model on the same key is a genuine second chance.
    expect(built).toEqual(['groq', 'groq'])
  })

  it('auth on one provider does not stop a DIFFERENT provider being tried', async () => {
    process.env.GOOGLE_AI_API_KEY = 'goo'
    process.env.OPENROUTER_API_KEY = 'or'

    await expect(completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)).rejects.toBeInstanceOf(
      AllModelsExhaustedError
    )

    // groq attempted once (then skipped), and the other providers still got
    // their turn — the whole point of crossing providers.
    expect(built.filter((b) => b === 'groq')).toHaveLength(1)
    expect(new Set(built).size).toBeGreaterThan(1)
  })
})
