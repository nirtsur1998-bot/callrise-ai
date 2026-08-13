// @vitest-environment happy-dom
//
// M26 Phase 4.4 — the actual nav path, not a stand-in for it.
//
// useTranscription.unmount-save.test.ts (the original BUG-046 regression
// test) still exercises the hook directly and still passes unmodified — that
// proves the hotfix's OWN logic survived 4.4 byte-for-byte. What it CANNOT
// prove is whether hoisting the hook into LiveCallProvider actually achieves
// what this phase exists for: does an ordinary screen navigation (the inner
// consumer unmounting) leave the call running, and does a genuine
// provider-level teardown (the rare "the whole live-call subsystem is going
// away" case, e.g. sign-out) still save it? This file drives the REAL
// LiveCallProvider + the REAL useTranscription instance inside it, so the
// answer is about the actual wiring, not a description of it.
import { act, createElement, useEffect } from 'react'
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
  onClosed?: () => void
  onSegments?: (p: {
    callId: string
    seq: number
    from: number
    segments: Array<{ speaker: number; text: string }>
  }) => void
}

/** Same shape as the BUG-046 test's helper: main sends both the raw result
 *  (interim text / latency) and a transcript patch (the actual transcript)
 *  for every finalized turn. */
function makeSpeaker(handlers: Handlers): (text: string) => void {
  const spoken: Array<{ speaker: number; text: string }> = []
  let seq = -1
  return (text: string): void => {
    handlers.onTranscript?.({
      transcript: text,
      words: [],
      isFinal: true,
      speechFinal: true,
      lagMs: 40,
      speakerEpoch: 0,
      speakerCertain: true,
      minConfidence: 0.95,
      multichannel: false
    })
    const from = spoken.length
    spoken.push({ speaker: 0, text })
    seq += 1
    handlers.onSegments?.({ callId: 'call-1', seq, from, segments: spoken.slice(from) })
  }
}

