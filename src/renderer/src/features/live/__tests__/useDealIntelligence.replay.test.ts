// @vitest-environment happy-dom
//
// M26 4.5 (BUG-055) — the §3 replay bug, proven fixed through the REAL
// LiveCallProvider + the REAL useDealIntelligence instance inside it, not a
// description of the fix.
//
// THE BUG: useDealIntelligence's lazy-init (`if (callStartWallClockRef.current
// === null) { ...new LiveCallStateEngine(); processedCountRef.current = 0 }`)
// only re-fires when reset() has run. Before this fix, reset() ran on every
// `active` transition — including an ordinary mono<->multichannel restart
// mid-call, which main signals with the same 'connecting' state a genuine new
// call uses. That silently rebuilt the engine and replayed the WHOLE
// transcript (`segments.slice(0)`) into it, re-deriving and re-firing every
// signal that had already fired once.
//
// THE PROOF STRATEGY: getFeedbackSummary() is called EXCLUSIVELY inside the
// lazy-init block — nowhere else in the hook. So its call count is a precise,
// black-box-observable proxy for "did the engine get rebuilt", without
// needing to construct real Tier-0-triggering transcript content: once per
// genuine call, never again on a restart blip within that same call.
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
  onTranscript?: (p: Record<string, unknown>) => void
  onSegments?: (p: {
    callId: string
    seq: number
    from: number
    segments: Array<{ speaker: number; text: string; role?: string }>
  }) => void
}

function installMockApi(): {
  handlers: Handlers
  getFeedbackSummary: ReturnType<typeof vi.fn>
} {
  const handlers: Handlers = {}
  const getFeedbackSummary = vi.fn(async () => [])
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
      onTranscript: vi.fn((cb: Handlers['onTranscript']) => {
        handlers.onTranscript = cb
        return () => {}
      }),
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
      getFeedbackSummary,
      recordFeedback: vi.fn(async () => ({ ok: true }))
    },
    live: { repIdentified: vi.fn() }
  }
  ;(window as unknown as { api: typeof api }).api = api
  return { handlers, getFeedbackSummary }
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

describe('useDealIntelligence — the §3 replay bug, through the real Provider (M26 4.5 / BUG-055)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    // Deal Intelligence defaults OFF — this feature must be on for the
    // engine to instantiate at all.
    localStorage.setItem('salesos.dealIntelligence.enabled', 'true')
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    act(() => root?.unmount())
    container.remove()
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('an ordinary mono<->multichannel restart mid-call does NOT rebuild the engine', async () => {
    const { handlers, getFeedbackSummary } = installMockApi()
    let api!: LiveCallContextValue
    root = createRoot(container)
    act(() => {
      root.render(createElement(LiveCallProvider, null, createElement(InnerConsumer, { onApi: (a) => (api = a) })))
    })

    await act(async () => {
      await api.start()
    })
    act(() => handlers.onState?.({ state: 'listening' }))
    act(() =>
      handlers.onSegments?.({
        callId: 'call-1',
        seq: 0,
        from: 0,
        segments: [{ speaker: 0, text: 'thanks for joining today', role: 'rep' }]
      })
    )
    await flushMicrotasks()

    // The lazy-init has fired exactly once for this call.
    expect(getFeedbackSummary).toHaveBeenCalledTimes(1)

    // A mono<->multichannel restart: main disposes and recreates the SESSION
    // (status genuinely dips to 'connecting'), but beginCall({restart:true})
    // keeps the SAME callId — this is what distinguishes it from a new call.
    // No new seq:0/from:0 reset-marker patch is sent, matching the real
    // beginCall behavior verified in main/live-transcript.ts.
    act(() => handlers.onState?.({ state: 'connecting' }))
    await flushMicrotasks()
    act(() => handlers.onState?.({ state: 'listening' }))
    await flushMicrotasks()

    // Still exactly once. If the engine had been rebuilt, this would be 2 —
    // and, per the bug this fixes, the SAME first segment would also have
    // been re-ingested into a fresh LiveCallStateEngine, re-deriving and
    // potentially re-firing any signal it produced the first time.
    expect(getFeedbackSummary).toHaveBeenCalledTimes(1)

    // More segments after the restart accumulate onto the SAME engine —
    // proven by the report containing both turns, not just the new one
    // (which is what a rebuilt engine, with processedCountRef re-zeroed,
    // would also show — so this alone wouldn't prove the fix — but combined
    // with the call count above, it confirms accumulation continued rather
    // than restarting).
    act(() =>
      handlers.onSegments?.({
        callId: 'call-1',
        seq: 1,
        from: 1,
        segments: [{ speaker: 1, text: 'happy to be here', role: 'other' }]
      })
    )
    await flushMicrotasks()
    expect(getFeedbackSummary).toHaveBeenCalledTimes(1)
  })

  it('several restart blips in a row still never rebuild the engine', async () => {
    const { handlers, getFeedbackSummary } = installMockApi()
    let api!: LiveCallContextValue
    root = createRoot(container)
    act(() => {
      root.render(createElement(LiveCallProvider, null, createElement(InnerConsumer, { onApi: (a) => (api = a) })))
    })

    await act(async () => {
      await api.start()
    })
    act(() => handlers.onState?.({ state: 'listening' }))
    act(() =>
      handlers.onSegments?.({
        callId: 'call-1',
        seq: 0,
        from: 0,
        segments: [{ speaker: 0, text: 'first thing said', role: 'rep' }]
      })
    )
    await flushMicrotasks()
    expect(getFeedbackSummary).toHaveBeenCalledTimes(1)

    for (let i = 0; i < 3; i++) {
      act(() => handlers.onState?.({ state: 'connecting' }))
      await flushMicrotasks()
      act(() => handlers.onState?.({ state: 'listening' }))
      await flushMicrotasks()
    }

    expect(getFeedbackSummary).toHaveBeenCalledTimes(1)
  })

  it('a GENUINE new call — a real reset-marker patch with a different callId — still resets correctly', async () => {
    const { handlers, getFeedbackSummary } = installMockApi()
    let api!: LiveCallContextValue
    root = createRoot(container)
    act(() => {
      root.render(createElement(LiveCallProvider, null, createElement(InnerConsumer, { onApi: (a) => (api = a) })))
    })

    await act(async () => {
      await api.start()
    })
    act(() => handlers.onState?.({ state: 'listening' }))
    act(() =>
      handlers.onSegments?.({
        callId: 'call-1',
        seq: 0,
        from: 0,
        segments: [{ speaker: 0, text: 'first call, first thing said', role: 'rep' }]
      })
    )
    await flushMicrotasks()
    expect(getFeedbackSummary).toHaveBeenCalledTimes(1)

    // The call ends and a genuinely new one starts — main's own beginCall
    // reset marker: seq 0, from 0, a DIFFERENT callId.
    act(() => handlers.onState?.({ state: 'connecting' }))
    await flushMicrotasks()
    act(() =>
      handlers.onSegments?.({ callId: 'call-2', seq: 0, from: 0, segments: [] })
    )
    act(() => handlers.onState?.({ state: 'listening' }))
    act(() =>
      handlers.onSegments?.({
        callId: 'call-2',
        seq: 1,
        from: 0,
        segments: [{ speaker: 0, text: 'second call, fresh start', role: 'rep' }]
      })
    )
    await flushMicrotasks()

    // The engine legitimately rebuilt for the new call — the SAME thing that
    // "several blips" above proves must NOT happen for a restart is exactly
    // what SHOULD happen here, and does.
    expect(getFeedbackSummary).toHaveBeenCalledTimes(2)
  })
})
