// M39 Stage 4 #1 — objection pre-loading.
//
// The founder's sentence for the feature: "She raised budget on the last two
// calls. Before pricing comes up, have the ROI reframe ready — the one that
// worked last time, with her."
//
// The tests that matter here are the REFUSALS. This is a surface that tells a
// rep what a specific human is about to do, so being confidently wrong costs
// more than being silent: it is a flagger, not a producer.
import { describe, expect, it } from 'vitest'
import { buildObjectionPreload, formatObjectionPreload, type MinedObjection } from '../objectionPreload'

const CONTACT = 'c1'
const calls = [
  { id: 'call-3', contactId: CONTACT, createdAt: '2026-09-02T10:00:00.000Z' },
  { id: 'call-2', contactId: CONTACT, createdAt: '2026-08-27T10:00:00.000Z' },
  { id: 'call-1', contactId: CONTACT, createdAt: '2026-08-20T10:00:00.000Z' },
  { id: 'other-contact', contactId: 'someone-else', createdAt: '2026-09-01T10:00:00.000Z' }
]

const obj = (o: Partial<MinedObjection> & { id: string; callId: string }): MinedObjection => ({
  type: 'price',
  objectionQuote: 'It is too expensive for us right now.',
  responseQuote: 'What are you comparing that price against, exactly?',
  recoveredWell: false,
  ...o
})

describe('M39 — a pattern needs two CALLS, not two mentions', () => {
  it('says nothing when a type came up once', () => {
    expect(buildObjectionPreload({ contactId: CONTACT, calls, objections: [obj({ id: 'a', callId: 'call-1' })] })).toEqual([])
  })

  it('says nothing when a type came up three times in ONE call', () => {
    // A buyer circling the same worry inside one conversation has one
    // objection, not three — and the founder's phrasing ("on the last two
    // calls") has to be true when we say it.
    const same = ['a', 'b', 'c'].map((id) => obj({ id, callId: 'call-1' }))
    expect(buildObjectionPreload({ contactId: CONTACT, calls, objections: same })).toEqual([])
  })

  it('reports a type raised on two different calls', () => {
    const out = buildObjectionPreload({
      contactId: CONTACT,
      calls,
      objections: [obj({ id: 'a', callId: 'call-1' }), obj({ id: 'b', callId: 'call-2' })]
    })
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('price')
    expect(out[0].calls).toBe(2)
    expect(out[0].lastRaised).toBe('2026-08-27')
  })
})

describe('M39 — the model’s "I could not classify this" is not a pattern', () => {
  it.each(['other', 'Other', 'unknown', 'none', ''])('ignores type %j', (type) => {
    // 108 of the founder's 287 mined objections are typed `other`. "They
    // raised OTHER on the last two calls" is not a pattern, it is two
    // classifications that failed — the same shape isNonName refuses.
    const objections = [obj({ id: 'a', callId: 'call-1', type }), obj({ id: 'b', callId: 'call-2', type })]
    expect(buildObjectionPreload({ contactId: CONTACT, calls, objections })).toEqual([])
  })

  it('still finds a real type alongside the unclassified ones', () => {
    const objections = [
      obj({ id: 'x', callId: 'call-1', type: 'other' }),
      obj({ id: 'y', callId: 'call-2', type: 'other' }),
      obj({ id: 'a', callId: 'call-1', type: 'timing' }),
      obj({ id: 'b', callId: 'call-2', type: 'timing' })
    ]
    const out = buildObjectionPreload({ contactId: CONTACT, calls, objections })
    expect(out.map((p) => p.type)).toEqual(['timing'])
  })
})

