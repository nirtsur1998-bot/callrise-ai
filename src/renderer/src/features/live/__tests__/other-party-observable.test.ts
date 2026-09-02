// M32 Stage 3b — the live instruments decline to judge when they cannot see
// the other side.
//
// Founder, on why declining rather than caveating: "a number with a caveat gets
// read as a number" — the same reasoning as the outcome-tracking gate.
//
// The controls here matter more than the assertions. The FIRST version of
// otherPartyObservable asked only "does any turn carry a channel", and six
// existing monologue tests caught it: a mono stream can still contain both
// sides (speakerphone, or the rep's mic picking the buyer up), diarized as two
// speakers with no channel on either. Suppressing there would blind the
// instruments on calls that are working fine. That case is pinned below.
import { describe, expect, it } from 'vitest'
import { otherPartyObservable } from '../other-party-capture'
import { MonologueTracker, type Turn as MonologueTurn } from '../monologue'
import { computeEngagementScore, type Turn as CueTurn } from '../useLiveCues'

const t = (speaker: number, text: string, at: number, channel?: number): CueTurn =>
  ({ speaker, text, t: at, channel }) as CueTurn

/** A healthy two-sided multichannel call: alternating, channels present. */
const twoSided = (): CueTurn[] => {
  const out: CueTurn[] = []
  let at = 0
  for (let i = 0; i < 10; i++) {
    out.push(t(0, i % 3 === 0 ? 'and what does that cost you today?' : 'we handle that end to end', (at += 6000), 0))
    out.push(t(1, i % 3 === 0 ? 'about forty hours a month' : 'okay that makes sense', (at += 6000), 1))
  }
  return out
}

/** The BUG-D population: identical rep audio, the buyer never captured. */
const oneSided = (): CueTurn[] => twoSided().filter((x) => x.speaker === 0).map((x) => ({ ...x, channel: undefined }))

describe('otherPartyObservable — the one fact every live instrument must read', () => {
  it('true when any turn carries a channel', () => {
    expect(otherPartyObservable([{ speaker: 0, channel: 0 }])).toBe(true)
    expect(otherPartyObservable([{ speaker: 1, channel: 1 }])).toBe(true)
  })

  // THE CONTROL THAT CAUGHT THE FIRST VERSION OF THIS RULE.
  it('CONTROL — true on a MONO call that diarized two speakers', () => {
    // Speakerphone, or the rep's mic picking the buyer up in the room. Both
    // sides are in the transcript; no channels anywhere. The instruments must
    // still work here.
    expect(otherPartyObservable([{ speaker: 0 }, { speaker: 1 }])).toBe(true)
  })

  it('false when there is one voice and no channels — the undecidable case', () => {
    expect(otherPartyObservable([{ speaker: 0 }, { speaker: 0 }, { speaker: 0 }])).toBe(false)
  })

  it('false on an empty buffer — nothing is known yet', () => {
    expect(otherPartyObservable([])).toBe(false)
  })
})

describe('Stage 3a FINDING 1 — the gauge declines rather than scoring a capture failure', () => {
  it('scores a healthy two-sided call', () => {
    expect(computeEngagementScore(twoSided(), 0)).toBeGreaterThan(0)
  })

  it('returns NULL on the identical rep audio with the buyer never captured', () => {
    // Previously 57, against 81 for the same audio two-sided — a worse reading
    // because the app failed to record the buyer.
    expect(computeEngagementScore(oneSided(), 0)).toBeNull()
  })

  // CONTROL — a quiet buyer is real information and must still be judged.
  it('CONTROL — still scores a call where channels exist but only the rep speaks', () => {
    const quietBuyer = twoSided()
      .filter((x) => x.speaker === 0)
      .map((x) => ({ ...x, channel: 0 }))
    expect(computeEngagementScore(quietBuyer, 0)).not.toBeNull()
  })

  it('CONTROL — still scores a mono call that diarized both sides', () => {
    const monoBothSides = twoSided().map((x) => ({ ...x, channel: undefined }))
    expect(computeEngagementScore(monoBothSides, 0)).not.toBeNull()
  })
})

describe('Stage 3a FINDING 3 (3b-2) — no symmetric guess when the rep is unknown', () => {
  // The old fallback scored "whichever speaker is more talkative", which is
  // symmetric arithmetically and NOT in meaning: a rep dominating is a pitch, a
  // buyer dominating is the rep listening. A buyer-heavy call read 37.
  const buyerHeavy = (): CueTurn[] => {
    const out: CueTurn[] = []
    let at = 0
    for (let i = 0; i < 8; i++) {
      out.push(t(0, 'mm hmm', (at += 6000), 0))
      out.push(t(1, 'the way we do it now is three teams and a spreadsheet nobody owns', (at += 6000), 1))
    }
    return out
  }

  it('returns NULL when the rep cannot be identified — guessing symmetrically is guessing', () => {
    expect(computeEngagementScore(buyerHeavy(), null)).toBeNull()
  })

  it('once the rep IS known, listening is not penalised', () => {
    // The rep said almost nothing. That is the goal of a discovery call, and
    // MONOLOGUE_TUNING already states the principle: "a meter that complains
    // about listening would be worse than none."
    const score = computeEngagementScore(buyerHeavy(), 0)
    expect(score).not.toBeNull()
    expect(score!).toBeGreaterThanOrEqual(computeEngagementScore(buyerHeavy(), 1)!)
  })
})

describe('Stage 3a FINDING 2 — the meter stops accusing the rep of a monologue it cannot see', () => {
  const asMonologue = (turns: CueTurn[]): MonologueTurn[] => turns as unknown as MonologueTurn[]

  it('reads zero and neutral when the other side was never captured', () => {
    // Previously: the run started at the FIRST turn of the call, so the meter
    // showed the WHOLE CALL in red under the label "you, uninterrupted".
    const s = new MonologueTracker().update(asMonologue(oneSided()), 0, 999_999)
    expect(s.ms).toBe(0)
    expect(s.tone).toBe('neutral')
    expect(s.nudging).toBe(false)
  })

  it('CONTROL — still times a real monologue on a mono call that diarized both sides', () => {
    // The rep talking for a long stretch on a call where the buyer HAS been
    // heard. This is a genuine monologue and must still be reported.
    const turns = asMonologue([
      t(1, 'okay', 0),
      t(0, 'so let me walk you through it', 10_000),
      t(0, 'and the second piece is onboarding', 40_000),
      t(0, 'and then reporting on top', 80_000)
    ])
    const s = new MonologueTracker().update(turns, 0, 100_000)
    expect(s.ms).toBeGreaterThan(0)
  })
})
