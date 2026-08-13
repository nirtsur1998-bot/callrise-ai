// BUG-057 Phase 2 — streamWithFallback() used to compute `chain` as
// `resolveChain(purpose).filter(notCoolingDown)` and then check
// `chain.length === 0` to decide "no keys configured" — collapsing "you have
// no keys" and "you have real keys but every one is cooling down" into the
// SAME AIProviderError('no-key', ...), actively telling a user with valid
// keys that nothing is configured. This mirrors resolveChain.legacy.test.ts's
// mock shape but drives the REAL model-cooldown.ts module (a real Map, not a
// mock) so the cooldown state driving this test is genuine, not asserted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../app-settings', () => ({ loadAppSettings: vi.fn() }))
vi.mock('../fallback-log', () => ({ logFallbackEvent: vi.fn() }))
vi.mock('../index', () => ({ getActiveAIProvider: () => null }))
vi.mock('../model-catalog', () => ({
  catalogEntry: (id: string) =>
    id === 'test-model-a'
      ? { id: 'test-model-a', providerId: 'anthropic', modelId: 'model-a', knownStale: false }
      : null
}))
vi.mock('../registry', () => ({
  PROVIDER_REGISTRY: {
    anthropic: {
      displayName: 'Claude',
      keyEnvName: 'ANTHROPIC_API_KEY',
      build: () => ({
        id: 'anthropic',
        displayName: 'Claude',
        stream: () => {
          async function* gen(): AsyncGenerator<{ delta: string }> {
            throw new Error('should never be called — every entry is cooling down')
          }
          const iterable = gen()
          return Object.assign(iterable, {
            usage: Promise.resolve({ inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 })
          })
        },
        complete: vi.fn(),
        validateKey: vi.fn(),
        listModels: vi.fn()
      })
    }
  }
}))

const { loadAppSettings } = await import('../../app-settings')
const { streamWithFallback, AllModelsExhaustedError } = await import('../complete-with-fallback')
const { markRateLimited, resetCooldownsForTests } = await import('../model-cooldown')

function assignments(chain: string[]): ReturnType<typeof loadAppSettings> {
  return {
    aiModelAssignments: {
      'coaching-cue': { chain: [] },
      summary: { chain: [] },
      scorecard: { chain: [] },
      tasks: { chain: [] },
      other: { chain: [] },
      'prep-brief': { chain: [] },
      'deal-tier1': { chain: [] },
      'deal-tier2': { chain: [] },
      'coaching-chat': { chain },
      'memory-extract': { chain: [] },
      'memory-consolidate': { chain: [] },
      'memory-reflect': { chain: [] }
    }
  } as unknown as ReturnType<typeof loadAppSettings>
}

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  resetCooldownsForTests()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  vi.mocked(loadAppSettings).mockReturnValue(assignments(['test-model-a']))
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  vi.mocked(loadAppSettings).mockReset()
})

async function drain(gen: ReturnType<typeof streamWithFallback>): Promise<unknown> {
  // streamWithFallback rejects TWO things on failure: the async generator
  // itself (caught below) and its separate `final` promise (rejectFinal) —
  // left unattached, that second rejection surfaces as an unhandled
  // rejection next to an otherwise-green test run, exactly the "stray error
  // line" pattern this milestone's own taxonomy catalogues. Attached here so
  // a real failure can't hide behind a passing assertion.
  gen.final.catch(() => {})
  try {
    for await (const _ of gen) void _
    return null
  } catch (err) {
    return err
  }
}

describe('streamWithFallback — cooling-down is no longer mislabeled as no-key', () => {
  it('a real key IS configured but the only chain entry is genuinely cooling down: reports rate-limit, not no-key', async () => {
    // Real cooldown state, not asserted — put the actual catalogId in
    // cooldown via the real module before ever calling streamWithFallback.
    // 'durable' causation: coaching-chat isn't in CHAIN_BUDGET, so the
    // walker's own computed tier here is always 'durable' too — matching
    // that is what makes this cooldown genuinely block it rather than being
    // silently bypassed (a 'durable' caller only bypasses a 'live'-caused
    // entry, never another 'durable'-caused one).
    markRateLimited('test-model-a', 30_000, Date.now(), 'durable')

    const gen = streamWithFallback({ purpose: 'coaching-chat', messages: [] } as never)
    const err = await drain(gen)

    expect(err).not.toBeNull()
    expect((err as { code?: string }).code).toBe('rate-limit')
    expect((err as Error).message).toMatch(/try again in about \d+s/i)
    // The bug this closes: before the fix, this exact scenario threw
    // AIProviderError('no-key', 'No AI provider is configured for this yet.')
    expect((err as Error).message).not.toMatch(/no ai provider is configured/i)
  })

  it('genuinely no keys at all still reports no-key (unchanged)', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const gen = streamWithFallback({ purpose: 'coaching-chat', messages: [] } as never)
    const err = await drain(gen)

    expect((err as { code?: string }).code).toBe('no-key')
  })

  it('a real failure (not cooling down) still exhausts normally (unchanged)', async () => {
    // No cooldown set — the model is attempted for real and fails via the
    // mocked provider's stream(), which always throws.
    const gen = streamWithFallback({ purpose: 'coaching-chat', messages: [] } as never)
    const err = await drain(gen)

    expect(err).toBeInstanceOf(AllModelsExhaustedError)
  })
})
