// @vitest-environment happy-dom
//
// BUG-227's missing link, and the founder named it exactly: "the exact
// sequence the save handler runs, driven in the running app" and "the save
// handler actually CALLS that sequence when a call ends" are different claims.
// The second is the one that was broken for five weeks with nobody noticing.
//
// WHAT HID IT. Every piece worked. The setting existed, the IPC worked, the AI
// worked, the save worked — and the one link nothing checked was the line that
// decides whether to run any of it. A driver cannot reach that link (it would
// have to speak into a microphone for eight minutes), and no unit test covered
// it, so a preference that silently resolved to false took 137 calls with it.
//
// This file mounts the REAL hook, drives a REAL call to its end through the
// real event sequence (start -> words -> stop -> main says 'closed'), and
// asserts what the save handler does about the three AI Note Taker toggles.
//
// The harness is lifted from useTranscription.unmount-save.test.ts, which is
// the precedent in this repo for mounting this hook.
//
// NOTE the gap this closes in that older file: its mock api has NO `settings`
// surface at all. After BUG-227 the save handler reads settings, so under that
// mock the read throws, the catch swallows it, and none of the three
// auto-behaviours fire — and every assertion in that file still passes,
// because it never asserts on them. A test that would stay green with the
// feature deleted is the thing this milestone keeps finding.
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

type NoteTaker = {
  autoSummarize: boolean
  autoGenerateTitle: boolean
  autoPostCallBrief: boolean
}

