// @vitest-environment happy-dom
//
// M26 Phase 4.3 — the rule this file exists to enforce:
//
//   The idle screen may only appear once main has AFFIRMATIVELY said there is
//   no session. Never by timeout, never by default, never because an answer
//   was slow or never came.
//
// A rep who navigates back into a live call and sees "Start a call" reads it
// as "my call just died". That is the single worst thing this screen can do,
// and it is a one-word mistake to make — `useState('idle')` instead of
// `useState('attaching')` — which is exactly why it gets its own test file
// rather than an assertion tacked onto something else.
//
// Every test here records the FULL sequence of statuses rather than checking
// the final one, because the bug this guards against is a single frame of
// 'idle' on the way somewhere else. A test that only looked at the end state
// would pass while the rep saw the lie.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTranscription } from '../useTranscription'
import type { LiveStatus } from '../types'

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

type Patch = {
  callId: string
  seq: number
  from: number
  segments: Array<{ speaker: number; text: string }>
}

interface MockOptions {
  /** What `attach` does. Defaults to "no call in progress". */
  attach?: () => Promise<unknown>
}

function installMockApi(opts: MockOptions = {}): {
  start: ReturnType<typeof vi.fn>
  emit: (patch: Patch) => void
} {
  let onSegments: ((p: Patch) => void) | undefined
  const start = vi.fn(async () => ({ ok: true, sessionId: 1 }))
  const api = {
    transcription: {
      ensureMicAccess: vi.fn(async () => ({ status: 'granted' })),
      openMicSettings: vi.fn(async () => ({ ok: true })),
      start,
      sendAudio: vi.fn(),
      requestAudioPort: vi.fn(),
      reportAudioDropped: vi.fn(),
      stop: vi.fn(async () => ({ ok: true, session: null })),
      attach: vi.fn(opts.attach ?? (async () => ({ session: null, call: null }))),
      onSegments: vi.fn((cb: (p: Patch) => void) => {
        onSegments = cb
        return () => {}
      }),
      onState: vi.fn(() => () => {}),
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
      liveCue: vi.fn()
    },
    calls: {
      save: vi.fn(async () => ({ id: 'c1' })),
      summarizeCall: vi.fn(async () => ({ ok: true })),
      generateTitle: vi.fn(async () => ({ ok: true })),
      postCallBrief: vi.fn(async () => ({ ok: true, copied: false }))
    },
    live: { repIdentified: vi.fn() },
    app: { getActiveApp: vi.fn(async () => null) }
  }
  ;(window as unknown as { api: typeof api }).api = api
  return { start, emit: (patch) => onSegments?.(patch) }
}

function Harness({
  onApi
}: {
  onApi: (api: ReturnType<typeof useTranscription>) => void
}): null {
  onApi(useTranscription())
  return null
}

