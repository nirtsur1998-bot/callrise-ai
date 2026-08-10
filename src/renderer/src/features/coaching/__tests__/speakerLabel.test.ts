// M21 Phase C — the label a turn shows must come from its OWN recorded
// attribution, not from a whole-call value re-read at render time.
//
// Merged (2026-08-04) with a second, independently-written suite covering
// M19's resolved-identity (real name) tier, which sits ABOVE role in
// precedence — see meta.ts's speakerLabel doc comment for the full order.
// Their positional calls originally passed `identities` as the 4th argument;
// the merged signature inserts `role` there, so those calls now pass
// `undefined` for role explicitly.
import { describe, expect, it } from 'vitest'
import { speakerLabel, speakerIdentityFor, type SpeakerIdentities } from '../meta'

describe('speakerLabel', () => {
  it('uses the turn’s recorded role over the live repSpeaker comparison', () => {
    // repSpeaker says 1, but this turn was RECORDED as the rep. The recorded
    // answer wins — this is what stops a mid-call repSpeaker change from
    // relabelling turns that were already decided.
    expect(speakerLabel(0, 1, 2, 'rep')).toBe('You')
    expect(speakerLabel(1, 1, 2, 'other')).toBe('Buyer')
  })

  it('says "Speaker N" rather than asserting a name it cannot stand behind', () => {
    expect(speakerLabel(2, 0, 2, 'unknown')).toBe('Speaker 3')
  })

  it('keeps distinct participants distinct in a 3+ speaker call', () => {
    // Collapsing every non-rep to "Buyer" would make separate people
    // indistinguishable, so non-rep speakers stay numbered.
    expect(speakerLabel(1, 0, 3, 'other')).toBe('Speaker 2')
    expect(speakerLabel(2, 0, 3, 'other')).toBe('Speaker 3')
    expect(speakerLabel(0, 0, 3, 'rep')).toBe('You')
  })

  it('falls back to the old comparison for pre-M21/M19 segments with no role or identity', () => {
    expect(speakerLabel(0, 0, 2)).toBe('You')
    expect(speakerLabel(1, 0, 2)).toBe('Buyer')
    expect(speakerLabel(0, null, 2)).toBe('Speaker 1')
  })
})

const IDENTITIES: SpeakerIdentities = {
  'ch0/spk0': { name: 'Alex Rep', source: 'user-profile', confidence: 'high' },
  'ch1/spk1': { name: 'Sarah Chen', source: 'calendar', confidence: 'high' },
  'mono/spk2': { name: 'Bob', source: 'manual', confidence: 'high' }
}

describe('speakerLabel — resolved identity takes priority', () => {
  it('returns the resolved name for a multichannel speaker', () => {
    expect(speakerLabel(1, 0, undefined, undefined, IDENTITIES, 1)).toBe('Sarah Chen')
  })

  it('returns the resolved name even for the rep channel', () => {
    expect(speakerLabel(0, 0, undefined, undefined, IDENTITIES, 0)).toBe('Alex Rep')
  })

  it('wins over a recorded role too — a real name beats "You"/"Buyer"', () => {
    expect(speakerLabel(0, 0, undefined, 'rep', IDENTITIES, 0)).toBe('Alex Rep')
    expect(speakerLabel(1, 0, undefined, 'other', IDENTITIES, 1)).toBe('Sarah Chen')
  })

  it('distinguishes mono/spkN from chN/spkN — no key collision', () => {
    // mono/spk1 has no entry even though ch1/spk1 does — must not collide.
    expect(speakerLabel(1, 0, undefined, undefined, IDENTITIES, undefined)).not.toBe('Sarah Chen')
  })

  it('falls back to Buyer when no identity resolved for that key', () => {
    expect(speakerLabel(1, 0, undefined, undefined, IDENTITIES, undefined)).toBe('Buyer')
  })

  it('falls back to the original You/Buyer/Speaker-N logic with no identities passed at all', () => {
    expect(speakerLabel(0, 0)).toBe('You')
    expect(speakerLabel(1, 0)).toBe('Buyer')
    expect(speakerLabel(1, null)).toBe('Speaker 2')
  })

  it('still respects the 3+-speaker Speaker-N fallback even with identities present', () => {
    expect(speakerLabel(1, 0, 3, undefined, {}, 1)).toBe('Speaker 2')
  })

  it('resolves a mono/diarized identity by speaker number alone', () => {
    expect(speakerLabel(2, 0, undefined, undefined, IDENTITIES, undefined)).toBe('Bob')
  })
})

describe('speakerIdentityFor', () => {
  it('returns the full identity record for a resolved speaker', () => {
    expect(speakerIdentityFor(1, IDENTITIES, 1)).toEqual({
      name: 'Sarah Chen',
      source: 'calendar',
      confidence: 'high'
    })
  })

  it('returns null when unresolved', () => {
    expect(speakerIdentityFor(5, IDENTITIES, 1)).toBeNull()
  })

  it('returns null when identities is undefined', () => {
    expect(speakerIdentityFor(0, undefined, 0)).toBeNull()
  })
})
