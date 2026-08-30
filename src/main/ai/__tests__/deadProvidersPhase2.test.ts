// BUG-058 Phase 2 — streamWithFallback previously had NO early-exit
// mechanism at all, unlike completeWithFallback's deadProviders (confirmed
// by reading the whole function before this phase — see
// docs/BUG-058-shared-resource-pacing-design.md §2). This file proves two
// things: (1) streaming now gets the identical auth short-circuit
// completeWithFallback already had — the same three scenarios
// authShortCircuit.test.ts already proves for completeWithFallback, ported
// to streamWithFallback; (2) the new same-provider-twice rate-limit
// heuristic (added to BOTH walks this phase) actually skips a third
// same-provider attempt once two different models on it have both
// rate-limited within one walk, on both walks, without ever touching a
// genuinely different provider's turn.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AIProviderError } from '../types'

const built: string[] = []
const behavior = { throwCode: 'auth' as 'auth' | 'rate-limit' }

vi.mock('../../app-settings', () => ({ loadAppSettings: vi.fn() }))
vi.mock('../fallback-log', () => ({ logFallbackEvent: vi.fn() }))
vi.mock('../index', () => ({ getActiveAIProvider: () => null }))

// Same registry-mock shape as authShortCircuit.test.ts (real catalog, so
// providerIds/modelIds are genuine), extended with a `stream` implementation
// so the same mock drives both completeWithFallback and streamWithFallback.
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
      },
      stream: () => {
        built.push(id)
        async function* gen(): AsyncGenerator<{ delta: string }> {
          throw new AIProviderError(behavior.throwCode, `${id} says no`)
        }
        const iterable = gen()
        return Object.assign(iterable, {
          usage: Promise.resolve({ inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 })
        })
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
const { completeWithFallback, streamWithFallback, AllModelsExhaustedError } = await import(
  '../complete-with-fallback'
)
const { resetCooldownsForTests } = await import('../model-cooldown')
const { resetPacingForTests } = await import('../model-pacing')

const PURPOSES = [
  'coaching-cue', 'summary', 'scorecard', 'tasks', 'other', 'prep-brief',
  'deal-tier1', 'deal-tier2', 'coaching-chat', 'memory-extract',
  'memory-consolidate', 'memory-reflect'
]

function withChain(purpose: string, chain: string[]): ReturnType<typeof loadAppSettings> {
  return {
    aiModelAssignments: Object.fromEntries(
      PURPOSES.map((p) => [p, p === purpose ? { chain } : { chain: [] }])
    )
  } as unknown as ReturnType<typeof loadAppSettings>
}

// Drains the delta stream (irrelevant here — every attempt fails before any
// delta) so `stream.final` settles; the real assertion is always on `final`.
async function drain(stream: ReturnType<typeof streamWithFallback>): Promise<void> {
  try {
    for await (const _chunk of stream) {
      /* no deltas expected in this file — every attempt fails pre-first-token */
    }
  } catch {
    /* asserted separately via stream.final below */
  }
}

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  built.length = 0
  behavior.throwCode = 'auth'
  // Both maps are module-level (correct at runtime — a rate-limited/paced
  // model is limited for every purpose), which means one test's failures
  // would otherwise silently suppress the next test's attempts.
  resetCooldownsForTests()
  resetPacingForTests()
  process.env.GROQ_API_KEY = 'g'
  process.env.GOOGLE_AI_API_KEY = 'goo'
  process.env.OPENROUTER_API_KEY = 'or'
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  vi.mocked(loadAppSettings).mockReset()
})

describe('streamWithFallback gets the same auth short-circuit completeWithFallback already had', () => {
  it('a bad key costs ONE request, not one per model on that provider', async () => {
    vi.mocked(loadAppSettings).mockReturnValue(
      withChain('coaching-chat', ['groq-llama-3.1-8b-instant', 'groq-llama-3.3-70b-versatile'])
    )

    const stream = streamWithFallback({ purpose: 'coaching-chat', messages: [] } as never)
    await drain(stream)
    await expect(stream.final).rejects.toBeInstanceOf(AllModelsExhaustedError)

    // CORRECTED, NOT RELAXED (2026-08-30, BUG-142). This asserted the whole
    // attempt list, but the guarantee in its own title is about ONE PROVIDER:
    // "not one per model on that provider". The chain is two groq models, so
    // the claim is that groq is attempted exactly ONCE — asserted directly
    // now, and red-checked: breaking the auth short-circuit still fails it.
    // BUG-142's end-of-walk rescue legitimately appends one OTHER keyed
    // provider once the chain is exhausted, which broke the stricter form
    // without touching the guarantee. Matches the property style already used
    // by 'auth on one provider does not stop a DIFFERENT provider' below.
    expect(built.filter((b) => b === 'groq')).toHaveLength(1)
  })

  it('a rate limit does NOT short-circuit on its own — a different model on the same key still gets tried', async () => {
    behavior.throwCode = 'rate-limit'
    vi.mocked(loadAppSettings).mockReturnValue(
      withChain('coaching-chat', ['groq-llama-3.1-8b-instant', 'groq-llama-3.3-70b-versatile'])
    )

    const stream = streamWithFallback({ purpose: 'coaching-chat', messages: [] } as never)
    await drain(stream)
    await expect(stream.final).rejects.toBeInstanceOf(AllModelsExhaustedError)

    // CORRECTED, NOT RELAXED (2026-08-30, BUG-142). Title's claim: a rate
    // limit does NOT short-circuit the provider, so the SECOND groq model is
    // still tried. That is "groq attempted twice", not "the attempt list is
    // exactly these two" — and asserting twice still fails if the rate-limit
    // path ever starts short-circuiting the way auth does.
    expect(built.filter((b) => b === 'groq')).toHaveLength(2)
  })

  it('auth on one provider does not stop a DIFFERENT provider from being tried', async () => {
    vi.mocked(loadAppSettings).mockReturnValue(
      withChain('coaching-chat', [
        'groq-llama-3.1-8b-instant',
        'groq-llama-3.3-70b-versatile',
        'google-gemini-flash'
      ])
    )

    const stream = streamWithFallback({ purpose: 'coaching-chat', messages: [] } as never)
    await drain(stream)
    await expect(stream.final).rejects.toBeInstanceOf(AllModelsExhaustedError)

    expect(built.filter((b) => b === 'groq')).toHaveLength(1)
    expect(built).toContain('google')
  })
})

