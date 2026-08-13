// @vitest-environment happy-dom
//
// BUG-057 Phase 2 — runTier1Pass/runTier2Pass used to set status via a
// boolean-shaped check (`outcome.pausedReason === 'all-models-unavailable'
// ? 'paused' : 'active'`), so a genuine 'timed-out' outcome fell through to
// 'active' — actively claiming "working fine" for a pass that just failed.
// Fixed to a three-way ternary. These tests drive the REAL useDealIntelligence
// hook through the real LiveCallProvider + a real segment → engine →
// runTier1Pass call, with only window.api mocked (the claim under test is
// OUR OWN status-routing ternary, not IPC or AI-provider behaviour — the
// same boundary the main-process pausedReason tests already draw).
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LiveCallProvider } from '../LiveCallProvider'
import { useLiveCall, type LiveCallContextValue } from '../useLiveCall'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { fakeRecorder } = vi.hoisted(() => ({
  fakeRecorder: {
    analyser: {},
    sampleRate: 48000,
    setPaused: () => {},
    stop: () => {},
    attachLoopback: () => {},
    detachLoopback: () => {},
    setStereo: () => {},
    isLoopbackAttached: () => false,
    usingDirectPath: () => false
  }
}))

vi.mock('../audio/recorder', () => ({ startRecorder: vi.fn(async () => fakeRecorder) }))
vi.mock('@renderer/lib/platform', () => ({
  isMac: false,
  isWindows: true,
  supportsOtherPartyCapture: false
}))

type Handlers = {
  onState?: (p: { state: string }) => void
  onSegments?: (p: {
    callId: string
    seq: number
    from: number
    segments: Array<{ speaker: number; text: string; role?: string }>
  }) => void
}