function installMockApi(initial: NoteTaker): {
  handlers: Handlers
  save: ReturnType<typeof vi.fn>
  generateTitle: ReturnType<typeof vi.fn>
  summarizeCall: ReturnType<typeof vi.fn>
  postCallBrief: ReturnType<typeof vi.fn>
  settingsGet: ReturnType<typeof vi.fn>
  /** Mutate what the NEXT settings read returns, mid-call. */
  setNoteTaker: (next: NoteTaker) => void
} {
  const handlers: Handlers = {}
  let noteTaker = initial
  const save = vi.fn(async (input: unknown) => ({ id: 'saved-call-1', ...(input as object) }))
  const generateTitle = vi.fn(async () => ({ ok: true, title: 'Acme — Renewal' }))
  const summarizeCall = vi.fn(async () => ({ ok: true }))
  const postCallBrief = vi.fn(async () => ({ ok: true, copied: true }))
  const settingsGet = vi.fn(async () => ({ aiNoteTaker: noteTaker }))
  const api = {
    transcription: {
      ensureMicAccess: vi.fn(async () => ({ status: 'granted' })),
      openMicSettings: vi.fn(async () => ({ ok: true })),
      start: vi.fn(async () => ({ ok: true, sessionId: 1 })),
      sendAudio: vi.fn(),
      requestAudioPort: vi.fn(),
      reportAudioDropped: vi.fn(),
      stop: vi.fn(async () => ({ ok: true, session: null })),
      onState: vi.fn((cb: Handlers['onState']) => {
        handlers.onState = cb
        return () => {}
      }),
      onTranscript: vi.fn((cb: Handlers['onTranscript']) => {
        handlers.onTranscript = cb
        return () => {}
      }),
      attach: vi.fn(async () => ({ session: null, call: null })),
      onSegments: vi.fn((cb: Handlers['onSegments']) => {
        handlers.onSegments = cb
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
    calls: { save, summarizeCall, generateTitle, postCallBrief },
    settings: { get: settingsGet },
    app: { getActiveApp: vi.fn(async () => null) }
  }
  ;(window as unknown as { api: typeof api }).api = api
  return {
    handlers,
    save,
    generateTitle,
    summarizeCall,
    postCallBrief,
    settingsGet,
    setNoteTaker: (next) => {
      noteTaker = next
    }
  }
}

function speak(handlers: Handlers, text: string): void {
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
  handlers.onSegments?.({ callId: 'call-1', seq: 0, from: 0, segments: [{ speaker: 0, text }] })
}

async function flush(): Promise<void> {
  // The save handler is async now (it awaits the settings read before deciding),
  // so a single microtask turn is not enough — this is the difference between
  // asserting on the decision and asserting on the save.
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

function Harness({ onApi }: { onApi: (a: ReturnType<typeof useTranscription>) => void }): null {
  onApi(useTranscription())
  return null
}

describe('useTranscription — the save handler runs the AI Note Taker behaviours a call ends with', () => {
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

  /** Drive a whole call to its end through the real sequence: start, a spoken
   *  turn, the rep pressing Stop, then main confirming the session closed —
   *  which is where flushPendingSave actually fires. */
  async function runCall(mock: ReturnType<typeof installMockApi>): Promise<void> {
    let api!: ReturnType<typeof useTranscription>
    root = createRoot(container)
    act(() => {
      root.render(createElement(Harness, { onApi: (a) => (api = a) }))
    })
    await act(async () => {
      await api.start()
    })
    act(() => mock.handlers.onState?.({ state: 'listening' }))
    act(() => speak(mock.handlers, 'They agreed to a demo next Tuesday'))
    await act(async () => {
      await api.stop()
    })
    act(() => mock.handlers.onClosed?.())
    await flush()
  }

  it('titles the call when the setting is ON', async () => {
    const mock = installMockApi({
      autoSummarize: false,
      autoGenerateTitle: true,
      autoPostCallBrief: false
    })
    await runCall(mock)

    expect(mock.save, 'the call itself must still save').toHaveBeenCalledTimes(1)
    // THE LINK. This is the assertion that did not exist while 137 calls went
    // untitled.
    expect(mock.generateTitle).toHaveBeenCalledTimes(1)
    expect(mock.generateTitle).toHaveBeenCalledWith('saved-call-1')
    // and only the behaviour that was switched on
    expect(mock.summarizeCall).not.toHaveBeenCalled()
    expect(mock.postCallBrief).not.toHaveBeenCalled()
  })

  it('does NOT title the call when the setting is OFF', async () => {
    const mock = installMockApi({
      autoSummarize: false,
      autoGenerateTitle: false,
      autoPostCallBrief: false
    })
    await runCall(mock)

    expect(mock.save).toHaveBeenCalledTimes(1)
    expect(mock.generateTitle).not.toHaveBeenCalled()
  })

  it('runs each of the three independently, so one being off cannot switch another off', async () => {
    const mock = installMockApi({
      autoSummarize: true,
      autoGenerateTitle: false,
      autoPostCallBrief: true
    })
    await runCall(mock)

    expect(mock.summarizeCall).toHaveBeenCalledWith('saved-call-1')
    expect(mock.postCallBrief).toHaveBeenCalledWith('saved-call-1')
    expect(mock.generateTitle).not.toHaveBeenCalled()
  })

  it('reads the setting at the END of the call, not at mount', async () => {
    // The property the code comment claims, so it gets a check rather than a
    // reader's trust. A rep who switches the toggle on mid-call gets a title
    // for THAT call — and, more importantly, a hook mounted before the
    // migration seeded the setting still sees the seeded value.
    const mock = installMockApi({
      autoSummarize: false,
      autoGenerateTitle: false,
      autoPostCallBrief: false
    })
    let api!: ReturnType<typeof useTranscription>
    root = createRoot(container)
    act(() => {
      root.render(createElement(Harness, { onApi: (a) => (api = a) }))
    })
    await act(async () => {
      await api.start()
    })
    act(() => mock.handlers.onState?.({ state: 'listening' }))
    act(() => speak(mock.handlers, 'Mid-call the rep turns auto-title on'))

    mock.setNoteTaker({
      autoSummarize: false,
      autoGenerateTitle: true,
      autoPostCallBrief: false
    })

    await act(async () => {
      await api.stop()
    })
    act(() => mock.handlers.onClosed?.())
    await flush()

    expect(mock.generateTitle).toHaveBeenCalledTimes(1)
  })

  it('a settings read that fails leaves the call saved and fires nothing', async () => {
    // Fail SAFE, not fail silent-and-spend: if the app cannot tell whether the
    // rep opted in, it must not spend their AI budget guessing. The transcript
    // — the irreplaceable part — still lands.
    const mock = installMockApi({
      autoSummarize: true,
      autoGenerateTitle: true,
      autoPostCallBrief: true
    })
    mock.settingsGet.mockRejectedValue(new Error('settings unreadable'))
    await runCall(mock)

    expect(mock.save, 'the transcript must survive a settings failure').toHaveBeenCalledTimes(1)
    expect(mock.generateTitle).not.toHaveBeenCalled()
    expect(mock.summarizeCall).not.toHaveBeenCalled()
    expect(mock.postCallBrief).not.toHaveBeenCalled()
  })

  it('a wordless call saves nothing and titles nothing', async () => {
    const mock = installMockApi({
      autoSummarize: false,
      autoGenerateTitle: true,
      autoPostCallBrief: false
    })
    let api!: ReturnType<typeof useTranscription>
    root = createRoot(container)
    act(() => {
      root.render(createElement(Harness, { onApi: (a) => (api = a) }))
    })
    await act(async () => {
      await api.start()
    })
    act(() => mock.handlers.onState?.({ state: 'listening' }))
    await act(async () => {
      await api.stop()
    })
    act(() => mock.handlers.onClosed?.())
    await flush()

    expect(mock.save).not.toHaveBeenCalled()
    expect(mock.generateTitle).not.toHaveBeenCalled()
  })
})