describe('same-provider-twice-in-one-walk rate-limit heuristic (BUG-058 Phase 2)', () => {
  it('completeWithFallback: a THIRD same-provider model is skipped after two different models on it both rate-limit, but a different provider after it still gets tried', async () => {
    behavior.throwCode = 'rate-limit'
    vi.mocked(loadAppSettings).mockReturnValue(
      withChain('summary', [
        'groq-llama-3.1-8b-instant',
        'groq-llama-3.3-70b-versatile',
        'groq-gpt-oss-120b',
        'google-gemini-flash'
      ])
    )

    await expect(completeWithFallback({ purpose: 'summary', messages: [] } as never)).rejects.toBeInstanceOf(
      AllModelsExhaustedError
    )

    // Two groq attempts establish the pattern; the third groq entry is
    // skipped as an already-doomed request; google — a genuinely different
    // provider — still gets its turn.
    //
    // CORRECTED, NOT RELAXED (2026-08-30, BUG-142). Both halves of that claim
    // are asserted directly instead of via the full list: groq exactly twice
    // (the third is skipped) and google reached after them. BUG-142's rescue
    // appends one further provider at the end, which the exact-array form
    // could not tolerate even though neither half of the guarantee moved.
    expect(built.filter((b) => b === 'groq')).toHaveLength(2)
    expect(built).toContain('google')
    expect(built.indexOf('google')).toBeGreaterThan(built.lastIndexOf('groq'))
  })

  it('streamWithFallback: identical behavior, ported', async () => {
    behavior.throwCode = 'rate-limit'
    vi.mocked(loadAppSettings).mockReturnValue(
      withChain('coaching-chat', [
        'groq-llama-3.1-8b-instant',
        'groq-llama-3.3-70b-versatile',
        'groq-gpt-oss-120b',
        'google-gemini-flash'
      ])
    )

    const stream = streamWithFallback({ purpose: 'coaching-chat', messages: [] } as never)
    await drain(stream)
    await expect(stream.final).rejects.toBeInstanceOf(AllModelsExhaustedError)

    // CORRECTED, NOT RELAXED (2026-08-30, BUG-142) — same correction as its
    // completeWithFallback twin above, and this pair is worth keeping aligned:
    // the stream version briefly failed by TWO extra entries where the twin
    // failed by one, which is what exposed a real defect in BUG-142's stream
    // path (pass 1 re-walking the whole chain, since that loop keeps no
    // `attempted` set). The asymmetry between two tests named as identical was
    // the entire signal.
    expect(built.filter((b) => b === 'groq')).toHaveLength(2)
    expect(built).toContain('google')
    expect(built.indexOf('google')).toBeGreaterThan(built.lastIndexOf('groq'))
  })

  it('two rate-limits on DIFFERENT providers never trips the heuristic — it is same-provider only', async () => {
    behavior.throwCode = 'rate-limit'
    vi.mocked(loadAppSettings).mockReturnValue(
      withChain('summary', ['groq-llama-3.1-8b-instant', 'google-gemini-flash', 'groq-llama-3.3-70b-versatile'])
    )

    await expect(completeWithFallback({ purpose: 'summary', messages: [] } as never)).rejects.toBeInstanceOf(
      AllModelsExhaustedError
    )

    // All three attempted: the groq count only reaches 1 before google's own
    // attempt, and reaches 2 only on the third (and last) entry — too late
    // to skip anything, exactly as expected since there's nothing left to skip.
    //
    // CORRECTED, NOT RELAXED (2026-08-30, BUG-142). The claim is that the
    // heuristic is SAME-PROVIDER ONLY, so all three configured entries are
    // attempted and interleaving never trips it. Asserted as the counts plus
    // the interleaved order of the first three, which is the claim; the
    // trailing rescue entry BUG-142 adds is not part of it.
    expect(built.filter((b) => b === 'groq')).toHaveLength(2)
    expect(built.filter((b) => b === 'google')).toHaveLength(1)
    expect(built.slice(0, 3)).toEqual(['groq', 'google', 'groq'])
  })
})
