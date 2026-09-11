// @vitest-environment happy-dom
//
// BUG-225 — the renderer half, which the main-process tests structurally
// cannot see.
//
// bug225-cue-latency-log.test.ts proves the pooling, the sanitising and the
// file. Every one of those tests would stay green with the `recordCueLatency`
// call deleted from this hook, because they never touch it — the same shape as
// BUG-209's eleven green tests that would have survived deleting the fix. So
// this file drives the REAL hook through a REAL call boundary and asserts on
// what crossed the IPC boundary.
//
// Two things are pinned here, and the second is the one that bites:
//   1. the samples are handed over BEFORE reset() destroys them, and
//   2. they are filed under the call that ENDED, not the one starting.
// (2) is a one-line ordering hazard: `lastCallIdRef` is overwritten with the
// new call id a few lines above the flush, so reading it after the assignment
// would attribute every measurement on this machine to the wrong call.
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
  recordCueLatency: ReturnType<typeof vi.fn>
} {
  const onTranscriptRef: { current: TranscriptHandler | null } = { current: null }
  const recordCueLatency = vi.fn()
  const api = {
    trackers: { list: vi.fn(async () => []) },
    live: { recordCueLatency },
    transcription: {
      onTranscript: vi.fn((cb: TranscriptHandler) => {
        onTranscriptRef.current = cb
        return () => {}
      }),
      onUtteranceEnd: vi.fn(() => () => {}),
      liveCue: vi.fn(async () => ({
        ok: true,
        cue: 'none',
        text: null,
        repSpeaker: null,
        buyerName: null,
        buyerSpeaker: null
      }))
    }
  }
  ;(window as unknown as { api: typeof api }).api = api
  return { onTranscript: onTranscriptRef, recordCueLatency }
}

/** A buyer turn long enough to clear the hook's MIN_CHARS gate, containing a
 *  phrase the deterministic tier fires on — so a real latency sample exists to
 *  be flushed. Nothing here is asserted as text; only that samples appear. */
const PRICE_TURN = {
  transcript: "honestly that's too expensive for us right now, the price is way over our budget",
  words: [
    {
      speaker: 1,
      text: "honestly that's too expensive for us right now, the price is way over our budget"
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

function HookHost({
  active,
  enabled,
  callId,
  onApi
}: {
  active: boolean
  enabled: boolean
  callId: string | null
  onApi: (api: UseLiveCues) => void
}): null {
  // A stable-per-render closure is fine here: the hook reads it inside the
  // effect, and the effect's deps are the primitives above.
  const result = useLiveCues(active, enabled, () => callId, 'low')
  onApi(result)
  return null
}

describe('BUG-225 — the samples reach the main process before reset() destroys them', () => {
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

  const render = (props: { active: boolean; enabled: boolean; callId: string | null }): UseLiveCues => {
    let api!: UseLiveCues
    act(() =>
      root.render(createElement(HookHost, { ...props, onApi: (a: UseLiveCues) => (api = a) }))
    )
    return api
  }

  async function measureOneCue(onTranscript: { current: TranscriptHandler | null }): Promise<void> {
    act(() => onTranscript.current!(PRICE_TURN))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('flushes when the call stops, and files it under the call that ENDED', async () => {
    const { onTranscript, recordCueLatency } = installMockApi()
    root = createRoot(container)
    render({ active: true, enabled: true, callId: 'call-A' })
    await measureOneCue(onTranscript)
    expect(recordCueLatency).not.toHaveBeenCalled() // not mid-call

    // The rep stops the call.
    render({ active: false, enabled: true, callId: null })

    expect(recordCueLatency).toHaveBeenCalledTimes(1)
    const entry = recordCueLatency.mock.calls[0][0]
    expect(entry.callId).toBe('call-A') // NOT null, which is what the ending id being read after the overwrite would give
    const total = entry.samples.deterministic.length + entry.samples.model.length
    expect(total).toBeGreaterThan(0) // a flush of nothing is not evidence of a flush
    for (const n of [...entry.samples.deterministic, ...entry.samples.model])
      expect(n).toBeGreaterThanOrEqual(0)
  })

  it('flushes at the OTHER boundary too — one call becoming another without stopping', async () => {
    // This path never reset the latency tracker at all before BUG-225, so
    // call B's percentiles silently carried call A's samples. It is the
    // boundary that is easy to miss because `active` never goes false.
    const { onTranscript, recordCueLatency } = installMockApi()
    root = createRoot(container)
    render({ active: true, enabled: true, callId: 'call-A' })
    await measureOneCue(onTranscript)

    render({ active: true, enabled: true, callId: 'call-B' })

    expect(recordCueLatency).toHaveBeenCalledTimes(1)
    expect(recordCueLatency.mock.calls[0][0].callId).toBe('call-A')
  })

  it('does not file a line for a call that produced no cues', async () => {
    // A call with nothing to say about cue latency must not add a row that
    // every count-of-calls aggregate would then include.
    const { recordCueLatency } = installMockApi()
    root = createRoot(container)
    render({ active: true, enabled: true, callId: 'call-A' })
    render({ active: false, enabled: true, callId: null })
    expect(recordCueLatency).not.toHaveBeenCalled()
  })

  it('does not flush the same samples twice', async () => {
    // reset() runs inside the flush, so a second boundary has nothing left to
    // send. Without that, a stop-then-restart would double-count every sample.
    const { onTranscript, recordCueLatency } = installMockApi()
    root = createRoot(container)
    render({ active: true, enabled: true, callId: 'call-A' })
    await measureOneCue(onTranscript)
    render({ active: false, enabled: true, callId: null })
    render({ active: true, enabled: true, callId: 'call-B' })
    render({ active: false, enabled: true, callId: null })
    expect(recordCueLatency).toHaveBeenCalledTimes(1)
  })
})