describe('useTranscription — attach (M26 4.3)', () => {
  let container: HTMLDivElement
  let root: Root
  let history: LiveStatus[]
  let api: ReturnType<typeof useTranscription>

  function mount(): void {
    history = []
    root = createRoot(container)
    act(() => {
      root.render(
        createElement(Harness, {
          onApi: (a) => {
            api = a
            if (history[history.length - 1] !== a.status) history.push(a.status)
          }
        })
      )
    })
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    act(() => root?.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  it('starts in attaching, never idle, before main has answered', () => {
    installMockApi({ attach: () => new Promise(() => {}) }) // never resolves
    mount()
    expect(history[0]).toBe('attaching')
    expect(history).not.toContain('idle')
  })

  it('stays attaching indefinitely while main does not answer — no timeout to idle', async () => {
    vi.useFakeTimers()
    try {
      installMockApi({ attach: () => new Promise(() => {}) })
      mount()
      await act(async () => {
        vi.advanceTimersByTime(30_000)
      })
      expect(api.status).toBe('attaching')
      expect(history).not.toContain('idle')
    } finally {
      vi.useRealTimers()
    }
  })

  it('goes to ERROR, not idle, when the question itself fails', async () => {
    installMockApi({ attach: async () => Promise.reject(new Error('ipc gone')) })
    mount()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    // "I could not find out" is not "there is no call". Saying idle here is
    // precisely the forbidden inference.
    expect(api.status).toBe('error')
    expect(history).not.toContain('idle')
  })

  it('shows idle ONLY on an affirmative no-session answer', async () => {
    installMockApi({ attach: async () => ({ session: null, call: null }) })
    mount()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(api.status).toBe('idle')
    expect(history).toEqual(['attaching', 'idle'])
  })

  it('re-joins a call in progress without ever passing through idle', async () => {
    const { start } = installMockApi({
      attach: async () => ({
        session: { id: 7, multichannel: false, producerId: 3, state: 'listening' },
        call: {
          callId: 'call-1',
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          startedAtMs: Date.now() - 60_000,
          seq: 2,
          segments: [
            { speaker: 0, text: 'already said this' },
            { speaker: 1, text: 'and this' }
          ]
        }
      })
    })
    mount()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(api.status).toBe('listening')
    expect(history).not.toContain('idle')
    expect(api.segments.map((s) => s.text)).toEqual(['already said this', 'and this'])
    // Attaching is not starting. Calling start() here would open a SECOND
    // Deepgram session against a call that already has one.
    expect(start).not.toHaveBeenCalled()
  })

  it('applies patches that arrived while the answer was still in flight, exactly once', async () => {
    let release!: (v: unknown) => void
    const gate = new Promise((r) => (release = r))
    const { emit } = installMockApi({
      attach: async () => {
        await gate
        return {
          session: { id: 1, multichannel: false, producerId: 1, state: 'listening' },
          call: {
            callId: 'call-1',
            startedAt: new Date().toISOString(),
            startedAtMs: Date.now(),
            seq: 0,
            segments: [{ speaker: 0, text: 'in the snapshot' }]
          }
        }
      }
    })
    mount()

    // Two patches race the snapshot: one the snapshot already contains, and
    // one it does not. Subscribing before asking is what makes the second
    // survivable at all.
    act(() => emit({ callId: 'call-1', seq: 0, from: 0, segments: [{ speaker: 0, text: 'in the snapshot' }] }))
    act(() => emit({ callId: 'call-1', seq: 1, from: 1, segments: [{ speaker: 1, text: 'arrived during attach' }] }))

    await act(async () => {
      release(null)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(api.segments.map((s) => s.text)).toEqual(['in the snapshot', 'arrived during attach'])
  })

  it('re-asks main when a patch sequence gap proves one was missed', async () => {
    const attach = vi
      .fn()
      .mockResolvedValueOnce({ session: null, call: null })
      .mockResolvedValue({
        session: { id: 1, multichannel: false, producerId: 1, state: 'listening' },
        call: {
          callId: 'call-1',
          startedAt: new Date().toISOString(),
          startedAtMs: Date.now(),
          seq: 5,
          segments: [{ speaker: 0, text: 'the whole truth' }]
        }
      })
    const { emit } = installMockApi({ attach })
    mount()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // seq 4 with nothing before it: a patch was missed. Splicing into a
    // transcript we can no longer prove correct is worse than one round-trip,
    // so the hook re-asks for the whole thing.
    await act(async () => {
      emit({ callId: 'call-1', seq: 4, from: 0, segments: [{ speaker: 0, text: 'partial' }] })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(attach).toHaveBeenCalledTimes(2)
    expect(api.segments.map((s) => s.text)).toEqual(['the whole truth'])
  })

  it('a new call resets the mirror rather than appending to the previous one', async () => {
    const { emit } = installMockApi()
    mount()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    act(() => emit({ callId: 'call-1', seq: 0, from: 0, segments: [{ speaker: 0, text: 'old call' }] }))
    expect(api.segments.map((s) => s.text)).toEqual(['old call'])

    act(() => emit({ callId: 'call-2', seq: 0, from: 0, segments: [] }))
    act(() => emit({ callId: 'call-2', seq: 1, from: 0, segments: [{ speaker: 0, text: 'new call' }] }))
    expect(api.segments.map((s) => s.text)).toEqual(['new call'])
  })
})