describe('M39 — what landed, and how honestly it is said', () => {
  it('quotes the reply the model judged recovered', () => {
    const objections = [
      obj({ id: 'a', callId: 'call-1', recoveredWell: true, responseQuote: 'What are you comparing that price against?' }),
      obj({ id: 'b', callId: 'call-2' })
    ]
    const [p] = buildObjectionPreload({ contactId: CONTACT, calls, objections })
    expect(p.whatWorked).toEqual({
      words: 'What are you comparing that price against?',
      on: '2026-08-20',
      kind: 'quote'
    })
    expect(formatObjectionPreload([p])[0]).toContain('what landed (2026-08-20)')
  })

  it('REFUSES to quote a fragment, and says so instead', () => {
    // 30 of the founder's 145 recovered objections carry a responseQuote under
    // 25 characters — "And yeah.", "Yes. Correct." — because the miner caught
    // a fragment. Telling a rep to answer a trust objection with "And yeah" is
    // worse than telling them nothing.
    const objections = [
      obj({
        id: 'a',
        callId: 'call-1',
        recoveredWell: true,
        responseQuote: 'And yeah.',
        judgmentNote: 'The rep acknowledged the concern and the buyer moved on without pressing it further.'
      }),
      obj({ id: 'b', callId: 'call-2' })
    ]
    const [p] = buildObjectionPreload({ contactId: CONTACT, calls, objections })
    expect(p.whatWorked?.kind).toBe('description')
    expect(p.whatWorked?.words).not.toBe('And yeah.')
    const line = formatObjectionPreload([p])[0]
    expect(line).toContain('nothing quotable was captured')
    expect(line).not.toContain('what landed')
    expect(line).not.toContain('"And yeah."')
  })

  it('prefers a quotable reply on an OLDER call over a fragment on a newer one', () => {
    const objections = [
      obj({ id: 'old', callId: 'call-1', recoveredWell: true, responseQuote: 'Let me show you the actual return on the last quarter.' }),
      obj({ id: 'new', callId: 'call-3', recoveredWell: true, responseQuote: 'Sure.', judgmentNote: 'A long enough judgment note to be usable as a description.' })
    ]
    const [p] = buildObjectionPreload({ contactId: CONTACT, calls, objections })
    expect(p.whatWorked?.kind).toBe('quote')
    expect(p.whatWorked?.on).toBe('2026-08-20')
  })

  it('says nothing has landed when nothing has', () => {
    // Said out loud rather than left as an absence: a pattern with no answer
    // beside it would read as "we did not look".
    const objections = [obj({ id: 'a', callId: 'call-1' }), obj({ id: 'b', callId: 'call-2' })]
    const [p] = buildObjectionPreload({ contactId: CONTACT, calls, objections })
    expect(p.whatWorked).toBeUndefined()
    expect(formatObjectionPreload([p])[0]).toContain('nothing has landed on this one yet')
  })
})

describe('M39 — it is about THIS buyer, and it is deterministic', () => {
  it('never counts another contact’s objections', () => {
    const objections = [obj({ id: 'a', callId: 'call-1' }), obj({ id: 'b', callId: 'other-contact' })]
    expect(buildObjectionPreload({ contactId: CONTACT, calls, objections })).toEqual([])
  })

  it('ignores an objection tied to no call we can see', () => {
    const objections = [obj({ id: 'a', callId: 'call-1' }), obj({ id: 'b', callId: 'a-call-that-was-deleted' })]
    expect(buildObjectionPreload({ contactId: CONTACT, calls, objections })).toEqual([])
  })

  it('ignores a deleted call', () => {
    const withDeleted = calls.map((c) => (c.id === 'call-2' ? { ...c, deleted: true } : c))
    const objections = [obj({ id: 'a', callId: 'call-1' }), obj({ id: 'b', callId: 'call-2' })]
    expect(buildObjectionPreload({ contactId: CONTACT, calls: withDeleted, objections })).toEqual([])
  })

  it('produces the same answer whatever order the records arrive in', () => {
    // It ends up inside a cached prompt prefix; a tie broken by iteration
    // order would silently cost the cache on every cue of the call.
    const objections = [
      obj({ id: 'a', callId: 'call-1', type: 'timing' }),
      obj({ id: 'b', callId: 'call-2', type: 'timing' }),
      obj({ id: 'c', callId: 'call-1', type: 'trust' }),
      obj({ id: 'd', callId: 'call-3', type: 'trust' })
    ]
    const forward = JSON.stringify(buildObjectionPreload({ contactId: CONTACT, calls, objections }))
    const backward = JSON.stringify(
      buildObjectionPreload({ contactId: CONTACT, calls: [...calls].reverse(), objections: [...objections].reverse() })
    )
    expect(forward).toBe(backward)
  })

  it('carries no relative date', () => {
    const objections = [obj({ id: 'a', callId: 'call-1' }), obj({ id: 'b', callId: 'call-2' })]
    const line = formatObjectionPreload(buildObjectionPreload({ contactId: CONTACT, calls, objections }))[0]
    expect(line).not.toMatch(/\bago\b|yesterday|last week/i)
    expect(line).toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it('returns the most-repeated pattern first, and honours the limit', () => {
    const objections = [
      obj({ id: 'a', callId: 'call-1', type: 'timing' }),
      obj({ id: 'b', callId: 'call-2', type: 'timing' }),
      obj({ id: 'c', callId: 'call-1', type: 'trust' }),
      obj({ id: 'd', callId: 'call-2', type: 'trust' }),
      obj({ id: 'e', callId: 'call-3', type: 'trust' })
    ]
    const out = buildObjectionPreload({ contactId: CONTACT, calls, objections, limit: 1 })
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('trust') // 3 calls beats 2
  })
})
