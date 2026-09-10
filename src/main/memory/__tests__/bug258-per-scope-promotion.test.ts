// BUG-258 — per-scope promotion thresholds.
//
// The rule was a flat 3 everywhere. Measured on the founder's store
// 2026-09-10: 297 calls, 44 contacts with a linked call, distributed
// {1 call: 24 contacts, 2: 8, 3: 5, 4: 4, 7: 1, 8: 1, 10: 1} — 55% of contacts
// have exactly ONE call and 73% fewer than three, so a client fact about them
// could never promote however well anything else worked.
//
// The arithmetic is not the argument that decides it. "The CFO signs off above
// 40k" is not a pattern; it is a fact stated once by someone entitled to state
// it, and requiring a buyer to repeat their own budget three times is wrong
// about who the authority is. The confidence floor carries what repetition used
// to, and a wrong fact is REPLACED WHEN CONTRADICTED rather than withheld.
import { describe, expect, it } from 'vitest'
import { qualifiesForPromotion } from '../consolidation'
import type { MemoryEvidence, MemoryScope } from '../types'

const calls = (...ids: string[]): MemoryEvidence[] =>
  ids.map((callId) => ({ type: 'transcript', callId })) as MemoryEvidence[]

const CONFIDENT = 0.95
const UNSURE = 0.4

describe('BUG-258 — rep and business are unchanged, and deliberately so', () => {
  it('still needs three separate calls for a REP pattern', () => {
    expect(qualifiesForPromotion('rep', calls('c1'), CONFIDENT)).toBe(false)
    expect(qualifiesForPromotion('rep', calls('c1', 'c2'), CONFIDENT)).toBe(false)
    expect(qualifiesForPromotion('rep', calls('c1', 'c2', 'c3'), CONFIDENT)).toBe(true)
  })

  it('still needs three for a BUSINESS fact', () => {
    expect(qualifiesForPromotion('business', calls('c1', 'c2'), CONFIDENT)).toBe(false)
    expect(qualifiesForPromotion('business', calls('c1', 'c2', 'c3'), CONFIDENT)).toBe(true)
  })

  it('does NOT apply the confidence floor to rep or business', () => {
    // They already clear three independent sightings. Adding a floor here
    // would be a second, unmeasured change riding along with this one.
    expect(qualifiesForPromotion('rep', calls('c1', 'c2', 'c3'), UNSURE)).toBe(true)
    expect(qualifiesForPromotion('business', calls('c1', 'c2', 'c3'), UNSURE)).toBe(true)
  })

  it('counts EPISODES, not evidence rows — two from one call is one sighting', () => {
    expect(qualifiesForPromotion('rep', calls('c1', 'c1', 'c1'), CONFIDENT)).toBe(false)
  })
})

describe('BUG-258 — a client fact is believed on the first telling, if it is confident', () => {
  it('promotes a confident client fact from ONE call', () => {
    expect(qualifiesForPromotion('client:contact-1', calls('c1'), CONFIDENT)).toBe(true)
  })

  it('still refuses an UNSURE client fact, however many times it appears', () => {
    // This is the whole point of trading repetition for a floor: the bar did
    // not disappear, it moved from "how often" to "how sure".
    expect(qualifiesForPromotion('client:contact-1', calls('c1'), UNSURE)).toBe(false)
    expect(qualifiesForPromotion('client:contact-1', calls('c1', 'c2', 'c3'), UNSURE)).toBe(false)
  })

  it('sits the floor at 0.85 — the highest value that costs nothing on real data', () => {
    // The founder's 14 client hypotheses are bimodal: 12 at or above 0.85, two
    // genuinely uncertain below. Every floor from 0.60 to 0.85 promotes the
    // same 12; 0.90 promotes 10.
    expect(qualifiesForPromotion('client:c', calls('c1'), 0.85)).toBe(true)
    expect(qualifiesForPromotion('client:c', calls('c1'), 0.84)).toBe(false)
  })

  it('treats every client scope the same, whichever contact it is', () => {
    for (const scope of ['client:aaa', 'client:bbb-222', 'client:me'] as MemoryScope[]) {
      expect(qualifiesForPromotion(scope, calls('c1'), CONFIDENT), scope).toBe(true)
    }
  })

  it('needs at least one episode — a fact with no evidence is not a fact', () => {
    expect(qualifiesForPromotion('client:c', [], 1.0)).toBe(false)
  })
})

describe('BUG-258 — the shape the old rule produced on real data', () => {
  it('a 1-call contact could never promote before, and can now', () => {
    // 24 of the founder's 44 linked contacts have exactly one call. Under the
    // flat 3 every fact about them was permanently stuck.
    const oneCall = calls('c1')
    expect(qualifiesForPromotion('client:one-call-contact', oneCall, 0.9)).toBe(true)
    // ...while the rep scope, fed by all 297 calls, is untouched by the change.
    expect(qualifiesForPromotion('rep', oneCall, 0.9)).toBe(false)
  })
})
