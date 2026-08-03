// M21 Phase C — speaker-attribution regression tests (BUG-002).
//
// The two structural defects these cover:
//   1. runs merged on speaker NUMBER alone, so after a Deepgram reconnect
//      (which restarts diarization from scratch) "speaker 0" glued straight
//      onto the previous connection's "speaker 0" — two different people in
//      one turn.
//   2. attribution was re-derived at render time from a mutable whole-call
//      repSpeaker, so the instant that value changed, every already-recorded
//      turn silently relabelled.
import { describe, it, expect } from 'vitest'
import { groupWords, mergeSegments } from '../segments'
import type { CallSegment, SpeakerRole } from '@renderer/features/calls/types'

const w = (speaker: number, text: string): { speaker: number; text: string } => ({ speaker, text })

describe('groupWords', () => {
  it('groups consecutive words by speaker', () => {
    const out = groupWords([w(0, 'hello'), w(0, 'there'), w(1, 'hi')])
    expect(out.map((s) => s.text)).toEqual(['hello there', 'hi'])
    expect(out.map((s) => s.speaker)).toEqual([0, 1])
  })

  it('stamps the epoch and the attribution decided at record time', () => {
    const out = groupWords([w(0, 'mine'), w(1, 'yours')], {
      epoch: 7,
      role: (s) => (s === 0 ? 'rep' : 'other'),
      confidence: 0.91
    })
    expect(out).toEqual<CallSegment[]>([
      { speaker: 0, text: 'mine', epoch: 7, role: 'rep', confidence: 0.91 },
      { speaker: 1, text: 'yours', epoch: 7, role: 'other', confidence: 0.91 }
    ])
  })

  it('records unknown attribution honestly rather than defaulting to the rep', () => {
    const out = groupWords([w(0, 'who said this')], {
      epoch: 1,
      role: (): SpeakerRole => 'unknown'
    })
    expect(out[0].role).toBe('unknown')
  })
})

describe('mergeSegments', () => {
  it('merges a continuing run from the same speaker in the same epoch', () => {
    const prev: CallSegment[] = [{ speaker: 0, text: 'hello', epoch: 1 }]
    const next = mergeSegments(prev, [{ speaker: 0, text: 'again', epoch: 1 }])
    expect(next).toHaveLength(1)
    expect(next[0].text).toBe('hello again')
  })

  it('does NOT merge the same speaker number across an epoch boundary', () => {
    // The reconnect case: epoch 1's speaker 0 and epoch 2's speaker 0 are
    // different people. Pre-M21 this produced a single merged turn.
    const prev: CallSegment[] = [{ speaker: 0, text: 'before reconnect', epoch: 1 }]
    const next = mergeSegments(prev, [{ speaker: 0, text: 'after reconnect', epoch: 2 }])
    expect(next).toHaveLength(2)
    expect(next.map((s) => s.text)).toEqual(['before reconnect', 'after reconnect'])
  })

  it('does not mutate the previous array', () => {
    const prev: CallSegment[] = [{ speaker: 0, text: 'original', epoch: 1 }]
    mergeSegments(prev, [{ speaker: 0, text: 'added', epoch: 1 }])
    expect(prev[0].text).toBe('original')
  })

  it('preserves each turn’s own recorded attribution when appending', () => {
    const prev: CallSegment[] = [{ speaker: 0, text: 'rep talking', epoch: 1, role: 'rep' }]
    const next = mergeSegments(prev, [
      { speaker: 1, text: 'buyer talking', epoch: 1, role: 'other' }
    ])
    expect(next.map((s) => s.role)).toEqual(['rep', 'other'])
  })

  it('still merges legacy segments with no epoch on either side', () => {
    const prev: CallSegment[] = [{ speaker: 0, text: 'old' }]
    const next = mergeSegments(prev, [{ speaker: 0, text: 'call' }])
    expect(next).toHaveLength(1)
    expect(next[0].text).toBe('old call')
  })
})
