// M21 Phase C — the label a turn shows must come from its OWN recorded
// attribution, not from a whole-call value re-read at render time.
import { describe, it, expect } from 'vitest'
import { speakerLabel } from '../meta'

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

  it('falls back to the old comparison for pre-M21 segments with no role', () => {
    expect(speakerLabel(0, 0, 2)).toBe('You')
    expect(speakerLabel(1, 0, 2)).toBe('Buyer')
    expect(speakerLabel(0, null, 2)).toBe('Speaker 1')
  })
})
