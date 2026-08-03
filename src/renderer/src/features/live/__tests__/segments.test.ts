import { describe, expect, it } from 'vitest'
import { groupWords, mergeSegments, sameSpeaker, speakerKey } from '../segments'

// The bug this file exists for: `speaker` alone is ambiguous. In mono it is a
// diarized guess; in multichannel it is the channel index. So "speaker 0"
// means two different people either side of a mid-call switch to buyer
// capture, and a saved transcript could not tell you which. Identity is the
// (channel, speaker) PAIR.

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

  it('does not mutate the previous array', () => {
    const prev = [{ speaker: 0, text: 'Hello' }]
    mergeSegments(prev, [{ speaker: 0, text: 'again' }])
    expect(prev[0].text).toBe('Hello')
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
