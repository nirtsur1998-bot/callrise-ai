import { describe, expect, it } from 'vitest'
import { otherPartyKey, verifyDetectedName } from '../contact-intelligence'
import type { CallSegment } from '../calls-fs'

describe('otherPartyKey', () => {
  it('resolves the single other-party key on a multichannel call', () => {
    const result = otherPartyKey({
      segments: [
        { speaker: 0, channel: 0 },
        { speaker: 1, channel: 1 }
      ],
      multichannel: true,
      repSpeaker: null
    })
    expect(result).toEqual({ key: 'ch1/spk1', speaker: 1 })
  })

  it('resolves the single other-party key on a mono call once repSpeaker is known', () => {
    const result = otherPartyKey({
      segments: [{ speaker: 0 }, { speaker: 1 }],
      multichannel: false,
      repSpeaker: 0
    })
    expect(result).toEqual({ key: 'mono/spk1', speaker: 1 })
  })

  it('returns null when repSpeaker is not yet known for a mono call — never guesses which key is "me"', () => {
    const result = otherPartyKey({
      segments: [{ speaker: 0 }, { speaker: 1 }],
      multichannel: false,
      repSpeaker: null
    })
    expect(result).toBeNull()
  })

  it('returns null when more than one other party is observed — never picks one among several', () => {
    const result = otherPartyKey({
      segments: [
        { speaker: 0, channel: 0 },
        { speaker: 1, channel: 1 },
        { speaker: 2, channel: 1 }
      ],
      multichannel: true,
      repSpeaker: null
    })
    expect(result).toBeNull()
  })

  it('returns null for a call with only the rep observed so far', () => {
    const result = otherPartyKey({
      segments: [{ speaker: 0, channel: 0 }],
      multichannel: true,
      repSpeaker: null
    })
    expect(result).toBeNull()
  })

  it('ignores stale-regime segments (mono keys after a switch to multichannel)', () => {
    const result = otherPartyKey({
      segments: [
        { speaker: 0 }, // pre-switch mono — belongs to the old regime
        { speaker: 1 }, // pre-switch mono
        { speaker: 0, channel: 0 },
        { speaker: 1, channel: 1 }
      ],
      multichannel: true,
      repSpeaker: null
    })
    expect(result).toEqual({ key: 'ch1/spk1', speaker: 1 })
  })
})

// Regression coverage for a CRITICAL review finding: the original
// verification only checked the quote was real speech from that speaker —
// it never checked the quote actually SUPPORTED the claimed name, so a
// hallucinated name paired with any genuine, unrelated line from that
// speaker passed and got persisted as their real name.
describe('verifyDetectedName', () => {
  const OTHER = 1
  const allSegments: CallSegment[] = [
    { speaker: 1, text: 'Yeah, sounds good.' },
    { speaker: 1, text: "Hi, this is Sarah Chen, I'm the VP of Sales here." },
    { speaker: 1, text: "Let's move forward with the deal." }
  ]

  it('accepts a name genuinely stated in one segment', () => {
    expect(
      verifyDetectedName(
        'Sarah Chen',
        "Hi, this is Sarah Chen, I'm the VP of Sales here.",
        allSegments,
        OTHER
      )
    ).toBe('Sarah Chen')
  })

  it('accepts a self-intro split across two truly back-to-back turns', () => {
    const split: CallSegment[] = [
      { speaker: 1, text: 'Hi, this is Sarah' },
      { speaker: 1, text: 'from Acme Corp.' }
    ]
    expect(verifyDetectedName('Sarah', 'Hi, this is Sarah from Acme Corp.', split, OTHER)).toBe('Sarah')
  })

  it('rejects a hallucinated name paired with a real but unrelated quote — the critical bug', () => {
    // "Let's move forward with the deal" is genuine speech from this
    // speaker (it's a real segment above), but never states a name.
    expect(
      verifyDetectedName('Sarah Johnson', "Let's move forward with the deal.", allSegments, OTHER)
    ).toBeNull()
  })

  it('rejects a quote that was never actually said (fabricated, not a substring of any real segment)', () => {
    expect(verifyDetectedName('Sarah', 'my name is sarah as I mentioned', allSegments, OTHER)).toBeNull()
  })

  it('rejects a quote assembled from two turns that are NOT truly adjacent (a rep turn in between)', () => {
    const farApart: CallSegment[] = [
      { speaker: 1, text: 'Yeah, my name is' },
      { speaker: 0, text: 'Great, and what brings you here today?' }, // the rep's turn, in between
      { speaker: 1, text: 'Sarah mentioned she would sign off on this deal.' }
    ]
    // "my name is sarah" only appears if you erase the turn boundary and the
    // rep's intervening turn — it was never said as one utterance. This is
    // exactly the reported bug: these are the SAME speaker's only two turns
    // in this range, so filtering out the rep entirely (instead of checking
    // TRUE index-adjacency) would have wrongly treated them as adjacent.
    expect(verifyDetectedName('Sarah', 'my name is sarah', farApart, OTHER)).toBeNull()
  })

  it('accepts two genuinely back-to-back other-party turns even with the rep speaking earlier', () => {
    const realistic: CallSegment[] = [
      { speaker: 0, text: 'Thanks for joining, who am I speaking with?' },
      { speaker: 1, text: 'Hi, this is Sarah' },
      { speaker: 1, text: 'from Acme Corp.' }
    ]
    expect(verifyDetectedName('Sarah', 'Hi, this is Sarah from Acme Corp.', realistic, OTHER)).toBe('Sarah')
  })

  it('rejects an empty name or quote', () => {
    expect(verifyDetectedName('', 'Hi, this is Sarah.', allSegments, OTHER)).toBeNull()
    expect(verifyDetectedName('Sarah', '', allSegments, OTHER)).toBeNull()
  })

  it('is case-insensitive and whitespace-tolerant when matching the name token in the quote', () => {
    expect(
      verifyDetectedName(
        'sarah chen',
        "HI, THIS IS   Sarah   Chen, I'm the VP of Sales here.",
        allSegments,
        OTHER
      )
    ).toBe('sarah chen')
  })
})
