// BUG-172 — marking the calls where the app promised to record the buyer and
// did not, so a transcript that is half a conversation says so.
//
// NINE calls on the founder's machine qualify (measured 2026-09-02 against 271
// records; an earlier note here said thirteen and was never measured). Seven
// once BUG-175's floor drops the two the app cannot judge. Read back cold,
// every one of them looks like a call where the
// buyer barely spoke. The founder asked for this directly: "Otherwise I'll
// read them later and think the buyer said nothing."
import { describe, expect, it } from 'vitest'
import { otherPartyPromisedButMissing, CHANNEL_ATTRIBUTION_SINCE } from '../types'

const consented = { recordOtherParty: true }
// Real call records always carry createdAt. Fixtures that expect a VERDICT
// must carry one too, or they are testing a call the app declines to judge.
const AFTER = '2026-08-17T10:00:00.000Z'
const seg = (channel: number | undefined, kind?: string): { channel?: number; kind?: string } => ({
  channel,
  kind
})

describe('BUG-172 — which calls were half-recorded', () => {
  it('flags a consented call whose segments carry NO channel at all', () => {
    expect(
      otherPartyPromisedButMissing({
        createdAt: AFTER,
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
        createdAt: AFTER,
        consent: consented,
        segments: [seg(undefined), seg(0, 'gap')]
      })
    ).toBe(true)
  })
})

describe('BUG-175 — a call from before channel attribution existed cannot be judged', () => {
  // Found by driving the real store for M33: two of the nine flagged calls were
  // dated 2026-07-27/28, before ANY call in 271 records carried a channel. For
  // those, 'no channel on any segment' is what every call looked like, so the
  // marker was claiming a failure it could not have detected.
  const promisedAndChannelless = (createdAt: string | null) => ({
    createdAt,
    consent: { recordOtherParty: true },
    segments: [seg(undefined), seg(undefined)]
  })

  it('does NOT flag a call created before CHANNEL_ATTRIBUTION_SINCE', () => {
    expect(otherPartyPromisedButMissing(promisedAndChannelless('2026-07-27T10:00:00.000Z'))).toBe(false)
  })

  it('DOES still flag an identical call created after it', () => {
    expect(otherPartyPromisedButMissing(promisedAndChannelless('2026-08-17T10:00:00.000Z'))).toBe(true)
  })

  it('does NOT flag a call whose date is missing or unparseable', () => {
    expect(otherPartyPromisedButMissing(promisedAndChannelless(null))).toBe(false)
    expect(otherPartyPromisedButMissing(promisedAndChannelless('not a date'))).toBe(false)
  })

  it('the boundary itself is inclusive — a call ON the date is judged', () => {
    expect(otherPartyPromisedButMissing(promisedAndChannelless(CHANNEL_ATTRIBUTION_SINCE + 'T00:00:00.000Z'))).toBe(true)
  })
})
