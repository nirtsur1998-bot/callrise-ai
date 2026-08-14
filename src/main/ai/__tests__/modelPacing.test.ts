// BUG-058 remainder — cross-purpose pacing. Two layers, tested separately:
// pure isPacedFor/markUsed mechanics first, then the real headline scenario
// (several durable purposes wanting the same model within the pacing gap)
// through the actual completeWithFallback chain walk.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { AIProviderError } from '../types'
import { isPacedFor, markUsed, resetPacingForTests, PACING_GAP_MS } from '../model-pacing'

describe('isPacedFor / markUsed — pure mechanics', () => {
  beforeEach(() => {
    resetPacingForTests()
  })

  it('a live caller is never paced, even immediately after a durable mark', () => {
    markUsed('m', 1_000, 'durable')
    expect(isPacedFor('m', 1_000, 'live')).toBe(false)
  })

  it('markUsed is a no-op for the live tier — never recorded, so it can never pace a durable caller', () => {
    markUsed('m', 1_000, 'live')
    expect(isPacedFor('m', 1_000, 'durable')).toBe(false)
    expect(isPacedFor('m', 1_050, 'durable')).toBe(false)
  })

  it("a durable caller IS paced by another durable caller's recent mark", () => {
    markUsed('m', 1_000, 'durable')
    expect(isPacedFor('m', 1_000 + PACING_GAP_MS - 1, 'durable')).toBe(true)
  })

  it('pacing clears once PACING_GAP_MS has fully elapsed', () => {
    markUsed('m', 1_000, 'durable')
    expect(isPacedFor('m', 1_000 + PACING_GAP_MS, 'durable')).toBe(false)
  })

  it('an unmarked catalogId is never paced', () => {
    expect(isPacedFor('never-used', 1_000, 'durable')).toBe(false)
  })

  it('pacing is per-catalogId — marking one model does not pace a different one', () => {
    markUsed('model-a', 1_000, 'durable')
    expect(isPacedFor('model-b', 1_000, 'durable')).toBe(false)
  })

  it('a fresh durable mark overwrites (not extends) an older one for the same catalogId', () => {
    markUsed('m', 1_000, 'durable')
    markUsed('m', 1_000 + PACING_GAP_MS - 1, 'durable')
    // Still within the gap of the SECOND mark, even though the first would have cleared by now.
    expect(isPacedFor('m', 1_000 + PACING_GAP_MS, 'durable')).toBe(true)
  })

  it('resetPacingForTests clears all marks', () => {
    markUsed('m', 1_000, 'durable')
    resetPacingForTests()
    expect(isPacedFor('m', 1_000, 'durable')).toBe(false)
  })
})

const activeProviderId = { current: null as string | null }
const built: string[] = []
const behavior = { throwCode: 'rate-limit' as 'rate-limit' | 'ok' | 'failed' }

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
        if (behavior.throwCode === 'ok') return { text: 'ok', model: 'm', usage: {} }
        if (behavior.throwCode === 'failed') {
          // Deliberately ambiguous (no failureClass) — defaults to
          // 'transient', so this exercises neither the structural-break
          // exclusion nor pacing, isolating the "plain failure" claim.
          throw new AIProviderError('failed', `${id} says no`)
        }
        throw new AIProviderError('rate-limit', `${id} is rate-limiting requests right now.`)
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
const { resetCooldownsForTests } = await import('../model-cooldown')

const PURPOSES = [
  'coaching-cue', 'summary', 'scorecard', 'tasks', 'other', 'prep-brief',
  'deal-tier1', 'deal-tier2', 'coaching-chat', 'memory-extract',
  'memory-consolidate', 'memory-reflect'
]

// Same shared model in front of THREE durable purposes' explicit chains —
// mirrors the real founder machine's app-settings.json, where
// google-gemini-flash led 10 of 12 purposes.
// Mirrors the real founder machine's app-settings.json: three durable
// purposes sharing the same lead model, but with a genuine third fallback
// for the purpose that goes last (memory-extract's own real chain had
// exactly this shape: groq, google, openrouter — see the design doc).
function sharedModelFirst(): ReturnType<typeof loadAppSettings> {
  return {
    aiModelAssignments: Object.fromEntries(
      PURPOSES.map((p) => [
        p,
        p === 'summary' || p === 'scorecard'
          ? { chain: ['google-gemini-flash', 'groq-gpt-oss-120b'] }
          : p === 'memory-extract'
            ? { chain: ['google-gemini-flash', 'groq-gpt-oss-120b', 'openrouter-auto-free'] }
            : { chain: [] }
      ])
    )
  } as unknown as ReturnType<typeof loadAppSettings>
}

