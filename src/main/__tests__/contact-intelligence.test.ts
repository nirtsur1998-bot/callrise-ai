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
    expect(result).toEqual({ key: 'ch1/spk1', speaker: 1, repSpeaker: 0 })
  })

  it('resolves the single other-party key on a mono call once repSpeaker is known', () => {
    const result = otherPartyKey({
      segments: [{ speaker: 0 }, { speaker: 1 }],
      multichannel: false,
      repSpeaker: 0
    })
    expect(result).toEqual({ key: 'mono/spk1', speaker: 1, repSpeaker: 0 })
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
    expect(result).toEqual({ key: 'ch1/spk1', speaker: 1, repSpeaker: 0 })
  })
})

// Regression coverage for a CRITICAL review finding: the original
// verification only checked the quote was real speech from that speaker —
// it never checked the quote actually SUPPORTED the claimed name, so a
// hallucinated name paired with any genuine, unrelated line from that
// speaker passed and got persisted as their real name.
//
// Also covers the follow-up widening: detection (and therefore
// verification) must now catch the other party's name from EITHER
// speaker's speech, anywhere in the call — most commonly the REP
// addressing/referring to the buyer by name, not just a formal
// self-introduction from the buyer themselves. verifyDetectedName no
// longer takes an `otherSpeaker` param — it checks ALL segments as
// possible grounding, and it's detectOtherPartyName's prompt/verification
// pass (not this function) that's responsible for making sure the name
// actually refers to the other party on THIS call.
describe('verifyDetectedName', () => {
  const allSegments: CallSegment[] = [
    { speaker: 1, text: 'Yeah, sounds good.' },
    { speaker: 1, text: "Hi, this is Sarah Chen, I'm the VP of Sales here." },
    { speaker: 1, text: "Let's move forward with the deal." }
  ]

  it('accepts a name genuinely stated in one segment', () => {
    expect(
      verifyDetectedName('Sarah Chen', "Hi, this is Sarah Chen, I'm the VP of Sales here.", allSegments)
    ).toBe('Sarah Chen')
  })

  it('accepts a self-intro split across two truly back-to-back turns', () => {
    const split: CallSegment[] = [
      { speaker: 1, text: 'Hi, this is Sarah' },
      { speaker: 1, text: 'from Acme Corp.' }
    ]
    expect(verifyDetectedName('Sarah', 'Hi, this is Sarah from Acme Corp.', split)).toBe('Sarah')
  })

  it('rejects a hallucinated name paired with a real but unrelated quote — the critical bug', () => {
    // "Let's move forward with the deal" is genuine speech from this
    // speaker (it's a real segment above), but never states a name.
    expect(verifyDetectedName('Sarah Johnson', "Let's move forward with the deal.", allSegments)).toBeNull()
  })

  it('rejects a quote that was never actually said (fabricated, not a substring of any real segment)', () => {
    expect(verifyDetectedName('Sarah', 'my name is sarah as I mentioned', allSegments)).toBeNull()
  })

  it('rejects a quote assembled from two turns that are NOT truly adjacent (a rep turn in between)', () => {
    const farApart: CallSegment[] = [
      { speaker: 1, text: 'Yeah, my name is' },
      { speaker: 0, text: 'Great, and what brings you here today?' }, // the rep's turn, in between
      { speaker: 1, text: 'Sarah mentioned she would sign off on this deal.' }
    ]
    // "my name is sarah" only appears if you erase the turn boundary and the
    // rep's intervening turn — it was never said as one utterance.
    expect(verifyDetectedName('Sarah', 'my name is sarah', farApart)).toBeNull()
  })

  it('accepts two genuinely back-to-back other-party turns even with the rep speaking earlier', () => {
    const realistic: CallSegment[] = [
      { speaker: 0, text: 'Thanks for joining, who am I speaking with?' },
      { speaker: 1, text: 'Hi, this is Sarah' },
      { speaker: 1, text: 'from Acme Corp.' }
    ]
    expect(verifyDetectedName('Sarah', 'Hi, this is Sarah from Acme Corp.', realistic)).toBe('Sarah')
  })

  it('rejects an empty name or quote', () => {
    expect(verifyDetectedName('', 'Hi, this is Sarah.', allSegments)).toBeNull()
    expect(verifyDetectedName('Sarah', '', allSegments)).toBeNull()
  })

  it('is case-insensitive and whitespace-tolerant when matching the name token in the quote', () => {
    expect(
      verifyDetectedName('sarah chen', "HI, THIS IS   Sarah   Chen, I'm the VP of Sales here.", allSegments)
    ).toBe('sarah chen')
  })

  it('accepts a name grounded in the REP addressing the other party by name, mid-call — the widened case', () => {
    const repAddressesBuyer: CallSegment[] = [
      { speaker: 1, text: "I'm not sure this is the right time for us." },
      { speaker: 0, text: 'I hear you, Priya — can we revisit this next quarter?' },
      { speaker: 1, text: "Sure, that works for me." }
    ]
    expect(
      verifyDetectedName('Priya', 'I hear you, Priya — can we revisit this next quarter?', repAddressesBuyer)
    ).toBe('Priya')
  })

  it('still rejects a hallucinated name paired with a real but unrelated REP line', () => {
    const repLine: CallSegment[] = [{ speaker: 0, text: 'Can we revisit this next quarter?' }]
    expect(verifyDetectedName('Priya', 'Can we revisit this next quarter?', repLine)).toBeNull()
  })

  it('rejects a bare-name (or near-bare) quote — closes a reopened hallucination gap', () => {
    // A model that returns just the name (or a tiny fragment) as its "quote"
    // instead of the real sentence the tool schema asks for must NOT ground
    // the claim, even though the name IS technically a substring of a real
    // segment — here, one that's unambiguously about a THIRD PARTY who was
    // never on this call. Without a minimum-length floor, this would pass
    // the same way the original (already-fixed-once) hallucination bug did.
    const thirdPartyMention: CallSegment[] = [
      {
        speaker: 0,
        text: "Actually, before pricing — my manager Sarah wants to sit in on the next call, so I'll loop her in."
      }
    ]
    expect(verifyDetectedName('Sarah', 'Sarah', thirdPartyMention)).toBeNull()
    expect(verifyDetectedName('Sarah', 'manager Sarah', thirdPartyMention)).toBeNull()
  })

  it('rejects a "quote" built by concatenating two DIFFERENT speakers separate turns', () => {
    // verificationWindows only pairs adjacent SAME-speaker turns (a
    // transcription-split artifact) — pairing across a real speaker-turn
    // boundary would let a claimed quote be assembled from two different
    // people's separate statements as if they were one utterance.
    const crossSpeakerAdjacent: CallSegment[] = [
      { speaker: 0, text: 'Who am I speaking with today?' },
      { speaker: 1, text: 'This is Priya from Acme.' }
    ]
    expect(
      verifyDetectedName('Priya', 'Who am I speaking with today? This is Priya from Acme.', crossSpeakerAdjacent)
    ).toBeNull()
  })
})
