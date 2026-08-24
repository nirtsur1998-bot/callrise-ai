// AUDIT FIX (2026-08-24) — Stop's reach into the real provider walk had ZERO
// tests.
//
// The gap: assistant-ipc.turn.test.ts mocks streamWithFallback entirely and
// its mock wires up its own abort behaviour, so the three cancel tests there
// prove only that the turn engine HANDS OVER a signal and calls .abort() —
// nothing about whether the walk forwards that signal to the provider. On
// this side, `if (req.signal) parts.push(req.signal)` in
// complete-with-fallback.ts is the single line that lets a caller's Stop
// reach a live request, and no test anywhere passed a `signal` to
// streamWithFallback: every existing call site is
// `{ purpose: 'coaching-chat', messages: [] }`. Deleting that line left all
// 245 AI tests green.
//
// Why it matters beyond tidiness: M28's Rise surface is the FIRST caller that
// threads its own signal (hardCeiling.test.ts's header still says
// "coaching-chat is this function's only consumer, and it never threads a
// signal of its own" — stale as of M28). If that line regresses, pressing
// Stop halts the UI while the provider request runs to completion in the
// background, burning the free-tier budget BUG-058 exists to protect and
// defeating the BUG-060 lesson ("cancel must reach the actual work") that
// M28's design doc cites as a headline guarantee.
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

/** The signal the PROVIDER was actually handed — the thing under test. */
const seen = vi.hoisted(() => ({
  signal: null as AbortSignal | null,
  /** Releases the parked provider generator so the stream can finish. */
  release: [] as (() => void)[]
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
          seen.signal = req.signal ?? null
          // Yields one delta then PARKS, so the test can observe the signal
          // while the "request" is still in flight — exactly the state a user
          // is in when they press Stop. The park ends on abort (a real
          // provider's fetch would reject) or when the test releases it.
          async function* gen(): AsyncGenerator<{ delta: string }> {
            yield { delta: 'partial' }
            await new Promise<void>((resolve) => {
              if (req.signal?.aborted) return resolve()
              req.signal?.addEventListener('abort', () => resolve(), { once: true })
              seen.release.push(resolve)
            })
          }
          return Object.assign(gen(), {
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
const { streamWithFallback } = await import('../complete-with-fallback')
const { resetCooldownsForTests } = await import('../model-cooldown')
const { resetPacingForTests } = await import('../model-pacing')

function assignments(purpose: string, chain: string[]): ReturnType<typeof loadAppSettings> {
  return {
    aiModelAssignments: { [purpose]: { chain } }
  } as unknown as ReturnType<typeof loadAppSettings>
}

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  resetCooldownsForTests()
  resetPacingForTests()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  seen.signal = null
  seen.release = []
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  vi.mocked(loadAppSettings).mockReset()
})

describe("streamWithFallback — the caller's abort signal reaches the provider", () => {
  it('aborting the caller signal aborts the signal the provider is holding', async () => {
    vi.mocked(loadAppSettings).mockReturnValue(assignments('assistant-chat', ['test-model-a']))
    const controller = new AbortController()

    const stream = streamWithFallback({
      purpose: 'assistant-chat',
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 100,
      signal: controller.signal
    })

    // Consume the first delta so the provider request is genuinely in flight.
    const iterator = stream[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.value).toEqual({ delta: 'partial' })

    expect(seen.signal, 'the provider was handed no signal at all').not.toBeNull()
    expect(seen.signal!.aborted, 'provider signal aborted before Stop was pressed').toBe(false)

    // THE ASSERTION: pressing Stop must reach the live provider request.
    controller.abort()
    expect(
      seen.signal!.aborted,
      "the caller's signal did not reach the provider — Stop would halt the UI while the " +
        'request kept running and kept spending quota'
    ).toBe(true)

    // Close the suspended generator rather than awaiting stream.final:
    // the walk is parked AT its yield, so final can only resolve if someone
    // keeps pulling. iterator.return() ends it cleanly.
    await iterator.return?.(undefined)
  })

  it('with no caller signal the provider still gets the ceiling signal, un-aborted', async () => {
    vi.mocked(loadAppSettings).mockReturnValue(assignments('assistant-chat', ['test-model-a']))

    const stream = streamWithFallback({
      purpose: 'assistant-chat',
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 100
    })
    const iterator = stream[Symbol.asyncIterator]()
    await iterator.next()

    // Control: proves the previous test's pass comes from req.signal being
    // threaded, not from the ceiling signal happening to be aborted.
    expect(seen.signal).not.toBeNull()
    expect(seen.signal!.aborted).toBe(false)

    seen.release.forEach((r) => r())
    await iterator.return?.(undefined)
  })
})