const ORIGINAL_ENV = { ...process.env }

describe('the headline scenario, through the real chain walk', () => {
  beforeEach(() => {
    resetCooldownsForTests()
    resetPacingForTests()
    built.length = 0
    behavior.throwCode = 'ok'
    activeProviderId.current = null
    vi.mocked(loadAppSettings).mockReturnValue(sharedModelFirst())
    process.env.GOOGLE_AI_API_KEY = 'goo'
    process.env.GROQ_API_KEY = 'g'
    process.env.OPENROUTER_API_KEY = 'or'
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    process.env = { ...ORIGINAL_ENV }
    vi.mocked(loadAppSettings).mockReset()
  })

  it('three durable purposes wanting the same models within the pacing gap spread across them — each diverts to its own next un-paced candidate, none re-collide', async () => {
    const now = new Date('2026-08-14T12:00:00.000Z')
    vi.setSystemTime(now)

    // summary goes first and succeeds — legitimately "uses" google-gemini-flash.
    await completeWithFallback({ purpose: 'summary', messages: [] } as never)
    expect(built).toEqual(['google']) // google-gemini-flash's provider is 'google'

    // scorecard asks moments later, well inside PACING_GAP_MS — google is
    // paced (summary just used it), so it diverts straight to groq without
    // ever re-attempting google.
    built.length = 0
    vi.setSystemTime(new Date(now.getTime() + 500))
    await completeWithFallback({ purpose: 'scorecard', messages: [] } as never)
    expect(built).toEqual(['groq'])

    // memory-extract asks moments after THAT — both google (used by summary)
    // AND groq (just used by scorecard) are paced, so it correctly falls
    // through to its own third candidate rather than colliding with either.
    // This is the actual headline property: three purposes, three distinct
    // attempts, zero purposes stacking onto a model someone else JUST used.
    built.length = 0
    vi.setSystemTime(new Date(now.getTime() + 900))
    await completeWithFallback({ purpose: 'memory-extract', messages: [] } as never)
    expect(built).toEqual(['openrouter'])
  })

  it('pacing clears once PACING_GAP_MS has elapsed, even for the same model', async () => {
    const now = new Date('2026-08-14T12:00:00.000Z')
    vi.setSystemTime(now)
    await completeWithFallback({ purpose: 'summary', messages: [] } as never)
    expect(built).toEqual(['google'])

    built.length = 0
    vi.setSystemTime(new Date(now.getTime() + PACING_GAP_MS))
    await completeWithFallback({ purpose: 'scorecard', messages: [] } as never)
    expect(built).toEqual(['google']) // no longer paced — genuinely re-attempted
  })

  it('live purposes are never diverted by pacing, even immediately after a durable purpose just used the same model', async () => {
    const now = new Date('2026-08-14T12:00:00.000Z')
    vi.setSystemTime(now)

    // A durable purpose uses google-gemini-flash successfully.
    await completeWithFallback({ purpose: 'summary', messages: [] } as never)
    expect(built).toEqual(['google'])

    // coaching-cue (live tier) is configured with the SAME model first —
    // pacing must never apply to it, even a moment later.
    vi.mocked(loadAppSettings).mockReturnValue({
      aiModelAssignments: Object.fromEntries(
        PURPOSES.map((p) => [
          p,
          p === 'coaching-cue' ? { chain: ['google-gemini-flash'] } : { chain: [] }
        ])
      )
    } as unknown as ReturnType<typeof loadAppSettings>)
    built.length = 0
    vi.setSystemTime(new Date(now.getTime() + 10))
    await completeWithFallback({ purpose: 'coaching-cue', messages: [] } as never)
    expect(built).toEqual(['google']) // attempted, not diverted
  })

  it('a plain (non-rate-limit) failure never paces a model — matches model-cooldown.ts\'s own "only rate limits cool down" rule', async () => {
    behavior.throwCode = 'failed'
    const now = new Date('2026-08-14T12:00:00.000Z')
    vi.setSystemTime(now)
    await expect(
      completeWithFallback({ purpose: 'summary', messages: [] } as never)
    ).rejects.toBeTruthy()
    expect(built).toContain('google') // both chain entries attempted and failed plainly

    // A different durable purpose, moments later, must NOT be diverted away
    // from google — the plain failures above left no pacing mark, only
    // rate-limit-classified ones do.
    built.length = 0
    vi.setSystemTime(new Date(now.getTime() + 500))
    behavior.throwCode = 'ok'
    await completeWithFallback({ purpose: 'scorecard', messages: [] } as never)
    expect(built).toEqual(['google'])
  })
})
