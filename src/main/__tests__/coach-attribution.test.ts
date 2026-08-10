// M21 Phase G — the post-call coach must respect per-turn attribution.
//
// Before this, the coach applied ONE speaker number across the whole call and
// merged turns on that number alone. Deepgram restarts diarization on every
// reconnect, so the same number is a different person either side of one —
// which meant a buyer's words could be counted as the rep's talk time and
// quoted back as "evidence" for coaching the rep.
import { describe, it, expect } from 'vitest'
import { isRepSegment, sameTurn, repSpeakerFromSegments } from '../coach-attribution'
import type { CallSegment } from '../calls-fs'

const seg = (p: Partial<CallSegment> & { speaker: number }): CallSegment => ({
  text: 'x',
  ...p
})

describe('isRepSegment', () => {
  it('trusts the turn’s recorded role over the whole-call number', () => {
    // repSpeaker says 0, but this turn was RECORDED as the buyer's.
    expect(isRepSegment(seg({ speaker: 0, role: 'other' }), 0)).toBe(false)
    // ...and vice versa: recorded as the rep despite a different number.
    expect(isRepSegment(seg({ speaker: 3, role: 'rep' }), 0)).toBe(true)
  })

  it('treats an unattributed turn as not-the-rep', () => {
    // 'unknown' must never be counted as the rep — that would silently inflate
    // talk ratio and let unattributed words verify as rep evidence.
    expect(isRepSegment(seg({ speaker: 0, role: 'unknown' }), 0)).toBe(false)
  })

  it('falls back to the number for pre-M21 segments with no role', () => {
    expect(isRepSegment(seg({ speaker: 0 }), 0)).toBe(true)
    expect(isRepSegment(seg({ speaker: 1 }), 0)).toBe(false)
    expect(isRepSegment(seg({ speaker: 0 }), null)).toBe(false)
  })
})

describe('sameTurn', () => {
  it('merges consecutive segments from one speaker in one epoch', () => {
    expect(sameTurn(seg({ speaker: 0, epoch: 1 }), seg({ speaker: 0, epoch: 1 }))).toBe(true)
  })

  it('refuses to merge the same number across an epoch boundary', () => {
    // The reconnect case — epoch 1's speaker 0 and epoch 2's speaker 0 are
    // different people, so this must not become one long monologue.
    expect(sameTurn(seg({ speaker: 0, epoch: 1 }), seg({ speaker: 0, epoch: 2 }))).toBe(false)
  })

  it('refuses to merge turns recorded with different roles', () => {
    expect(
      sameTurn(
        seg({ speaker: 0, epoch: 1, role: 'rep' }),
        seg({ speaker: 0, epoch: 1, role: 'other' })
      )
    ).toBe(false)
  })
})

describe('repSpeakerFromSegments', () => {
  it('reads the rep straight off the recorded roles', () => {
    expect(
      repSpeakerFromSegments([
        seg({ speaker: 0, role: 'rep' }),
        seg({ speaker: 1, role: 'other' }),
        seg({ speaker: 0, role: 'rep' })
      ])
    ).toBe(0)
  })

  it('reports ambiguity rather than picking one', () => {
    // Two epochs where the rep carries different numbers: there is no single
    // right answer, and guessing would attribute half the call to the wrong
    // person.
    expect(
      repSpeakerFromSegments([
        seg({ speaker: 0, epoch: 1, role: 'rep' }),
        seg({ speaker: 2, epoch: 2, role: 'rep' })
      ])
    ).toBeNull()
  })

  it('returns null for a transcript with no recorded roles', () => {
    expect(repSpeakerFromSegments([seg({ speaker: 0 }), seg({ speaker: 1 })])).toBeNull()
  })
})
