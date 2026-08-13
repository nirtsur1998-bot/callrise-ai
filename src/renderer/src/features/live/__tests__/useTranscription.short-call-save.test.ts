// @vitest-environment happy-dom
//
// BUG-053 regression test: pressing Stop on a SHORT call used to lose the
// whole thing, through the primary button, with the rep doing exactly the
// right thing.
//
// The ordering that caused it: stopping sends Deepgram a Finalize and keeps
// the socket open ~1.5s so the last words still arrive (STOP_FLUSH_MS in
// main/transcription.ts). armSave() ran BEFORE those words landed, and it
// decided then and there whether there was anything worth saving
// (`savePendingRef = segmentsRef.current.length > 0`). On a call short
// enough that everything spoken was still interim at that moment, it
// latched false — then the final words arrived, and flushPendingSave bailed
// on its first line for a call that did have content.
//
// The fix makes armSave record INTENT only; "is there anything to save?" is
// answered in flushPendingSave against segmentsRef at flush time, which is
// after the final words have arrived.
//
// Runs in a DOM (the rest of the suite is Node) because the bug lives in the
// interaction between React refs and the real event ordering, not in any
// function a Node-only test could reach.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTranscription } from '../useTranscription'

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

vi.mock('../audio/recorder', () => ({
  startRecorder: vi.fn(async () => fakeRecorder)
}))

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
    app: { getActiveApp: vi.fn(async () => null) }
  }
  ;(window as unknown as { api: typeof api }).api = api
  return { handlers, save }
}

function finalTranscript(text: string): Record<string, unknown> {
  return {
    transcript: text,
    words: [],
    isFinal: true,
    speechFinal: true,
    lagMs: 40,
    speakerEpoch: 0,
    speakerCertain: true,
    minConfidence: 0.95,
    multichannel: false
  }
}

function Harness({ onApi }: { onApi: (api: ReturnType<typeof useTranscription>) => void }): null {
  onApi(useTranscription())
  return null
}

describe('useTranscription — BUG-053 (Stop on a short call must not lose it)', () => {
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

  async function startCall(): Promise<{
    api: ReturnType<typeof useTranscription>
    handlers: Handlers
    save: ReturnType<typeof vi.fn>
  }> {
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
    return { api, handlers, save }
  }

  it('saves a call whose ONLY words arrive after Stop, in the Finalize flush', async () => {
    const { api, handlers, save } = await startCall()

    // The whole point: nothing has finalized yet when Stop is pressed. This
    // is an ordinary short call, not an exotic edge case.
    await act(async () => {
      await api.stop()
    })
    expect(save).not.toHaveBeenCalled()

    // Deepgram's Finalize now delivers the only words of the call...
    act(() => handlers.onTranscript?.(finalTranscript('Sounds good, I will send that over')))
    // ...and the session closes, which is what triggers the save.
    await act(async () => {
      handlers.onClosed?.()
      await Promise.resolve()
    })

    expect(save).toHaveBeenCalledTimes(1)
    const saved = save.mock.calls[0][0] as { segments: { text: string }[] }
    expect(saved.segments).toHaveLength(1)
    expect(saved.segments[0].text).toContain('Sounds good')
  })

  it('still saves the ordinary case where words arrived BEFORE Stop', async () => {
    const { api, handlers, save } = await startCall()

    act(() => handlers.onTranscript?.(finalTranscript('The buyer agreed to a demo')))
    await act(async () => {
      await api.stop()
    })
    await act(async () => {
      handlers.onClosed?.()
      await Promise.resolve()
    })

    expect(save).toHaveBeenCalledTimes(1)
    const saved = save.mock.calls[0][0] as { segments: { text: string }[] }
    expect(saved.segments[0].text).toContain('The buyer agreed')
  })

  it('saves words from BOTH before and after Stop, in order', async () => {
    const { api, handlers, save } = await startCall()

    act(() => handlers.onTranscript?.(finalTranscript('First half before stop')))
    await act(async () => {
      await api.stop()
    })
    act(() => handlers.onTranscript?.(finalTranscript('Second half in the flush')))
    await act(async () => {
      handlers.onClosed?.()
      await Promise.resolve()
    })

    const saved = save.mock.calls[0][0] as { segments: { text: string }[] }
    const allText = saved.segments.map((s) => s.text).join(' ')
    expect(allText).toContain('First half before stop')
    expect(allText).toContain('Second half in the flush')
  })

  it('a genuinely wordless call still writes NOTHING — intent alone must not create a phantom call', async () => {
    const { api, handlers, save } = await startCall()

    await act(async () => {
      await api.stop()
    })
    // No transcript ever arrives, before or after Stop.
    await act(async () => {
      handlers.onClosed?.()
      await Promise.resolve()
    })

    expect(save).not.toHaveBeenCalled()
  })

  it('saves exactly once even if the close fires more than once', async () => {
    const { api, handlers, save } = await startCall()

    act(() => handlers.onTranscript?.(finalTranscript('Only say this once')))
    await act(async () => {
      await api.stop()
    })
    await act(async () => {
      handlers.onClosed?.()
      handlers.onClosed?.()
      await Promise.resolve()
    })

    expect(save).toHaveBeenCalledTimes(1)
  })
})
