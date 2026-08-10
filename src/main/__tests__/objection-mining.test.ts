// BUG-023 — objection-mining.ts had its own copy of the speaker-merge bug
// coach.ts was already fixed for (M21 Phase G), with zero test coverage.
// makeVerifier merged consecutive segments sharing a raw speaker number with
// no epoch check, so a reconnect (which restarts Deepgram's diarization
// numbering) could glue two different people's words into one "turn" a
// quote gets checked against.
import { describe, expect, it } from 'vitest'
import { makeVerifier } from '../objection-mining'
import type { CallSegment } from '../calls-fs'

const seg = (p: Partial<CallSegment> & { speaker: number; text: string }): CallSegment => ({ ...p })

describe('makeVerifier', () => {
  it('verifies a quote actually said by the claimed speaker', () => {
    const segments = [
      seg({ speaker: 0, text: 'Your pricing seems a bit high for our budget' }),
      seg({ speaker: 1, text: 'I hear you, let me see what I can do' })
    ]
    const verify = makeVerifier(segments)
    expect(verify('Your pricing seems a bit high for our budget', 0)).toBe(true)
  })

  it('does not verify a quote attributed to the wrong speaker', () => {
    const segments = [
      seg({ speaker: 0, text: 'Your pricing seems a bit high for our budget' }),
      seg({ speaker: 1, text: 'I hear you, let me see what I can do' })
    ]
    const verify = makeVerifier(segments)
    expect(verify('I hear you, let me see what I can do', 0)).toBe(false)
  })

  it('refuses to merge the same raw speaker number across a reconnect epoch boundary', () => {
    // Epoch 1: speaker 0 is the rep. Epoch 2 (post-reconnect, renumbered):
    // speaker 0 is actually the buyer. Pre-fix, these merged into one turn
    // purely on the shared number, letting a stitched quote spanning both
    // verify as if one person said it continuously.
    const segments = [
      seg({ speaker: 0, epoch: 1, text: 'I am worried about the price honestly' }),
      seg({ speaker: 0, epoch: 2, text: 'we can look at a discount for you' })
    ]
    const verify = makeVerifier(segments)
    // The stitched quote spans both epoch-1 and epoch-2 text under one number.
    expect(verify('I am worried about the price honestly we can look at a discount for you', 0)).toBe(
      false
    )
    // Each half still verifies on its own.
    expect(verify('I am worried about the price honestly', 0)).toBe(true)
    expect(verify('we can look at a discount for you', 0)).toBe(true)
  })

  it('still merges consecutive same-speaker segments within one epoch', () => {
    const segments = [
      seg({ speaker: 0, epoch: 1, text: 'I am worried about the' }),
      seg({ speaker: 0, epoch: 1, text: 'price honestly' })
    ]
    const verify = makeVerifier(segments)
    expect(verify('I am worried about the price honestly', 0)).toBe(true)
  })

  it('rejects a quote shorter than the minimum meaningful length', () => {
    const segments = [seg({ speaker: 0, text: 'ok sure' })]
    const verify = makeVerifier(segments)
    expect(verify('ok', 0)).toBe(false)
  })
})
