// BUG-057 Part 3 — purpose-health-store.ts's recordAiSuccess/recordAiFailure
// are unit-tested on their own (purpose-health-store.test.ts); this proves
// the ACTUAL wiring — that completeWithFallback()/streamWithFallback() call
// them with the right info at the right points — through the real chain
// walk, with only the store itself spied on (the claim under test is OUR
// OWN call sites, not the store's internal persistence, already covered
// elsewhere).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AIProviderError } from '../types'

const recordAiSuccess = vi.fn(async () => {})
const recordAiFailure = vi.fn(async () => {})
vi.mock('../purpose-health-store', () => ({ recordAiSuccess, recordAiFailure }))

const activeProviderId = { current: 'groq' as string | null }
const behavior = { shouldFail: false }

vi.mock('../../app-settings', () => ({ loadAppSettings: vi.fn() }))
vi.mock('../fallback-log', () => ({ logFallbackEvent: vi.fn() }))
vi.mock('../index', () => ({
  getActiveAIProvider: () => (activeProviderId.current ? { id: activeProviderId.current } : null)
}))
vi.mock('../registry', () => {
  // 'summary' (used throughout this file) resolves an implicit tail from
  // QUALITY_CHAIN, which references providers beyond groq — every provider
  // needs a registry entry or resolveConfiguredChain crashes looking one up,
  // even for entries that end up filtered out for lack of an env key.
  const make = (id: string, keyEnvName: string) => ({
    displayName: id,
    keyEnvName,
    build: () => ({
      id,
      complete: async () => {
        if (behavior.shouldFail) throw new AIProviderError('failed', 'boom', undefined, 'transient')
        return { text: 'ok', model: 'm', usage: {} }
      }
    })
  })
  return {
    PROVIDER_REGISTRY: {
      anthropic: make('anthropic', 'ANTHROPIC_API_KEY'),
      openai: make('openai', 'OPENAI_API_KEY'),
      groq: make('groq', 'GROQ_API_KEY'),
      openrouter: make('openrouter', 'OPENROUTER_API_KEY'),
      google: make('google', 'GOOGLE_AI_API_KEY'),
      nvidia: make('nvidia', 'NVIDIA_API_KEY'),
      cerebras: make('cerebras', 'CEREBRAS_API_KEY'),
      mistral: make('mistral', 'MISTRAL_API_KEY')
    }
  }
})

const { loadAppSettings } = await import('../../app-settings')
const { completeWithFallback } = await import('../complete-with-fallback')
const { resetCooldownsForTests } = await import('../model-cooldown')
const { resetPacingForTests } = await import('../model-pacing')

function allEmpty(): ReturnType<typeof loadAppSettings> {
  const purposes = [
    'coaching-cue', 'summary', 'scorecard', 'tasks', 'other', 'prep-brief',
    'deal-tier1', 'deal-tier2', 'coaching-chat', 'memory-extract',
    'memory-consolidate', 'memory-reflect'
  ]
  return {
    aiModelAssignments: Object.fromEntries(purposes.map((p) => [p, { chain: [] }]))
  } as unknown as ReturnType<typeof loadAppSettings>
}

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  resetCooldownsForTests()
  resetPacingForTests()
  recordAiSuccess.mockClear()
  recordAiFailure.mockClear()
  behavior.shouldFail = false
  activeProviderId.current = 'groq'
  vi.mocked(loadAppSettings).mockReturnValue(allEmpty())
  process.env.GROQ_API_KEY = 'g'
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  vi.mocked(loadAppSettings).mockReset()
})

describe('completeWithFallback — actually calls recordAiSuccess/recordAiFailure (BUG-057 Part 3 wiring)', () => {
  it('a real success calls recordAiSuccess with the serving providerId', async () => {
    await completeWithFallback({ purpose: 'summary', messages: [] } as never)

    expect(recordAiSuccess).toHaveBeenCalledTimes(1)
    expect(recordAiSuccess).toHaveBeenCalledWith(
      'summary',
      expect.objectContaining({ providerId: 'groq' })
    )
    expect(recordAiFailure).not.toHaveBeenCalled()
  })

  it('a real exhaustion calls recordAiFailure with the last attempt\'s reason and providerId', async () => {
    behavior.shouldFail = true

    await completeWithFallback({ purpose: 'summary', messages: [] } as never).catch(() => {})

    expect(recordAiFailure).toHaveBeenCalledTimes(1)
    expect(recordAiFailure).toHaveBeenCalledWith(
      'summary',
      expect.objectContaining({ reason: 'failed', providerId: 'groq' })
    )
    expect(recordAiSuccess).not.toHaveBeenCalled()
  })

  it('a no-key call records failure with reason: no-key and providerId: null, before any attempt', async () => {
    activeProviderId.current = null
    delete process.env.GROQ_API_KEY

    await completeWithFallback({ purpose: 'summary', messages: [] } as never).catch(() => {})

    expect(recordAiFailure).toHaveBeenCalledWith('summary', { reason: 'no-key', providerId: null })
  })
})
