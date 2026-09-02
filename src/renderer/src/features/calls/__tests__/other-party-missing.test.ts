// BUG-172 — marking the calls where the app promised to record the buyer and
// did not, so a transcript that is half a conversation says so.
//
// Thirteen calls on the founder's machine qualified, the oldest from
// 2026-07-27. Read back cold, every one of them looks like a call where the
// buyer barely spoke. The founder asked for this directly: "Otherwise I'll
// read them later and think the buyer said nothing."
import { describe, expect, it } from 'vitest'
import { otherPartyPromisedButMissing } from '../types'

const consented = { recordOtherParty: true }
const seg = (channel: number | undefined, kind?: string): { channel?: number; kind?: string } => ({
  channel,
  kind
})

describe('BUG-172 — which calls were half-recorded', () => {
  it('flags a consented call whose segments carry NO channel at all', () => {
    expect(
      otherPartyPromisedButMissing({
        consent: consented,
        segments: [seg(undefined), seg(undefined), seg(undefined)]
      })
    ).toBe(true)
  })

  // THE CONTROL THAT MATTERS MOST. Telling a rep their recording failed when
  // it did not is its own harm — and the obvious rule, "channel 1 has no
  // segments", would do exactly that to every call where the buyer said little.
  it('CONTROL — a call where the buyer was merely QUIET is not flagged', () => {
    expect(
      otherPartyPromisedButMissing({
        consent: consented,
        // loopback DID attach — the channels exist, channel 1 just has nothing
        segments: [seg(0), seg(0), seg(0), seg(0)]
      })
    ).toBe(false)
  })

  it('CONTROL — a normal two-channel call is not flagged', () => {
    expect(
      otherPartyPromisedButMissing({
        consent: consented,
        segments: [seg(0), seg(1), seg(0), seg(1)]
      })
    ).toBe(false)
  })

  it('CONTROL — a call that never promised is not flagged', () => {
    // No promise was made, so none was broken. Consent off is a deliberate
    // choice, not a failure, and must never carry a warning.
    expect(
      otherPartyPromisedButMissing({
        consent: { recordOtherParty: false },
        segments: [seg(undefined), seg(undefined)]
      })
    ).toBe(false)
    expect(otherPartyPromisedButMissing({ segments: [seg(undefined)] })).toBe(false)
  })

  it('CONTROL — an empty call is not flagged', () => {
    // Nothing was recorded at all, so there is no half-conversation to warn
    // about — and a warning on an empty call is just noise.
    expect(otherPartyPromisedButMissing({ consent: consented, segments: [] })).toBe(false)
  })

  it('a gap marker is not captured audio', () => {
    expect(
      otherPartyPromisedButMissing({
        consent: consented,
        segments: [seg(undefined), seg(0, 'gap')]
      })
    ).toBe(true)
  })
})
