// BUG-125b (2026-08-28) — "add another provider key" must actually work.
//
// THE FIELD FAILURE. With every chain entry cooling down, the founder added a
// brand-new PAID Claude key and still got "Every model set up for this is
// rate-limited right now. Try again in about an hour." That message is the
// PRE-WALK refusal — nothing was attempted, so there was no per-model
// breakdown to read either.
//
// The new key could not help because Anthropic has NO catalog entry: it enters
// a chain only as the legacy step, which is built from getActiveAIProvider()
// alone. A keyed provider that is not the active one is invisible to the
// chain regardless of credit. So the product told the user to do the one thing
// that could not possibly work.
//
// Drives the REAL model-cooldown module (a real Map, not a mock) so the
// cooling state here is genuine rather than asserted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const activeProviderId = { current: null as string | null }
const streamed = vi.hoisted(() => ({ providers: [] as string[], failProviders: [] as string[] }))

vi.mock('../../app-settings', () => ({ loadAppSettings: vi.fn() }))
vi.mock('../fallback-log', () => ({ logFallbackEvent: vi.fn() }))
vi.mock('../index', () => ({
  getActiveAIProvider: () => (activeProviderId.current ? { id: activeProviderId.current } : null)
}))
vi.mock('../model-catalog', () => ({
  catalogEntry: (id: string) =>
    id === 'fx-groq' ? { id: 'fx-groq', providerId: 'groq', modelId: 'm', knownStale: false } : null
}))
vi.mock('../registry', () => {
  const make = (id: string, keyEnvName: string) => ({
    displayName: id,
    keyEnvName,
    build: () => ({
      id,
      displayName: id,
      stream: () => {
        streamed.providers.push(id)
        const fail = streamed.failProviders.includes(id)
        async function* gen(): AsyncGenerator<{ delta: string }> {
          if (fail) throw new Error('quota exhausted: credit or quota')
          yield { delta: 'rescued' }
        }
        return Object.assign(gen(), {
          usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 })
        })
      },
      complete: vi.fn(),
      validateKey: vi.fn(),
      listModels: vi.fn()
    })
  })
  return {
    PROVIDER_REGISTRY: {
      groq: make('groq', 'GROQ_API_KEY'),
      anthropic: make('anthropic', 'ANTHROPIC_API_KEY')
    }
  }
})

const { loadAppSettings } = await import('../../app-settings')
const { streamWithFallback } = await import('../complete-with-fallback')
const { markRateLimited, resetCooldownsForTests } = await import('../model-cooldown')
const { resetPacingForTests } = await import('../model-pacing')

function assignments(chain: string[]): ReturnType<typeof loadAppSettings> {
  return { aiModelAssignments: { 'assistant-chat': { chain } } } as unknown as ReturnType<
    typeof loadAppSettings
  >
}

const ORIGINAL_ENV = { ...process.env }
const NOW = Date.now()

async function drain(stream: AsyncIterable<{ delta: string }>): Promise<string> {
  let out = ''
  for await (const c of stream) out += c.delta
  return out
}

beforeEach(() => {
  resetCooldownsForTests()
  resetPacingForTests()
  streamed.providers = []
  streamed.failProviders = []
  activeProviderId.current = null
  process.env.GROQ_API_KEY = 'g'
  delete process.env.ANTHROPIC_API_KEY
  vi.mocked(loadAppSettings).mockReturnValue(assignments(['fx-groq']))
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  vi.mocked(loadAppSettings).mockReset()
})

describe('BUG-125b — a freshly-added key rescues a fully-cooling chain', () => {
  it('THE FIELD CASE: chain fully cooling + a new keyed provider → the turn runs', async () => {
    markRateLimited('fx-groq', 60 * 60_000, NOW, 'durable') // an hour out
    process.env.ANTHROPIC_API_KEY = 'paid-claude-key' // added just now

    const text = await drain(
      streamWithFallback({
        purpose: 'assistant-chat',
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 64
      })
    )

    expect(text).toBe('rescued')
    expect(
      streamed.providers,
      'the newly-added paid key was never tried — the product advised adding a ' +
        'key and then ignored it'
    ).toEqual(['anthropic'])
  })

  it('with NO other key, it still refuses — the rescue invents nothing', async () => {
    markRateLimited('fx-groq', 60 * 60_000, NOW, 'durable')
    delete process.env.ANTHROPIC_API_KEY

    await expect(
      drain(
        streamWithFallback({
          purpose: 'assistant-chat',
          messages: [{ role: 'user', content: 'hello' }],
          maxTokens: 64
        })
      )
    ).rejects.toThrow(/rate-limited/i)
    expect(streamed.providers).toEqual([])
  })

  it('a rescue candidate that is ITSELF cooling is not used — no cooldown bypass', async () => {
    markRateLimited('fx-groq', 60 * 60_000, NOW, 'durable')
    markRateLimited('legacy:anthropic', 60 * 60_000, NOW, 'durable')
    process.env.ANTHROPIC_API_KEY = 'paid-claude-key'

    await expect(
      drain(
        streamWithFallback({
          purpose: 'assistant-chat',
          messages: [{ role: 'user', content: 'hello' }],
          maxTokens: 64
        })
      )
    ).rejects.toThrow(/rate-limited/i)
    expect(streamed.providers).toEqual([])
  })

  it('a LIVE-tier caller is never rescued — that would defeat BUG-058', async () => {
    // Correctness boundary, not a preference. coaching-cue has a single-digit-
    // second budget and a deliberately thin chain; when its models are cooling
    // mid-call the right move is to STOP, not to spend another round trip on a
    // cold provider. The first version of this fix rescued every tier and
    // broke modelCooldown.test.ts's assertion of exactly this.
    vi.mocked(loadAppSettings).mockReturnValue(
      { aiModelAssignments: { 'coaching-cue': { chain: ['fx-groq'] } } } as unknown as ReturnType<
        typeof loadAppSettings
      >
    )
    markRateLimited('fx-groq', 60 * 60_000, NOW, 'live')
    process.env.ANTHROPIC_API_KEY = 'paid-claude-key'

    await expect(
      drain(
        streamWithFallback({
          purpose: 'coaching-cue',
          messages: [{ role: 'user', content: 'hello' }],
          maxTokens: 64
        })
      )
    ).rejects.toThrow(/rate-limited/i)
    expect(
      streamed.providers,
      'a live-call caller was given an extra round trip while cooling — the ' +
        'exact quota burn BUG-058 exists to prevent'
    ).toEqual([])
  })

  it('when the chain is HEALTHY the rescue never fires — ordinary routing untouched', async () => {
    process.env.ANTHROPIC_API_KEY = 'paid-claude-key'

    const text = await drain(
      streamWithFallback({
        purpose: 'assistant-chat',
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 64
      })
    )

    expect(text).toBe('rescued')
    expect(
      streamed.providers,
      'the rescue changed normal routing — it must only run when the answer ' +
        'would otherwise be a refusal'
    ).toEqual(['groq'])
  })
})
