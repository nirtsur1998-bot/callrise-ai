// M27 A1 — streamWithFallback() had NO wall-clock ceiling at all, unlike its
// non-streaming sibling completeWithFallback() (BUG-059). coaching-chat is
// this function's only consumer, and it never threads a signal of its own
// (coaching-chat-ipc.ts), so a provider stuck inside its own SDK retry loop
// (or simply slow) had nothing bounding it — worst case was the full
// fallback chain x LATENCY_POLICY's per-attempt timeout, unboundedly, with
// no way to cancel out of it.
//
// Mirrors hardCeiling.test.ts's own mock shape and its own honest framing:
// a mock whose stream() only settles when the signal it was handed aborts
// proves the ceiling signal reaches INTO the provider call (not just this
// file's own for-loop) — it does not prove a real, uncooperative SDK would
// behave the same way; that is what realSdkRetryAndCooldown.test.ts is for
// on the non-streaming side. No equivalent exists yet for streaming because
// this is the first ceiling this path has ever had.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AIProviderError, HARD_CEILING_MS } from '../types'

const started: string[] = []
const hang = { enabled: true }

vi.mock('../../app-settings', () => ({ loadAppSettings: vi.fn() }))
vi.mock('../fallback-log', () => ({ logFallbackEvent: vi.fn() }))
vi.mock('../index', () => ({ getActiveAIProvider: () => null }))
vi.mock('../model-catalog', () => ({
  catalogEntry: (id: string) => {
    if (id === 'test-model-a') {
      return { id: 'test-model-a', providerId: 'anthropic', modelId: 'model-a', knownStale: false }
    }
    return null
  }
}))
vi.mock('../registry', () => ({
  PROVIDER_REGISTRY: {
    anthropic: {
      displayName: 'Claude',
      keyEnvName: 'ANTHROPIC_API_KEY',
      build: () => ({
        id: 'anthropic',
        displayName: 'Claude',
        stream: (req: { signal?: AbortSignal }) => {
          started.push('anthropic')
          async function* gen(): AsyncGenerator<{ delta: string }> {
            if (!hang.enabled) {
              throw new AIProviderError('failed', 'anthropic failed fast')
            }
            // Simulates a provider whose SDK is retrying internally: it
            // never yields on its own and only settles when the signal it
            // was handed aborts. If the ceiling did not reach the SDK, this
            // hangs forever and the test times out.
            await new Promise((_resolve, reject) => {
              const s = req.signal
              if (!s) return // no signal => hangs forever, which is the bug
              if (s.aborted) {
                reject(new AIProviderError('timeout', 'aborted'))
                return
              }
              s.addEventListener('abort', () => reject(new AIProviderError('timeout', 'aborted')))
            })
            yield { delta: 'unreachable' } // never reached in the hang case
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
const { streamWithFallback } = await import('../complete-with-fallback')
const { resetCooldownsForTests } = await import('../model-cooldown')
const { resetPacingForTests } = await import('../model-pacing')

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
      'coaching-chat': { chain }
    }
  } as unknown as ReturnType<typeof loadAppSettings>
}

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  resetCooldownsForTests()
  resetPacingForTests()
  started.length = 0
  hang.enabled = true
  process.env.ANTHROPIC_API_KEY = 'test-key'
  vi.mocked(loadAppSettings).mockReturnValue(assignments(['test-model-a']))
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  vi.mocked(loadAppSettings).mockReset()
  vi.useRealTimers()
})

describe('streamWithFallback — the hard wall-clock ceiling (M27 A1)', () => {
  it('aborts a provider stuck inside its own SDK retry loop', async () => {
    vi.useFakeTimers()
    const stream = streamWithFallback({ purpose: 'coaching-chat', messages: [], maxTokens: 100 })
    const iterationFailed = (async () => {
      try {
        for await (const _chunk of stream) {
          /* no deltas expected before the ceiling fires */
        }
        return null
      } catch (err) {
        return err
      }
    })()
    const finalRejected = stream.final.catch((err) => err)

    await vi.advanceTimersByTimeAsync(HARD_CEILING_MS['coaching-chat'] + 1_000)

    const [iterErr, finalErr] = await Promise.all([iterationFailed, finalRejected])
    expect(iterErr).toMatchObject({ code: 'timeout' })
    expect(finalErr).toMatchObject({ code: 'timeout' })
    // It never got to burn a retry of the same model past the ceiling firing.
    expect(started.length).toBeLessThanOrEqual(1)
  })

  it('reports the ceiling distinctly from "every model rejected us"', async () => {
    vi.useFakeTimers()
    const stream = streamWithFallback({ purpose: 'coaching-chat', messages: [], maxTokens: 100 })
    const finalRejected = stream.final.catch((err) => err)
    const drain = (async () => {
      try {
        for await (const _chunk of stream) {
          /* drain */
        }
      } catch {
        /* asserted via finalRejected */
      }
    })()

    await vi.advanceTimersByTimeAsync(HARD_CEILING_MS['coaching-chat'] + 1_000)
    await drain
    const err = await finalRejected

    expect(err).toBeInstanceOf(AIProviderError)
    expect(err.code).toBe('timeout')
    expect(err.message).toMatch(/took too long/i)
    expect(err.message).toMatch(/try again/i)
  })

  it('does not interfere with a normal fast walk', async () => {
    // The ceiling must be invisible in the ordinary case: a model that fails
    // fast still ends in the normal chain-exhaustion path, not a timeout.
    // Async generators are lazy — the loop that actually calls provider.stream()
    // never runs until the caller iterates, so `final` must be raced against a
    // drain of the stream itself, same as every other test in this file.
    hang.enabled = false
    const stream = streamWithFallback({ purpose: 'coaching-chat', messages: [], maxTokens: 100 })
    const finalSettled = stream.final.catch((e) => e)
    try {
      for await (const _chunk of stream) {
        /* drain — no deltas expected, the one configured model fails immediately */
      }
    } catch {
      /* asserted via finalSettled below */
    }
    const err = await finalSettled

    expect(err.name).toBe('AllModelsExhaustedError')
    expect(started.length).toBeGreaterThan(0)
  })
})
