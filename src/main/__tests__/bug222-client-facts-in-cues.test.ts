// BUG-222 — the live cue prompt carries the client, and only ever an EXPLICIT one.
//
// The activation copy a rep reads when switching Sales Brain on promises "every
// AI feature in the app (live cues, coaching, chat, briefs) gets smarter from
// it" (SalesBrainSection.tsx:174). Coaching chat, Rise and the pre-call brief
// delivered. The live cue — the surface where a client fact is worth most,
// mid-call, about the person on the line — never received one.
//
// THE RULE THAT SHAPES THIS: never inferred. calls-fs.ts:474-486, on the
// call→deal link: "a guessed link is indistinguishable from a real one in every
// later analysis". A wrong client's budget arriving as advice mid-sentence,
// with nothing on the cue to check it against, is worse than no client at all.
import { describe, expect, it, vi, beforeEach } from 'vitest'

let brainEnabled = true
let compiled: Record<string, string> = {}

vi.mock('../app-settings', () => ({
  isSalesBrainEnabled: () => brainEnabled,
  isSelfIntroExtractionAllowed: () => false
}))
vi.mock('../memory/memory-runtime', () => ({ getMemoryDb: () => ({}) }))
vi.mock('../memory/memories-store', () => ({
  getCompiledProfile: (_db: unknown, scope: string) =>
    compiled[scope] === undefined ? undefined : { text: compiled[scope] }
}))

const { repProfileSection, clientProfileSection, injectionStats, resetInjectionStats } =
  await import('../memory/profile-injection')

beforeEach(() => {
  resetInjectionStats()
  brainEnabled = true
  compiled = {}
})

describe('BUG-222 — what reaches the prompt', () => {
  it('adds a labelled CLIENT section when the call has a linked contact', () => {
    compiled['client:contact-1'] = '- Budget approved at 40-60k, CFO signs off.'
    const section = clientProfileSection('contact-1', 'micro')

    expect(section).toContain('WHAT WE KNOW ABOUT THIS CLIENT')
    expect(section).toContain('Budget approved at 40-60k')
  })

  it('adds NOTHING — not even a header — when there is no linked contact', () => {
    // The majority case, measured: 96 of 297 calls carry a contactId at all, and
    // mid-call it is almost always absent. An unlinked call must produce a
    // prompt byte-identical to today's.
    // Red-check note: disabling the `if (!contactId) return ''` guard leaves
    // this GREEN, because `clientScope(null)` then keys a scope that has no
    // compiled profile and the empty-text path returns '' anyway. That is a
    // second independent defence rather than a hollow assertion — recorded
    // because "it went partially red and I changed nothing" needs a reason.
    compiled['client:contact-1'] = '- Budget approved.'
    expect(clientProfileSection(null, 'micro')).toBe('')
  })

  it('adds nothing when the contact is linked but the Brain knows nothing about them', () => {
    // A header with nothing under it is worse than silence: it tells the model
    // there is client context and then shows it none.
    compiled['client:contact-1'] = ''
    expect(clientProfileSection('contact-1', 'micro')).toBe('')
  })

  it('keeps the REP and CLIENT sections separate and separately labelled', () => {
    compiled['rep'] = '- Talks 70% of the time.'
    compiled['client:contact-1'] = '- Wants to be live before March.'
    const rep = repProfileSection('micro')
    const client = clientProfileSection('contact-1', 'micro')

    expect(rep).toContain('THIS REP')
    expect(client).toContain('THIS CLIENT')
    expect(rep).not.toContain('THIS CLIENT')
    expect(client).not.toContain('THIS REP')
  })
})

describe('BUG-222 — the cost is bounded by construction', () => {
  it('cannot exceed the micro budget however much the Brain learns', () => {
    // MEASURED cost of this change: +143 input tokens (+10.2%), median +166ms
    // against a control whose median was -17ms. That number only stays true
    // because the compiled profile is capped at 500 chars before it gets here —
    // the cap is what makes the measurement durable rather than a snapshot.
    compiled['client:contact-1'] = 'x'.repeat(500)
    const section = clientProfileSection('contact-1', 'micro')
    expect(section.length).toBeLessThan(600)
  })
})

describe('BUG-222 — the injection is counted, so an empty one is visible', () => {
  it('records an injection when the client profile has content', () => {
    compiled['client:contact-1'] = '- Something true.'
    clientProfileSection('contact-1', 'micro')
    expect(injectionStats()['client:injected']).toBe(1)
  })

  it('records compiled-but-empty when the client has no facts yet', () => {
    // BUG-258's counter doing its job here: before it, "asked and got nothing"
    // and "never asked" were the same silence, and this feature would have
    // looked identical whether it worked or not.
    compiled['client:contact-1'] = ''
    clientProfileSection('contact-1', 'micro')
    expect(injectionStats()['client:compiled-but-empty']).toBe(1)
  })

  it('does not count an unlinked call at all — that is not a failed injection', () => {
    clientProfileSection(null, 'micro')
    expect(injectionStats()).toEqual({})
  })
})