function installMockApi(analyzeTier1Result: unknown): {
  handlers: Handlers
  analyzeTier1: ReturnType<typeof vi.fn>
} {
  const handlers: Handlers = {}
  const analyzeTier1 = vi.fn(async () => analyzeTier1Result)
  const api = {
    transcription: {
      ensureMicAccess: vi.fn(async () => ({ status: 'granted' })),
      openMicSettings: vi.fn(async () => ({ ok: true })),
      start: vi.fn(async () => ({ ok: true, sessionId: 1 })),
      sendAudio: vi.fn(),
      requestAudioPort: vi.fn(),
      reportAudioDropped: vi.fn(),
      stop: vi.fn(async () => ({ ok: true, session: null })),
      detach: vi.fn(async () => ({ ok: true })),
      attach: vi.fn(async () => ({ session: null, call: null })),
      onSegments: vi.fn((cb: Handlers['onSegments']) => {
        handlers.onSegments = cb
        return () => {}
      }),
      onState: vi.fn((cb: Handlers['onState']) => {
        handlers.onState = cb
        return () => {}
      }),
      onTranscript: vi.fn(() => () => {}),
      onError: vi.fn(() => () => {}),
      onUtteranceEnd: vi.fn(() => () => {}),
      onClosed: vi.fn(() => () => {}),
      onGap: vi.fn(() => () => {}),
      onHealth: vi.fn(() => () => {}),
      onCaptureLost: vi.fn(() => () => {}),
      onBuyerSilent: vi.fn(() => () => {}),
      onCrossTalkWarning: vi.fn(() => () => {}),
      onMultichannelFallback: vi.fn(() => () => {}),
      suggestQuestion: vi.fn(),
      askCoach: vi.fn(),
      liveCue: vi.fn(async () => ({ ok: false }))
    },
    calls: {
      save: vi.fn(async (input: unknown) => ({ id: 'saved-call-1', ...(input as object) })),
      summarizeCall: vi.fn(async () => ({ ok: true })),
      generateTitle: vi.fn(async () => ({ ok: true })),
      postCallBrief: vi.fn(async () => ({ ok: true, copied: false }))
    },
    settings: {
      get: vi.fn(async () => ({ allowOtherPartyRecording: true, alwaysRecordOtherParty: false })),
      onChange: vi.fn(() => () => {})
    },
    app: { getActiveApp: vi.fn(async () => null) },
    trackers: { list: vi.fn(async () => []) },
    dealIntelligence: {
      getFeedbackSummary: vi.fn(async () => []),
      recordFeedback: vi.fn(async () => ({ ok: true })),
      analyzeTier1,
      analyzeTier2: vi.fn(async () => ({ ok: false }))
    },
    live: { repIdentified: vi.fn() }
  }
  ;(window as unknown as { api: typeof api }).api = api
  return { handlers, analyzeTier1 }
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function InnerConsumer({ onApi }: { onApi: (api: LiveCallContextValue) => void }): null {
  onApi(useLiveCall())
  return null
}

// TIER1_INTERVAL_MS (20_000) * FREQUENCY_MULTIPLIER['balanced'] (1) — the
// "routine check-in" cadence that fires runTier1Pass regardless of any
// Tier-0 signal, as long as at least one turn is queued.
const TIER1_ROUTINE_INTERVAL_MS = 20_000

describe('useDealIntelligence — status routing on pausedReason (BUG-057 Phase 2)', () => {
  let container: HTMLDivElement
  let root: Root
  // A LIVE box the whole test reads from, not a one-time snapshot: the
  // context value LiveCallProvider hands out is a fresh object every render,
  // so a plain `const api = await startX()` return value would freeze at
  // whatever `status` was the moment that helper returned — long before the
  // 20s-later Tier 1 pass even runs. `onApi` keeps reassigning `box.current`
  // on every InnerConsumer re-render for the rest of the test, so later
  // reads see the actual current state.
  let box: { current: LiveCallContextValue }

  beforeEach(() => {
    localStorage.setItem('salesos.dealIntelligence.enabled', 'true')
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
    box = { current: undefined as unknown as LiveCallContextValue }
  })

  afterEach(() => {
    act(() => root?.unmount())
    container.remove()
    localStorage.clear()
    vi.useRealTimers()
  })

  async function startCallWithOneSegment(handlers: Handlers): Promise<void> {
    root = createRoot(container)
    act(() => {
      root.render(
        createElement(LiveCallProvider, null, createElement(InnerConsumer, { onApi: (a) => (box.current = a) }))
      )
    })
    await act(async () => {
      await box.current.start()
    })
    act(() => handlers.onState?.({ state: 'listening' }))
    act(() =>
      handlers.onSegments?.({
        callId: 'call-1',
        seq: 0,
        from: 0,
        segments: [{ speaker: 0, text: 'thanks for joining today, excited to talk pricing', role: 'rep' }]
      })
    )
    await flushMicrotasks()
  }

  async function advancePastRoutineTier1(): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TIER1_ROUTINE_INTERVAL_MS + 1000)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('a HARD_CEILING_MS timeout on Tier 1 sets status to timed-out, not active', async () => {
    const { handlers } = installMockApi({ ok: false, pausedReason: 'timed-out' })
    await startCallWithOneSegment(handlers)

    await advancePastRoutineTier1()

    expect(box.current.dealIntelligence.status).toBe('timed-out')
  })

  it('every model cooling down on Tier 1 sets status to paused', async () => {
    const { handlers } = installMockApi({ ok: false, pausedReason: 'all-models-unavailable' })
    await startCallWithOneSegment(handlers)

    await advancePastRoutineTier1()

    expect(box.current.dealIntelligence.status).toBe('paused')
  })

  it('an ordinary one-off Tier 1 failure (no pausedReason) leaves status active (unchanged)', async () => {
    const { handlers } = installMockApi({ ok: false })
    await startCallWithOneSegment(handlers)

    await advancePastRoutineTier1()

    expect(box.current.dealIntelligence.status).toBe('active')
  })

  it('a subsequent Tier 1 success restores status to active from timed-out', async () => {
    const { handlers, analyzeTier1 } = installMockApi({ ok: false, pausedReason: 'timed-out' })
    await startCallWithOneSegment(handlers)

    await advancePastRoutineTier1()
    expect(box.current.dealIntelligence.status).toBe('timed-out')

    analyzeTier1.mockResolvedValue({ ok: true, signals: [] })
    // Queue another turn so the next routine pass has something to send —
    // runTier1Pass no-ops when pendingTier1TurnsRef is empty.
    act(() =>
      handlers.onSegments?.({
        callId: 'call-1',
        seq: 1,
        from: 1,
        segments: [{ speaker: 1, text: 'yes, walk me through the tiers please', role: 'other' }]
      })
    )
    await flushMicrotasks()
    await advancePastRoutineTier1()

    expect(box.current.dealIntelligence.status).toBe('active')
  })
})
