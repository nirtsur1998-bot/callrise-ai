// @vitest-environment happy-dom
// Audit E fixes — every way a recording ends funnels through one safe path.
// Proves the two field-critical claims: (1) the 5-minute cap finishes the
// take (transcribe + composer text) instead of discarding it and wedging the
// composer; (2) a failed transcription really KEEPS the audio for retry —
// making the error copy true.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import React from 'react'
import { useVoiceNote, MAX_RECORDING_MS, type UseVoiceNote } from '../useVoiceNote'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

class FakeMediaRecorder {
  static last: FakeMediaRecorder | null = null
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null
  stopped = false
  constructor(
    public stream: unknown,
    public options: unknown
  ) {
    FakeMediaRecorder.last = this
  }
  start(): void {
    // one chunk arrives immediately
    queueMicrotask(() => this.ondataavailable?.({ data: new Blob(['audio-bytes']) }))
  }
  stop(): void {
    this.stopped = true
    this.onstop?.()
  }
}

const transcribeMock = vi.fn()
let latest: UseVoiceNote
const transcripts: string[] = []

function Probe(): null {
  latest = useVoiceNote({ onTranscript: (t) => transcripts.push(t) })
  return null
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  transcripts.length = 0
  transcribeMock.mockReset()
  FakeMediaRecorder.last = null
  ;(globalThis as Record<string, unknown>).MediaRecorder = FakeMediaRecorder
  ;(globalThis as Record<string, unknown>).AudioContext = class {
    constructor() {
      throw new Error('no meter in tests') // hook treats the meter as optional
    }
  }
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: async () => ({
        getTracks: () => [{ stop: () => {}, addEventListener: () => {} }],
        getAudioTracks: () => [{ addEventListener: () => {} }]
      })
    }
  })
  ;(window as unknown as Record<string, unknown>).api = {
    assistant: { transcribeVoiceNote: transcribeMock, discardVoiceNote: vi.fn(async () => true) }
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(React.createElement(Probe)))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useVoiceNote — every ending is safe', () => {
  it('the 5-minute cap finishes the take: transcribed, composer text delivered, state idle', async () => {
    transcribeMock.mockResolvedValue({ ok: true, text: 'capped words', mediaId: 'm.webm', durationMs: 1 })
    await act(async () => {
      await latest.start()
    })
    await flush()
    expect(latest.state).toBe('recording')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAX_RECORDING_MS + 400)
    })
    await flush()
    expect(FakeMediaRecorder.last?.stopped).toBe(true)
    expect(transcripts).toEqual(['capped words'])
    expect(latest.pending?.mediaId).toBe('m.webm')
    expect(latest.state).toBe('idle') // composer not wedged
  })

  it('a failed transcription KEEPS the take: Retry transcribes the same audio successfully', async () => {
    transcribeMock.mockResolvedValueOnce({ ok: false, error: 'network', message: 'kept - retry' })
    await act(async () => {
      await latest.start()
    })
    await flush()
    await act(async () => {
      await latest.finishRecording()
    })
    await flush()
    expect(latest.error).toBe('kept - retry')
    expect(latest.canRetry).toBe(true)
    expect(latest.pending).toBeNull()

    transcribeMock.mockResolvedValueOnce({ ok: true, text: 'second try', mediaId: 'r.webm', durationMs: 1 })
    await act(async () => {
      await latest.retryTranscribe()
    })
    await flush()
    expect(transcripts).toEqual(['second try'])
    expect(latest.pending?.mediaId).toBe('r.webm')
    expect(transcribeMock).toHaveBeenCalledTimes(2) // same take, sent twice
  })

  it('a rejected IPC never freezes "Transcribing…" — error + retry offered', async () => {
    transcribeMock.mockRejectedValueOnce(new Error('ipc dead'))
    await act(async () => {
      await latest.start()
    })
    await flush()
    await act(async () => {
      await latest.finishRecording()
    })
    await flush()
    expect(latest.state).toBe('idle')
    expect(latest.canRetry).toBe(true)
    expect(latest.error).toContain('kept')
  })
})