function installMockApi(): {
  handlers: Handlers
  save: ReturnType<typeof vi.fn>
  detach: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
} {
  const handlers: Handlers = {}
  const save = vi.fn(async (input: unknown) => ({ id: 'saved-call-1', ...(input as object) }))
  const detach = vi.fn(async () => ({ ok: true }))
  const stop = vi.fn(async () => ({ ok: true, session: null }))
  const api = {
    transcription: {
      ensureMicAccess: vi.fn(async () => ({ status: 'granted' })),
      openMicSettings: vi.fn(async () => ({ ok: true })),
      start: vi.fn(async () => ({ ok: true, sessionId: 1 })),
      sendAudio: vi.fn(),
      requestAudioPort: vi.fn(),
      reportAudioDropped: vi.fn(),
      stop,
      detach,
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
      onClosed: vi.fn((cb: Handlers['onClosed']) => {
        handlers.onClosed = cb
        return () => {}
      }),
      onGap: vi.fn(() => () => {}),
      onHealth: vi.fn(() => () => {}),
      onCaptureLost: vi.fn(() => () => {}),
      onBuyerSilent: vi.fn(() => () => {}),
      onCrossTalkWarning: vi.fn(() => () => {}),
      onMultichannelFallback: vi.fn(() => () => {}),
      suggestQuestion: vi.fn(),
      askCoach: vi.fn(),
      liveCue: vi.fn()
    },
    calls: {
      save,
      summarizeCall: vi.fn(async () => ({ ok: true })),
      generateTitle: vi.fn(async () => ({ ok: true })),
      postCallBrief: vi.fn(async () => ({ ok: true, copied: false }))
    },
    settings: {
      get: vi.fn(async () => ({
        allowOtherPartyRecording: true,
        alwaysRecordOtherParty: false
      })),
      onChange: vi.fn(() => () => {})
    },
    app: { getActiveApp: vi.fn(async () => null) }
  }
  ;(window as unknown as { api: typeof api }).api = api
  return { handlers, save, detach, stop }
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** Stands in for LiveView: reads status/segments/start/stop from context
 *  exactly as LiveView does, AND replicates LiveView's own detach-on-unmount
 *  effect verbatim — that effect is the actual thing under test here, so a
 *  stand-in that omitted it would prove nothing about the real screen. */
function InnerConsumer({
  onApi
}: {
  onApi: (api: LiveCallContextValue) => void
}): null {
  onApi(useLiveCall())
  useEffect(() => {
    return () => {
      void window.api.transcription.detach()
    }
  }, [])
  return null
}

/** Renders the provider with the inner consumer conditionally present, so a
 *  test can unmount JUST the consumer (simulating navigation) while the
 *  provider — and the call it owns — keeps running. */
function Tree({
  showConsumer,
  onApi
}: {
  showConsumer: boolean
  onApi: (api: LiveCallContextValue) => void
}): React.JSX.Element {
  return createElement(
    LiveCallProvider,
    null,
    showConsumer ? createElement(InnerConsumer, { onApi }) : null
  )
}

describe('LiveCallProvider — the actual navigation path (M26 4.4)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    act(() => root?.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  it('an ordinary navigation detaches the view and leaves the call running — never saves, never stops', async () => {
    const { handlers, save, detach, stop } = installMockApi()
    let api!: LiveCallContextValue
    root = createRoot(container)
    act(() => {
      root.render(createElement(Tree, { showConsumer: true, onApi: (a) => (api = a) }))
    })

    await act(async () => {
      await api.start()
    })
    act(() => handlers.onState?.({ state: 'listening' }))
    act(() => makeSpeaker(handlers)('we were just getting to the good part'))

    // The rep clicks Settings, or any other sidebar item — LiveView (the
    // inner consumer) unmounts. The provider, and everything it owns, does
    // not: this render call omits the consumer but keeps the provider.
    act(() => {
      root.render(createElement(Tree, { showConsumer: false, onApi: (a) => (api = a) }))
    })
    await flushMicrotasks()

    // This is the whole point of the phase: a screen going away must not be
    // indistinguishable from a call ending.
    expect(save).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
    expect(detach).toHaveBeenCalledTimes(1)
  })

  it('the call is still there, still accumulating, after the view remounts', async () => {
    const { handlers } = installMockApi()
    let api!: LiveCallContextValue
    root = createRoot(container)
    act(() => {
      root.render(createElement(Tree, { showConsumer: true, onApi: (a) => (api = a) }))
    })

    await act(async () => {
      await api.start()
    })
    act(() => handlers.onState?.({ state: 'listening' }))
    // ONE speaker instance for the whole test — its sequence numbering has to
    // stay continuous across the navigation, matching what main's real patch
    // stream does (main has no notion of "the view left and came back").
    const speak = makeSpeaker(handlers)
    act(() => speak('said before navigating away'))

    act(() => {
      root.render(createElement(Tree, { showConsumer: false, onApi: (a) => (api = a) }))
    })
    await flushMicrotasks()

    // Back to Live Calls. A fresh InnerConsumer instance reads from the SAME
    // provider — this is not a new call, it's the same one, mid-flight.
    act(() => {
      root.render(createElement(Tree, { showConsumer: true, onApi: (a) => (api = a) }))
    })
    expect(api.segments.map((s) => s.text)).toEqual(['said before navigating away'])
    expect(api.status).toBe('listening')

    act(() => speak('and this after coming back'))
    expect(api.segments.map((s) => s.text)).toEqual([
      'said before navigating away',
      'and this after coming back'
    ])
  })

  it('a genuine provider-level teardown still saves — the hotfix, alive for the case it still covers', async () => {
    const { handlers, save } = installMockApi()
    let api!: LiveCallContextValue
    root = createRoot(container)
    act(() => {
      root.render(createElement(Tree, { showConsumer: true, onApi: (a) => (api = a) }))
    })

    await act(async () => {
      await api.start()
    })
    act(() => handlers.onState?.({ state: 'listening' }))
    act(() => makeSpeaker(handlers)('a call in progress when the provider itself goes away'))

    // Not a navigation — the whole provider unmounts, the rare case (e.g.
    // sign-out) where useTranscription.ts's own unmount effect — completely
    // untouched by this phase — is exactly what should fire.
    act(() => root.unmount())
    await flushMicrotasks()

    expect(save).toHaveBeenCalledTimes(1)
    const saved = save.mock.calls[0][0] as { segments: Array<{ text: string }> }
    expect(
      saved.segments.some((s) => s.text.includes('provider itself goes away'))
    ).toBe(true)
  })
})
