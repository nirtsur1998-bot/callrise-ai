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
//
// Merged (2026-08-04) with a second, independently-written suite for the same
// module covering the (channel, speaker) identity work — `speaker` alone is
// ALSO ambiguous across a mid-call mono-to-multichannel switch, which the
// suite above didn't cover and this one exists specifically to.
import { describe, expect, it } from 'vitest'
import { groupWords, mergeSegments, sameSpeaker, speakerKey } from '../segments'
import type { CallSegment, SpeakerRole } from '@renderer/features/calls/types'

const w = (speaker: number, text: string): { speaker: number; text: string } => ({ speaker, text })

describe('speakerKey', () => {
  it('distinguishes a mono speaker from a channel speaker with the same id', () => {
    expect(speakerKey({ speaker: 0 })).not.toBe(speakerKey({ speaker: 0, channel: 0 }))
  })

  it('distinguishes the two channels', () => {
    expect(speakerKey({ speaker: 0, channel: 0 })).not.toBe(speakerKey({ speaker: 0, channel: 1 }))
  })

  it('is stable for the same person', () => {
    expect(speakerKey({ speaker: 1, channel: 1 })).toBe(speakerKey({ speaker: 1, channel: 1 }))
  })

  it('never returns a bare integer', () => {
    for (const seg of [{ speaker: 0 }, { speaker: 3, channel: 1 }]) {
      expect(Number.isNaN(Number(speakerKey(seg)))).toBe(true)
    }
  })
})

describe('sameSpeaker', () => {
  it('is true only for a matching pair', () => {
    expect(sameSpeaker({ speaker: 0, channel: 0 }, { speaker: 0, channel: 0 })).toBe(true)
    expect(sameSpeaker({ speaker: 0, channel: 0 }, { speaker: 0, channel: 1 })).toBe(false)
    expect(sameSpeaker({ speaker: 0 }, { speaker: 0, channel: 0 })).toBe(false)
  })
})

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

  it('marks turns Deepgram never labelled, so they are never back-filled', () => {
    // 'unknown' has two causes: the rep isn't identified yet (the number is
    // real, so back-filling is right), or Deepgram returned no labels at all
    // (the number is a fabricated 0). Only the second is flagged, because
    // naming the rep 0 would otherwise assert every such turn as the rep.
    const out = groupWords([w(0, 'unlabelled words')], {
      epoch: 3,
      role: (): SpeakerRole => 'unknown',
      unlabelled: true
    })
    expect(out[0].unlabelled).toBe(true)
    expect(out[0].role).toBe('unknown')
  })

  it('leaves the flag off when the labels were real', () => {
    const out = groupWords([w(0, 'labelled')], { epoch: 3, role: (): SpeakerRole => 'unknown' })
    expect(out[0].unlabelled).toBeUndefined()
  })

  it('records unknown attribution honestly rather than defaulting to the rep', () => {
    const out = groupWords([w(0, 'who said this')], {
      epoch: 1,
      role: (): SpeakerRole => 'unknown'
    })
    expect(out[0].role).toBe('unknown')
  })

  it('joins consecutive words from one speaker', () => {
    expect(
      groupWords([
        { speaker: 0, text: 'Hello' },
        { speaker: 0, text: 'there' }
      ])
    ).toEqual([{ speaker: 0, text: 'Hello there' }])
  })

  it('splits on a speaker change', () => {
    const out = groupWords([
      { speaker: 0, text: 'Hi' },
      { speaker: 1, text: 'Hello' }
    ])
    expect(out).toHaveLength(2)
  })

  // The whole point: two words both labelled speaker 0, one from the mic and
  // one from the buyer's channel, are NOT the same person.
  it('never joins across channels, even at the same speaker id', () => {
    const out = groupWords([
      { speaker: 0, text: 'Hi', channel: 0 },
      { speaker: 0, text: 'Hello', channel: 1 }
    ])
    expect(out).toHaveLength(2)
    expect(out[0].channel).toBe(0)
    expect(out[1].channel).toBe(1)
  })

  it('carries the channel onto the segment', () => {
    expect(groupWords([{ speaker: 1, text: 'Yes', channel: 1 }])).toEqual([
      { speaker: 1, text: 'Yes', channel: 1 }
    ])
  })

  it('omits the channel entirely for mono, rather than inventing one', () => {
    expect(groupWords([{ speaker: 0, text: 'Yes' }])[0]).not.toHaveProperty('channel')
  })

  it('skips blank words', () => {
    expect(
      groupWords([
        { speaker: 0, text: '   ' },
        { speaker: 0, text: 'ok' }
      ])
    ).toEqual([{ speaker: 0, text: 'ok' }])
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

  // Live-call perf bug (found 2026-08-04, buyer-side/multichannel rising-lag
  // report): the old implementation cloned EVERY segment on EVERY call
  // (`prev.map(s => ({...s}))`), which meant a memoized per-turn renderer had
  // no chance — every turn got a fresh object identity on every incoming
  // message, so React had to re-diff the entire accumulated transcript every
  // time, growing more expensive as the call got longer. Only the segment
  // actually being touched should ever get a new reference.
  it('keeps untouched segments referentially identical, so a memoized renderer can skip them', () => {
    const untouched1: CallSegment = { speaker: 0, text: 'turn one', epoch: 1 }
    const untouched2: CallSegment = { speaker: 1, text: 'turn two', epoch: 1, channel: 1 }
    const prev: CallSegment[] = [untouched1, untouched2]
    const next = mergeSegments(prev, [{ speaker: 0, text: 'turn three', epoch: 1 }])
    expect(next[0]).toBe(untouched1)
    expect(next[1]).toBe(untouched2)
    expect(next[2]).not.toBe(untouched1)
  })

  it('gives the merged (mutated) turn a new reference, not the old one', () => {
    const original: CallSegment = { speaker: 0, text: 'hello', epoch: 1 }
    const next = mergeSegments([original], [{ speaker: 0, text: 'again', epoch: 1 }])
    expect(next[0]).not.toBe(original)
    expect(original.text).toBe('hello') // still unmutated
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

  it('continues the same speaker across updates', () => {
    const out = mergeSegments([{ speaker: 0, text: 'Hello' }], [{ speaker: 0, text: 'again' }])
    expect(out).toEqual([{ speaker: 0, text: 'Hello again' }])
  })

  // The mid-call switch to buyer capture, exactly: everything before it is
  // mono-diarized, everything after is channel-labelled.
  it('does not merge a mono turn into a channel turn', () => {
    const out = mergeSegments(
      [{ speaker: 0, text: 'Before' }],
      [{ speaker: 0, text: 'After', channel: 0 }]
    )
    expect(out).toHaveLength(2)
  })

  it('does not merge across channels', () => {
    const out = mergeSegments(
      [{ speaker: 0, text: 'Rep', channel: 0 }],
      [{ speaker: 0, text: 'Buyer', channel: 1 }]
    )
    expect(out).toHaveLength(2)
  })

  // A gap is minutes of missing audio — merging across it would splice two
  // distant moments into one sentence.
  it('never merges across a gap marker', () => {
    const out = mergeSegments(
      [
        { speaker: 0, text: 'Before' },
        { speaker: 0, text: '[gap: 30s]', kind: 'gap' as const }
      ],
      [{ speaker: 0, text: 'After' }]
    )
    expect(out).toHaveLength(3)
  })
})
