// @vitest-environment happy-dom
//
// BUG-046 regression test: navigating away from a live call (any screen
// switch, not just an explicit Stop click) used to silently discard the
// whole in-progress transcript. The rest of this test suite runs in a plain
// Node environment (see vitest.config.ts) — this file opts into a DOM via
// the per-file pragma above so it can actually mount/unmount the real hook,
// since the bug is in React's unmount lifecycle itself, not in any function
// a Node-only test could exercise in isolation.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTranscription } from '../useTranscription'

// React only knows to batch/flush synchronously inside `act()` when told
// it's running under a test harness — normally done by whichever testing
// library owns `act`'s setup; done by hand here since this file drives
// `act` directly against real react-dom rather than through one.
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

// startRecorder touches getUserMedia/AudioContext/AudioWorklet, none of
// which happy-dom implements — replaced with a fake mic that "just works".
vi.mock('../audio/recorder', () => ({
  startRecorder: vi.fn(async () => fakeRecorder)
}))

// platform.ts reads window.electron.process at module-load time (the real
// preload bridge, not present under happy-dom) — stubbed rather than
// exercised, since which OS this "is" has no bearing on this bug.
vi.mock('@renderer/lib/platform', () => ({
  isMac: false,
  isWindows: true,
  supportsOtherPartyCapture: false
}))

type Handlers = {
  onState?: (p: { state: string }) => void
  onTranscript?: (p: Record<string, unknown>) => void
  onClosed?: () => void
}

function installMockApi(): { handlers: Handlers; save: ReturnType<typeof vi.fn> } {
  const handlers: Handlers = {}
  const save = vi.fn(async (input: unknown) => ({ id: 'saved-call-1', ...(input as object) }))
  const api = {
    transcription: {
      ensureMicAccess: vi.fn(async () => ({ status: 'granted' })),
      openMicSettings: vi.fn(async () => ({ ok: true })),
      start: vi.fn(async () => ({ ok: true, sessionId: 1 })),
      sendAudio: vi.fn(),
      requestAudioPort: vi.fn(),
      reportAudioDropped: vi.fn(),
      stop: vi.fn(async () => ({ ok: true })),
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
    app: {
      getActiveApp: vi.fn(async () => null)
    }
  }
  ;(window as unknown as { api: typeof api }).api = api
  return { handlers, save }
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

// A bare, no-JSX harness: calls the hook and hands its live return value out
// through a ref-like closure so the test can drive start/stop and unmount
// independently of any render output (this hook has no UI of its own).
function Harness({ onApi }: { onApi: (api: ReturnType<typeof useTranscription>) => void }): null {
  onApi(useTranscription())
  return null
}

describe('useTranscription — BUG-046 (unmount mid-call must not lose the transcript)', () => {
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

  it('saves the transcript when the screen unmounts mid-call without Stop ever being clicked', async () => {
    const { handlers, save } = installMockApi()
    let api!: ReturnType<typeof useTranscription>
    root = createRoot(container)
    act(() => {
      root.render(createElement(Harness, { onApi: (a) => (api = a) }))
    })

    await act(async () => {
      await api.start()
    })
    act(() => handlers.onState?.({ state: 'listening' }))
    act(() =>
      handlers.onTranscript?.({
        transcript: 'The buyer just agreed to a demo next Tuesday',
        words: [],
        isFinal: true,
        speechFinal: true,
        lagMs: 40,
        speakerEpoch: 0,
        speakerCertain: true,
        minConfidence: 0.95,
        multichannel: false
      })
    )

    expect(save).not.toHaveBeenCalled() // sanity: nothing saved yet, same as today

    // The rep clicks Settings (or any other sidebar item) instead of Stop —
    // this is a real React unmount, not a route/CSS change.
    act(() => root.unmount())
    await flushMicrotasks()

    expect(save).toHaveBeenCalledTimes(1)
    const savedInput = save.mock.calls[0][0] as { segments: Array<{ text: string }> }
    expect(savedInput.segments.some((s) => s.text.includes('demo next Tuesday'))).toBe(true)
  })

  it('does not create a phantom call when the screen unmounts before any words arrived', async () => {
    const { handlers, save } = installMockApi()
    let api!: ReturnType<typeof useTranscription>
    root = createRoot(container)
    act(() => {
      root.render(createElement(Harness, { onApi: (a) => (api = a) }))
    })

    await act(async () => {
      await api.start()
    })
    act(() => handlers.onState?.({ state: 'connecting' }))

    act(() => root.unmount())
    await flushMicrotasks()

    expect(save).not.toHaveBeenCalled()
  })

  it('does not double-save a call that was already stopped and flushed before unmount', async () => {
    const { handlers, save } = installMockApi()
    let api!: ReturnType<typeof useTranscription>
    root = createRoot(container)
    act(() => {
      root.render(createElement(Harness, { onApi: (a) => (api = a) }))
    })

    await act(async () => {
      await api.start()
    })
    act(() => handlers.onState?.({ state: 'listening' }))
    act(() =>
      handlers.onTranscript?.({
        transcript: 'Thanks for your time today',
        words: [],
        isFinal: true,
        speechFinal: true,
        lagMs: 40,
        speakerEpoch: 0,
        speakerCertain: true,
        minConfidence: 0.9,
        multichannel: false
      })
    )

    // The rep actually clicks Stop, and main confirms the session closed —
    // the normal, already-working save path.
    await act(async () => {
      await api.stop()
    })
    act(() => handlers.onClosed?.())
    await flushMicrotasks()
    expect(save).toHaveBeenCalledTimes(1)

    // Only THEN do they navigate away. Must not re-arm and re-save the same
    // call a second time.
    act(() => root.unmount())
    await flushMicrotasks()
    expect(save).toHaveBeenCalledTimes(1)
  })
})
