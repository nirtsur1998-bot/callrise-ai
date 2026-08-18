// @vitest-environment happy-dom
//
// BUG-057 Phase 2 — useLiveCues used to collapse coachingPaused via
// `res.pausedReason === 'all-models-unavailable'`, so a genuine
// 'timed-out' failure from liveCue() silently read as "not paused": the
// rep saw nothing wrong while AI coaching had actually stopped. Fixed to
// `res.pausedReason !== undefined`, with a separate coachingPausedReason
// field for copy. These tests drive the REAL useLiveCues hook — only
// window.api is mocked — through the actual onTranscript/onUtteranceEnd
// event path and debounce/call-gap timers, not a description of the fix.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLiveCues, type UseLiveCues } from '../useLiveCues'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type TranscriptHandler = (payload: {
  transcript: string
  words: Array<{ speaker: number; text: string; channel?: number }>
  isFinal: boolean
  speechFinal: boolean
  lagMs: number
  speakerEpoch: number
  speakerCertain: boolean
  minConfidence: number | null
  multichannel: boolean
}) => void

function installMockApi(liveCueResult: unknown): { onTranscript: { current: TranscriptHandler | null } } {
  const onTranscriptRef: { current: TranscriptHandler | null } = { current: null }
  const api = {
    trackers: { list: vi.fn(async () => []) },
    transcription: {
      onTranscript: vi.fn((cb: TranscriptHandler) => {
        onTranscriptRef.current = cb
        return () => {}
      }),
      onUtteranceEnd: vi.fn(() => () => {}),
      liveCue: vi.fn(async () => liveCueResult)
    }
  }
  ;(window as unknown as { api: typeof api }).api = api
  return { onTranscript: onTranscriptRef }
}

// Stable reference, matching useTranscription's own real getCallId contract
// ("a stable function reference by design" — see useLiveCues.ts's own param
// doc comment). An inline arrow function passed fresh on every render would
// change the effect's dependency array the moment ANY state inside
// useLiveCues updates (e.g. setEngagementScore), tearing down and
// re-registering the transcript subscription — including clearing the
// just-scheduled debounce timer — before it ever fires.
const getCallId = (): string => 'call-1'

function HookHost({ onApi }: { onApi: (api: UseLiveCues) => void }): null {
  const result = useLiveCues(true, true, getCallId, 'low')
  onApi(result)
  return null
}

// One finalized, speech-final turn from the client (speaker 1, unknown
// rep) — long enough to clear useLiveCues' MIN_CHARS gate once prefixed
// with "Speaker 1: " by windowText().
const CLIENT_TURN = {
  transcript: 'sure, tell me more about how the pricing works for our team size',
  words: [
    {
      speaker: 1,
      text: 'sure, tell me more about how the pricing works for our team size'
    }
  ],
  isFinal: true,
  speechFinal: true,
  lagMs: 50,
  speakerEpoch: 0,
  speakerCertain: true,
  minConfidence: 0.9,
  multichannel: false
}

async function driveOneCueCall(onTranscript: TranscriptHandler): Promise<void> {
  act(() => onTranscript(CLIENT_TURN))
  // callBrain is scheduled DEBOUNCE_MS (400ms) after the speech-final turn.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500)
    // Belt-and-suspenders microtask flush: advanceTimersByTimeAsync already
    // drains microtasks between fake-timer ticks, but liveCue()'s own .then
    // chain runs as a real (non-fake) promise continuation off that tick.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('useLiveCues — coachingPaused/coachingPausedReason routing (BUG-057 Phase 2)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    act(() => root?.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it('a HARD_CEILING_MS timeout sets coachingPaused true with reason timed-out', async () => {
    const { onTranscript } = installMockApi({ ok: false, pausedReason: 'timed-out' })
    let api!: UseLiveCues
    root = createRoot(container)
    act(() => {
      root.render(createElement(HookHost, { onApi: (a) => (api = a) }))
    })

    await driveOneCueCall(onTranscript.current!)

    expect(api.coachingPaused).toBe(true)
    expect(api.coachingPausedReason).toBe('timed-out')
  })

  it('every model cooling down sets coachingPaused true with reason all-models-unavailable', async () => {
    const { onTranscript } = installMockApi({ ok: false, pausedReason: 'all-models-unavailable' })
    let api!: UseLiveCues
    root = createRoot(container)
    act(() => {
      root.render(createElement(HookHost, { onApi: (a) => (api = a) }))
    })

    await driveOneCueCall(onTranscript.current!)

    expect(api.coachingPaused).toBe(true)
    expect(api.coachingPausedReason).toBe('all-models-unavailable')
  })

  it('an ordinary one-off failure (no pausedReason) leaves coaching NOT paused (unchanged)', async () => {
    const { onTranscript } = installMockApi({ ok: false })
    let api!: UseLiveCues
    root = createRoot(container)
    act(() => {
      root.render(createElement(HookHost, { onApi: (a) => (api = a) }))
    })

    await driveOneCueCall(onTranscript.current!)

    expect(api.coachingPaused).toBe(false)
    expect(api.coachingPausedReason).toBeUndefined()
  })

  it('a subsequent success clears both fields (unchanged)', async () => {
    const { onTranscript } = installMockApi({ ok: false, pausedReason: 'timed-out' })
    let api!: UseLiveCues
    root = createRoot(container)
    act(() => {
      root.render(createElement(HookHost, { onApi: (a) => (api = a) }))
    })

    await driveOneCueCall(onTranscript.current!)
    expect(api.coachingPaused).toBe(true)

    // Flip the mock to a success and drive a second cue call (CALL_GAP_MS is
    // 6_000ms — M27 H1 — already cleared by the 500ms advance above plus
    // this one).
    ;(window.api.transcription.liveCue as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      cue: 'none',
      text: null,
      repSpeaker: null,
      buyerName: null,
      buyerSpeaker: null
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000)
    })
    act(() => onTranscript.current!(CLIENT_TURN))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(api.coachingPaused).toBe(false)
    expect(api.coachingPausedReason).toBeUndefined()
  })
})
