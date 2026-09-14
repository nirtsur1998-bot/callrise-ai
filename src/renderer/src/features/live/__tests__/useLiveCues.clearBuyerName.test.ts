// @vitest-environment happy-dom
//
// BUG-272 — the live identity chip showed the PREVIOUS call's buyer for the
// first seconds of the next call. Found driving the installed 1.12.0 on the
// founder's profile: four seconds into a call, status "Connecting", nobody had
// spoken, and the chip read "Detected Harvey Welsh … linked to Linda" — a name
// extracted on the call before.
//
// WHY: M39's lifetime fix clears the HELD ANSWER (`liveIdentity`) in the
// Provider's onSaved. It never cleared the INPUT. `buyerName` in useLiveCues is
// reset only by the session-boundary effect, which on Stop returns early
// (`active` false, call id null → not a "genuine new call"), and on the next
// Start runs only once the NEW id has arrived — after the chip has already
// rendered the old name against the new meeting.
//
// The fix gives useLiveCues a `clearBuyerName()` and has the Provider call it
// at the same boundary, in the same order, as the held answer: inside onSaved,
// AFTER the handoff. These tests drive the REAL hook (only window.api mocked)
// and pin the Provider's ordering from its source, the way
// resetHeldForNewName.test.ts pins the held-answer clear.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

const getCallId = (): string => 'call-1'

function HookHost({ onApi }: { onApi: (api: UseLiveCues) => void }): null {
  const result = useLiveCues(true, true, getCallId, 'low')
  onApi(result)
  return null
}

const SELF_INTRO_TURN = {
  transcript: 'hello yes hi this is Harvey, Harvey Welsh, I have about twenty minutes',
  words: [
    {
      speaker: 1,
      text: 'hello yes hi this is Harvey, Harvey Welsh, I have about twenty minutes'
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
  act(() => onTranscript(SELF_INTRO_TURN))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('useLiveCues.clearBuyerName (BUG-272)', () => {
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

  it('a self-introduction sets buyerName, and clearBuyerName() takes it back to null', async () => {
    const { onTranscript } = installMockApi({
      ok: true,
      cue: 'none',
      text: '',
      repSpeaker: 0,
      buyerName: 'Harvey Welsh',
      buyerSpeaker: 1
    })
    let api!: UseLiveCues
    root = createRoot(container)
    act(() => {
      root.render(createElement(HookHost, { onApi: (a) => (api = a) }))
    })

    await driveOneCueCall(onTranscript.current!)
    // The precondition, asserted: without it a null-after-clear proves nothing.
    expect(api.buyerName).toBe('Harvey Welsh')
    expect(api.buyerIdentityKey).not.toBeNull()

    act(() => api.clearBuyerName())

    expect(api.buyerName).toBeNull()
    expect(api.buyerIdentityKey).toBeNull()
  })

  it('after clearing, the next self-introduction is extracted again (the one-shot latch was released)', async () => {
    const { onTranscript } = installMockApi({
      ok: true,
      cue: 'none',
      text: '',
      repSpeaker: 0,
      buyerName: 'Harvey Welsh',
      buyerSpeaker: 1
    })
    let api!: UseLiveCues
    root = createRoot(container)
    act(() => {
      root.render(createElement(HookHost, { onApi: (a) => (api = a) }))
    })
    await driveOneCueCall(onTranscript.current!)
    expect(api.buyerName).toBe('Harvey Welsh')

    act(() => api.clearBuyerName())
    expect(api.buyerName).toBeNull()

    // The call gap between cues is long; advance well past it so the second
    // turn is allowed to call the brain again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    await driveOneCueCall(onTranscript.current!)
    expect(api.buyerName).toBe('Harvey Welsh')
  })
})

describe('the Provider clears the buyer name at the call boundary (BUG-272)', () => {
  it('inside onSaved, AFTER handing off to the view — the same order as the held answer', () => {
    const src = readFileSync(join(__dirname, '..', 'LiveCallProvider.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    const body = src.match(
      /const onSaved = useCallback\(\(callId: string\) => \{[\s\S]*?\}, \[\]\)/
    )
    expect(body, 'onSaved must still exist').not.toBeNull()
    const handoff = body![0].indexOf('onSavedRef.current?.(callId)')
    const clearName = body![0].indexOf('clearBuyerNameRef.current()')
    expect(handoff, 'the handoff must be present').toBeGreaterThan(-1)
    expect(clearName, 'onSaved must clear the buyer name').toBeGreaterThan(-1)
    expect(clearName).toBeGreaterThan(handoff)
    // And the ref must actually be wired to the hook's function, or the call
    // above is a no-op that reads exactly like a fix.
    expect(src).toMatch(/clearBuyerNameRef\.current = cues\.clearBuyerName/)
  })
})
