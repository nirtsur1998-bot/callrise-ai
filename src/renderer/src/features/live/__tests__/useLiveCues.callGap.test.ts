// @vitest-environment happy-dom
//
// M27 H1 — CALL_GAP_MS (the minimum gap between brain/LLM calls for the live
// coaching-cue purpose) is DERIVED to match model-pacing.ts's own
// PACING_GAP_MS floor (60_000/10, Gemini's conservative free-tier RPM) — see
// useLiveCues.ts's own comment for the full reasoning. `live`-tier purposes
// are exempt from the cross-purpose pacing gate, so this constant is the
// ONLY thing standing between coaching-cue and exceeding a low-RPM
// provider's limit on its own. This test pins the actual VALUE as a
// regression guard, driving the REAL hook through real (fake) timers and
// counting real mock invocations — not asserting the constant's literal
// source text, which would pass even if the enforcement itself broke.
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

function installMockApi(): {
  onTranscript: { current: TranscriptHandler | null }
  liveCue: ReturnType<typeof vi.fn>
} {
  const onTranscriptRef: { current: TranscriptHandler | null } = { current: null }
  const liveCue = vi.fn(async () => ({
    ok: true,
    cue: 'none',
    text: null,
    repSpeaker: null,
    buyerName: null,
    buyerSpeaker: null
  }))
  const api = {
    trackers: { list: vi.fn(async () => []) },
    transcription: {
      onTranscript: vi.fn((cb: TranscriptHandler) => {
        onTranscriptRef.current = cb
        return () => {}
      }),
      onUtteranceEnd: vi.fn(() => () => {}),
      liveCue
    }
  }
  ;(window as unknown as { api: typeof api }).api = api
  return { onTranscript: onTranscriptRef, liveCue }
}

// Stable references — see useLiveCues.pausedReason.test.ts's identical
// comment for why these must not be fresh closures per render.
const getCallId = (): string => 'call-1'
const getSessionId = (): number => 1

function HookHost({ onApi }: { onApi: (api: UseLiveCues) => void }): null {
  const result = useLiveCues(true, true, getCallId, getSessionId, 'low')
  onApi(result)
  return null
}

// Long enough to clear useLiveCues' MIN_CHARS gate once prefixed with
// "Speaker 1: " by windowText() — same fixture as the pausedReason suite.
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

async function fireTurnAndSettle(onTranscript: TranscriptHandler): Promise<void> {
  act(() => onTranscript(CLIENT_TURN))
  // callBrain is scheduled DEBOUNCE_MS (400ms) after the speech-final turn.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('useLiveCues — CALL_GAP_MS enforcement (M27 H1)', () => {
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

  it('does not fire a second brain call less than CALL_GAP_MS (6s) after the first', async () => {
    const { onTranscript, liveCue } = installMockApi()
    let api!: UseLiveCues
    root = createRoot(container)
    act(() => root.render(createElement(HookHost, { onApi: (a) => (api = a) })))

    await fireTurnAndSettle(onTranscript.current!)
    expect(liveCue).toHaveBeenCalledTimes(1)
    void api

    // 3s later — well inside the 6s gap.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    await fireTurnAndSettle(onTranscript.current!)
    expect(liveCue).toHaveBeenCalledTimes(1) // still 1 — suppressed by the gap
  })

  it('fires again once CALL_GAP_MS (6s) has actually elapsed', async () => {
    const { onTranscript, liveCue } = installMockApi()
    let api!: UseLiveCues
    root = createRoot(container)
    act(() => root.render(createElement(HookHost, { onApi: (a) => (api = a) })))

    await fireTurnAndSettle(onTranscript.current!)
    expect(liveCue).toHaveBeenCalledTimes(1)
    void api

    // 6s later — the gap has cleared.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000)
    })
    await fireTurnAndSettle(onTranscript.current!)
    expect(liveCue).toHaveBeenCalledTimes(2)
  })
})
