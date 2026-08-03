import { describe, expect, it } from 'vitest'
import { speakerLabel, speakerIdentityFor, type SpeakerIdentities } from '../meta'

const IDENTITIES: SpeakerIdentities = {
  'ch0/spk0': { name: 'Alex Rep', source: 'user-profile', confidence: 'high' },
  'ch1/spk1': { name: 'Sarah Chen', source: 'calendar', confidence: 'high' },
  'mono/spk2': { name: 'Bob', source: 'manual', confidence: 'high' }
}

describe('speakerLabel — resolved identity takes priority', () => {
  it('returns the resolved name for a multichannel speaker', () => {
    expect(speakerLabel(1, 0, undefined, IDENTITIES, 1)).toBe('Sarah Chen')
  })

  it('returns the resolved name even for the rep channel', () => {
    expect(speakerLabel(0, 0, undefined, IDENTITIES, 0)).toBe('Alex Rep')
  })

  it('distinguishes mono/spkN from chN/spkN — no key collision', () => {
    // mono/spk1 has no entry even though ch1/spk1 does — must not collide.
    expect(speakerLabel(1, 0, undefined, IDENTITIES, undefined)).not.toBe('Sarah Chen')
  })

  it('falls back to Buyer when no identity resolved for that key', () => {
    expect(speakerLabel(1, 0, undefined, IDENTITIES, undefined)).toBe('Buyer')
  })

  it('falls back to the original You/Buyer/Speaker-N logic with no identities passed at all', () => {
    expect(speakerLabel(0, 0)).toBe('You')
    expect(speakerLabel(1, 0)).toBe('Buyer')
    expect(speakerLabel(1, null)).toBe('Speaker 2')
  })

  it('still respects the 3+-speaker Speaker-N fallback even with identities present', () => {
    expect(speakerLabel(1, 0, 3, {}, 1)).toBe('Speaker 2')
  })

  it('resolves a mono/diarized identity by speaker number alone', () => {
    expect(speakerLabel(2, 0, undefined, IDENTITIES, undefined)).toBe('Bob')
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
