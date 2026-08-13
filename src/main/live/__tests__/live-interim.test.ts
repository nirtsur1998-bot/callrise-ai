// M26 Phase 4.5.1 — the cue engine's fast tier needs interim (non-final)
// transcript results, which live-transcript.ts's recordResult() deliberately
// drops. This module is the replacement tap: a passive buffer written from
// transcription.ts's message handler, read by an independently-scheduled
// poll (once the cue engine moves into main in 4.5.4) — never a callback
// that could throw back into the message handler's own try block.
import { describe, expect, it, beforeEach } from 'vitest'
import {
  recordInterim,
  latestInterim,
  resetInterim,
  type InterimTranscriptResult
} from '../live-interim'

function result(over: Partial<InterimTranscriptResult> = {}): InterimTranscriptResult {
  return {
    transcript: 'hello there',
    words: [{ speaker: 0, text: 'hello' }, { speaker: 0, text: 'there' }],
    isFinal: false,
    speechFinal: false,
    speakerEpoch: 0,
    speakerCertain: true,
    minConfidence: 0.9,
    multichannel: false,
    ...over
  }
}

beforeEach(() => {
  resetInterim()
})

describe('recordInterim / latestInterim', () => {
  it('is null before the first message of a call arrives', () => {
    expect(latestInterim()).toBeNull()
  })

  it('a recorded result comes back byte-for-byte — the exact object the cue engine would read', () => {
    const r = result({ transcript: 'objection about pricing', isFinal: false })
    recordInterim(r)
    expect(latestInterim()?.result).toEqual(r)
  })

  it('unlike live-transcript.ts, keeps isFinal:false results — that is the whole point of this module', () => {
    recordInterim(result({ isFinal: false, transcript: 'partial words' }))
    expect(latestInterim()?.result.isFinal).toBe(false)
    expect(latestInterim()?.result.transcript).toBe('partial words')
  })

  it('a later result overwrites the earlier one — this is a latest-value buffer, not a log', () => {
    recordInterim(result({ transcript: 'first' }))
    recordInterim(result({ transcript: 'second' }))
    expect(latestInterim()?.result.transcript).toBe('second')
  })

  it('seq increases by exactly one per recorded result, so a poller can detect "nothing new"', () => {
    recordInterim(result())
    const first = latestInterim()!.seq
    recordInterim(result())
    const second = latestInterim()!.seq
    expect(second).toBe(first + 1)
  })

  it('resetInterim clears the buffer back to null and seq back to 0', () => {
    recordInterim(result())
    recordInterim(result())
    resetInterim()
    expect(latestInterim()).toBeNull()
    recordInterim(result())
    expect(latestInterim()?.seq).toBe(1)
  })
})
