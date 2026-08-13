// BUG-059 — nothing bounded chain-length x SDK-retries x per-attempt-timeout.
//
// Our loop was bounded (chain length). Each SDK's retry loop was bounded
// (LATENCY_POLICY.maxRetries). The PRODUCT was bounded by nothing: `summary`
// is 9 entries x 3 attempts x 60s ~= 27 minutes of a user watching a spinner
// before being told it failed. CHAIN_BUDGET never covered this — it exists
// for two purposes only, both maxRetries:0, so it has never had to bound an
// SDK retry loop.
//
// And it could not be cancelled out of: JobManager's own doc comment says
// adapters MUST thread its AbortSignal into req.signal "for cancel to mean
// anything", and NO adapter does — so Cancel removed the job from the UI
// while the loop kept running and kept spending quota.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AIProviderError, HARD_CEILING_MS } from '../types'

const activeProviderId = { current: null as string | null }
const started: string[] = []
/** Simulates a provider whose SDK is retrying internally: it never resolves
 *  on its own and only settles when the signal it was handed aborts. If the
 *  ceiling did not reach the SDK, this would hang forever. */
const hang = { enabled: true }

vi.mock('../../app-settings', () => ({ loadAppSettings: vi.fn() }))
vi.mock('../fallback-log', () => ({ logFallbackEvent: vi.fn() }))
vi.mock('../index', () => ({
  getActiveAIProvider: () => (activeProviderId.current ? { id: activeProviderId.current } : null)
}))
vi.mock('../registry', () => {
  const make = (id: string, keyEnvName: string) => ({
    displayName: id,
    keyEnvName,
    build: () => ({
      id,
      complete: (req: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          started.push(id)
          if (!hang.enabled) {
            reject(new AIProviderError('failed', `${id} failed fast`))
            return
          }
          const s = req.signal
          if (!s) return // no signal => hangs forever, which is the bug
          if (s.aborted) {
            reject(new AIProviderError('timeout', 'aborted'))
            return
          }
          s.addEventListener('abort', () => reject(new AIProviderError('timeout', 'aborted')))
        })
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
  started.length = 0
  hang.enabled = true
  activeProviderId.current = null
  vi.mocked(loadAppSettings).mockReturnValue(allEmpty())
  process.env.GROQ_API_KEY = 'g'
  process.env.GOOGLE_AI_API_KEY = 'goo'
  process.env.OPENROUTER_API_KEY = 'or'
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  vi.mocked(loadAppSettings).mockReset()
  vi.useRealTimers()
})

describe('the hard wall-clock ceiling', () => {
  it('every purpose has one — a 13th purpose must not inherit an unbounded default', () => {
    for (const p of PURPOSES) {
      expect(HARD_CEILING_MS[p as keyof typeof HARD_CEILING_MS]).toBeGreaterThan(0)
    }
  })

  it('no purpose can run anywhere near the 27-minute path', () => {
    for (const p of PURPOSES) {
      expect(HARD_CEILING_MS[p as keyof typeof HARD_CEILING_MS]).toBeLessThanOrEqual(180_000)
    }
  })

  it('aborts a provider that is stuck inside its own SDK retry loop', async () => {
    // The load-bearing assertion: the ceiling signal must reach INTO the
    // provider call. If it only bounded our own for-loop, this hangs forever
    // and the test times out.
    vi.useFakeTimers()
    const promise = completeWithFallback({ purpose: 'summary', messages: [] } as never)
    const assertion = expect(promise).rejects.toMatchObject({ code: 'timeout' })

    await vi.advanceTimersByTimeAsync(HARD_CEILING_MS.summary + 1_000)
    await assertion

    // It never got to burn the rest of the chain, either.
    expect(started.length).toBeLessThanOrEqual(1)
  })

  it('reports the ceiling distinctly from "every model rejected us"', async () => {
    vi.useFakeTimers()
    const promise = completeWithFallback({ purpose: 'summary', messages: [] } as never)
    const captured = promise.catch((e) => e)

    await vi.advanceTimersByTimeAsync(HARD_CEILING_MS.summary + 1_000)
    const err = await captured

    // Those are different problems with different user actions; collapsing
    // them is how the 27-minute path stayed invisible.
    expect(err).toBeInstanceOf(AIProviderError)
    expect(err.code).toBe('timeout')
    expect(err.message).toMatch(/took too long/i)
    // friendlyError() passes AIProviderError.message straight through, so
    // this is what the user actually reads.
    expect(err.message).toMatch(/try again/i)
  })

  it('does not interfere with a normal fast walk', async () => {
    // The ceiling must be invisible in the ordinary case: models that fail
    // fast still walk the whole chain and still end in chain-exhaustion.
    hang.enabled = false
    const err = await completeWithFallback({ purpose: 'summary', messages: [] } as never).catch((e) => e)

    expect(err.name).toBe('AllModelsExhaustedError')
    expect(started.length).toBeGreaterThan(1)
  })
})
