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
import type { StreamWithFallbackResult } from '../complete-with-fallback'

const activeProviderId = { current: null as string | null }
const streamed = vi.hoisted(() => ({ providers: [] as string[], failProviders: [] as string[] }))

vi.mock('../../app-settings', () => ({ loadAppSettings: vi.fn() }))
vi.mock('../fallback-log', () => ({ logFallbackEvent: vi.fn() }))
const health = vi.hoisted(() => ({ failures: [] as string[] }))
vi.mock('../purpose-health-store', () => ({
  recordAiFailure: vi.fn(async (purpose: string) => {
    health.failures.push(purpose)
  }),
  recordAiSuccess: vi.fn(async () => {})
}))
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
const { markUsed } = await import('../model-pacing')
const { resetPacingForTests } = await import('../model-pacing')

function assignments(chain: string[]): ReturnType<typeof loadAppSettings> {
  return { aiModelAssignments: { 'assistant-chat': { chain } } } as unknown as ReturnType<
    typeof loadAppSettings
  >
}

const ORIGINAL_ENV = { ...process.env }
const NOW = Date.now()

// Test-hygiene fix (2026-08-28): streamWithFallback()'s returned `.final` is
// a SEPARATE promise from the async generator itself (complete-with-fallback.ts
// rejects both on every error path). A caller that only iterates the
// generator — as every test here does via `for await` — leaves `.final`
// rejected and unobserved, which Node reports as an unhandled rejection even
// though every assertion in the file passes; production callers already
// guard against exactly this (assistant-ipc.ts: "Always settle .final —
// even on the error path — to avoid an unhandled..."). Same guard here.
async function drain(stream: StreamWithFallbackResult): Promise<string> {
  let out = ''
  try {
    for await (const c of stream) out += c.delta
  } finally {
    await stream.final.catch(() => {})
  }
  return out
}

beforeEach(() => {
  resetCooldownsForTests()
  resetPacingForTests()
  streamed.providers = []
  streamed.failProviders = []
  health.failures = []
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

// BUG-125e — THE PACED TAIL, the fix the agent workflow designed and its
// adversarial pass amended. Verified root cause: one Rise turn makes
// sequential assistant-chat calls; the plan call's SUCCESS paces the provider
// for up to 6s, and for a single-key user the answer call's chain collapses to
// exactly that one step — so the turn starved itself and the walk refused with
// "rate-limited... about an hour" for a condition that clears in seconds.
// BUG-125 closing move — the breakdown is composed INSIDE the error, so every
// surface that shows err.message gets it (13 files check this error type; only
// Rise had the breakdown before). Driven through the REAL walk, not a mock.
describe('AllModelsExhaustedError composes its own breakdown', () => {
  it('a real exhausted walk throws a message carrying "What each model reported"', async () => {
    streamed.failProviders = ['groq']
    delete process.env.ANTHROPIC_API_KEY
    vi.mocked(loadAppSettings).mockReturnValue(assignments(['fx-groq']))

    await expect(
      drain(
        streamWithFallback({
          purpose: 'assistant-chat',
          messages: [{ role: 'user', content: 'hello' }],
          maxTokens: 64
        })
      )
    ).rejects.toThrow(/What each model reported/)
  })
})

describe('BUG-125e — a paced-only last resort is WAITED OUT, not refused', () => {
  it('THE FIELD CASE: sole provider paced by the same turn 100ms ago → the walk waits and succeeds', async () => {
    // groq's PER-PROVIDER gap is 2,000ms (not the 6s default — my first
    // version of this test used the default and the mark was not paced at
    // all, which is itself the lesson of modelPacing.perProvider.test.ts).
    // markUsed 1.9s in the past: ~100ms remain, so the test proves a real
    // sleep happened without costing real seconds.
    markUsed('legacy:groq', Date.now() - 1_900, 'durable')
    delete process.env.ANTHROPIC_API_KEY
    vi.mocked(loadAppSettings).mockReturnValue(assignments([]))
    activeProviderId.current = 'groq'

    const t0 = Date.now()
    const text = await drain(
      streamWithFallback({
        purpose: 'assistant-chat',
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 64
      })
    )

    expect(text).toBe('rescued')
    expect(streamed.providers).toEqual(['groq'])
    expect(
      Date.now() - t0,
      'no wait happened — the pacing gap was bypassed rather than honoured'
    ).toBeGreaterThanOrEqual(80)
  })

  it('ORDERING (adversarial amendment): a fresh never-tried key is attempted BEFORE the paced tail, zero sleep', async () => {
    // groq (the configured entry, via legacy) is paced with a LONG remainder;
    // anthropic is a freshly-added key. The rescue must fire first — waiting
    // multiple seconds behind a paced provider to reach a fresh key would
    // re-create the exact "added a key, still refused" failure of BUG-125b.
    markUsed('legacy:groq', Date.now() - 100, 'durable') // ~1.9s of groq's 2s gap remaining
    process.env.ANTHROPIC_API_KEY = 'paid-claude-key'
    vi.mocked(loadAppSettings).mockReturnValue(assignments([]))
    activeProviderId.current = 'groq'

    const t0 = Date.now()
    const text = await drain(
      streamWithFallback({
        purpose: 'assistant-chat',
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 64
      })
    )

    expect(text).toBe('rescued')
    expect(streamed.providers[0]).toBe('anthropic')
    expect(Date.now() - t0, 'the fresh key waited behind a paced provider').toBeLessThan(3_000)
  })

  it('Stop DURING the paced wait: aborts promptly, and records NO purpose-health failure', async () => {
    // The adversarial pass caught the design doc claiming aborts "route to
    // existing paths" — false. A user cancel must not be written into
    // purpose-health as an AI failure, and must not wait out the full gap.
    markUsed('legacy:groq', Date.now() - 200, 'durable') // ~1.8s of groq's 2s gap remaining
    delete process.env.ANTHROPIC_API_KEY
    vi.mocked(loadAppSettings).mockReturnValue(assignments([]))
    activeProviderId.current = 'groq'

    const controller = new AbortController()
    setTimeout(() => controller.abort(), 60)
    const t0 = Date.now()

    await expect(
      drain(
        streamWithFallback({
          purpose: 'assistant-chat',
          messages: [{ role: 'user', content: 'hello' }],
          maxTokens: 64,
          signal: controller.signal
        })
      )
    ).rejects.toThrow(/aborted by caller during paced wait/)

    expect(Date.now() - t0, 'Stop did not wake the sleep').toBeLessThan(1_500)
    expect(streamed.providers, 'the attempt ran despite the cancel').toEqual([])
    expect(
      health.failures,
      'a user cancel was recorded as an AI failure in purpose-health'
    ).toEqual([])
  })

  it('a walk with an UN-paced candidate never sleeps — the divert behaviour is untouched', async () => {
    // modelPacing.test.ts pins this at the pacing layer; this pins it at the
    // walk layer: paced tail entries are LAST, so a healthy candidate wins
    // immediately.
    markUsed('legacy:anthropic', Date.now() - 100, 'durable')
    process.env.ANTHROPIC_API_KEY = 'paid-claude-key'
    vi.mocked(loadAppSettings).mockReturnValue(assignments(['fx-groq']))
    activeProviderId.current = null

    const t0 = Date.now()
    const text = await drain(
      streamWithFallback({
        purpose: 'assistant-chat',
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 64
      })
    )

    expect(text).toBe('rescued')
    expect(streamed.providers).toEqual(['groq'])
    expect(Date.now() - t0).toBeLessThan(1_500)
  })
})
