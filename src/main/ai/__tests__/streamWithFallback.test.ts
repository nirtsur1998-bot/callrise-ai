// M23 Workstream B — streamWithFallback()'s own new behavior on top of
// resolveChain() (already covered by resolveChain.test.ts): fall back to
// the next chain entry only BEFORE any delta has reached the caller; once
// streaming has begun, a failure ends the stream with an error instead of
// silently switching models mid-reply.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../app-settings', () => ({ loadAppSettings: vi.fn() }))
vi.mock('../fallback-log', () => ({ logFallbackEvent: vi.fn() }))
vi.mock('../index', () => ({ getActiveAIProvider: () => null }))
vi.mock('../model-catalog', () => ({
  catalogEntry: (id: string) => {
    if (id === 'test-model-a') {
      return { id: 'test-model-a', providerId: 'anthropic', modelId: 'model-a', knownStale: false }
    }
    if (id === 'test-model-b') {
      return { id: 'test-model-b', providerId: 'anthropic', modelId: 'model-b', knownStale: false }
    }
    return null
  }
}))

type StreamBehavior =
  | { kind: 'fail-immediately' }
  | { kind: 'yield-then-fail'; deltas: string[] }
  | { kind: 'succeed'; deltas: string[] }

const behaviorByModel = new Map<string, StreamBehavior>()

vi.mock('../registry', () => ({
  PROVIDER_REGISTRY: {
    anthropic: {
      displayName: 'Claude',
      keyEnvName: 'ANTHROPIC_API_KEY',
      build: () => ({
        id: 'anthropic',
        displayName: 'Claude',
        stream: (req: { model?: string }) => {
          const behavior = behaviorByModel.get(req.model ?? '') ?? { kind: 'fail-immediately' as const }
          async function* gen(): AsyncGenerator<{ delta: string }> {
            if (behavior.kind === 'fail-immediately') {
              throw new Error('provider unavailable')
            }
            if (behavior.kind === 'yield-then-fail') {
              for (const d of behavior.deltas) yield { delta: d }
              throw new Error('connection dropped mid-stream')
            }
            for (const d of behavior.deltas) yield { delta: d }
          }
          const iterable = gen()
          return Object.assign(iterable, {
            usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 })
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

async function collect(
  stream: ReturnType<typeof streamWithFallback>
): Promise<{ deltas: string[]; error: unknown | null; final: Awaited<typeof stream.final> | null }> {
  const deltas: string[] = []
  let error: unknown = null
  try {
    for await (const chunk of stream) deltas.push(chunk.delta)
  } catch (err) {
    error = err
  }
  let final: Awaited<typeof stream.final> | null = null
  try {
    final = await stream.final
  } catch {
    /* covered by `error` above when it rejects */
  }
  return { deltas, error, final }
}

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key'
  behaviorByModel.clear()
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  vi.mocked(loadAppSettings).mockReset()
})

describe('streamWithFallback', () => {
  it('falls back to the next entry when the first fails before any delta', async () => {
    vi.mocked(loadAppSettings).mockReturnValue(assignments(['test-model-a', 'test-model-b']))
    behaviorByModel.set('model-a', { kind: 'fail-immediately' })
    behaviorByModel.set('model-b', { kind: 'succeed', deltas: ['Hel', 'lo!'] })

    const result = collect(streamWithFallback({ purpose: 'coaching-chat', messages: [], maxTokens: 100 }))
    const { deltas, error, final } = await result

    expect(error).toBeNull()
    expect(deltas.join('')).toBe('Hello!')
    expect(final?.text).toBe('Hello!')
  })

  it('does NOT fall back once a delta has already been yielded, even if the same attempt later fails', async () => {
    vi.mocked(loadAppSettings).mockReturnValue(assignments(['test-model-a', 'test-model-b']))
    behaviorByModel.set('model-a', { kind: 'yield-then-fail', deltas: ['Par', 'tial'] })
    behaviorByModel.set('model-b', { kind: 'succeed', deltas: ['should never be reached'] })

    const { deltas, error } = await collect(
      streamWithFallback({ purpose: 'coaching-chat', messages: [], maxTokens: 100 })
    )

    // The partial text the caller already saw must be exactly what arrived
    // before the failure — never silently continued on a different model.
    expect(deltas.join('')).toBe('Partial')
    expect(error).not.toBeNull()
  })

  it('rejects with a no-key error when nothing is configured', async () => {
    vi.mocked(loadAppSettings).mockReturnValue(assignments([]))
    delete process.env.ANTHROPIC_API_KEY

    const { deltas, error } = await collect(
      streamWithFallback({ purpose: 'coaching-chat', messages: [], maxTokens: 100 })
    )
    expect(deltas).toEqual([])
    expect(error).not.toBeNull()
  })

  it('final resolves with the concatenated full text, not just the last chunk', async () => {
    vi.mocked(loadAppSettings).mockReturnValue(assignments(['test-model-a']))
    behaviorByModel.set('model-a', { kind: 'succeed', deltas: ['one ', 'two ', 'three'] })

    const { final } = await collect(streamWithFallback({ purpose: 'coaching-chat', messages: [], maxTokens: 100 }))
    expect(final?.text).toBe('one two three')
  })

  // Regression coverage for a review finding: the exhaustion branch used to
  // only wrap the last attempt's error in AllModelsExhaustedError when it
  // WASN'T already an AIProviderError — but every real provider throws
  // AIProviderError, so that branch was effectively dead code and callers
  // saw a raw per-attempt error message instead of the intended "every
  // configured model failed" summary. Now it's unconditional.
  it('rejects with AllModelsExhaustedError when every chain entry fails before any delta, regardless of error type', async () => {
    vi.mocked(loadAppSettings).mockReturnValue(assignments(['test-model-a', 'test-model-b']))
    behaviorByModel.set('model-a', { kind: 'fail-immediately' })
    behaviorByModel.set('model-b', { kind: 'fail-immediately' })

    const { deltas, error } = await collect(
      streamWithFallback({ purpose: 'coaching-chat', messages: [], maxTokens: 100 })
    )
    expect(deltas).toEqual([])
    expect(error).toBeInstanceOf(AllModelsExhaustedError)
    expect((error as InstanceType<typeof AllModelsExhaustedError>).attempts).toHaveLength(2)
  })
})
