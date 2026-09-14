// M39 §8 — the pure rules of bi-temporal contact facts (contact-facts.ts).
// Each test is one line of docs/M39-bitemporal-contacts-design.md's "tests it
// would ship with", plus the merge rules the advisor named before the build:
// redaction wins a shared id in either direction, and identical history never
// reports "restored" (the bump that would re-open BUG-279's loop).
import { describe, expect, it } from 'vitest'
import {
  CONTACT_TEMPORAL_RULES,
  DATED_CONTACT_FIELDS,
  MAX_FACTS_PER_FIELD,
  applyHistoryToFlat,
  currentFact,
  describeFactDate,
  factsAsOf,
  mergeFactHistories,
  recordFact,
  sanitizeFactHistory,
  type ContactFact
} from '../contact-facts'

const JUL = '2026-07-14T10:00:00.000Z'
const AUG = '2026-08-21T10:00:00.000Z'
const SEP = '2026-09-02T10:00:00.000Z'
const NOW = '2026-09-14T15:00:00.000Z'

const passthrough = (_f: string, raw: unknown): string | number | undefined =>
  typeof raw === 'string' || typeof raw === 'number' ? raw : undefined

describe('the temporal table', () => {
  it('dates exactly the 13 fields the founder decided on 2026-09-11', () => {
    expect([...DATED_CONTACT_FIELDS].sort()).toEqual(
      [
        'company',
        'title',
        'decisionAuthority',
        'budgetIndication',
        'timeline',
        'competitors',
        'currentTooling',
        'knownObjections',
        'otherStakeholders',
        'dealValue',
        'personalNotes',
        'notes',
        'briefingNotes'
      ].sort()
    )
    // Not name, not email, not phone — "administrative, not facts about the deal".
    expect(CONTACT_TEMPORAL_RULES.name).toBe('UNDATED')
    expect(CONTACT_TEMPORAL_RULES.email).toBe('UNDATED')
    expect(CONTACT_TEMPORAL_RULES.phone).toBe('UNDATED')
    expect(CONTACT_TEMPORAL_RULES.factHistory).toBe('RECORD')
  })
})

describe('recordFact', () => {
  it('closes the previous window at the NEW fact’s validFrom, not at now', () => {
    let h = recordFact([], {
      field: 'budgetIndication',
      value: '$50k',
      validFrom: JUL,
      validFromSource: 'call',
      source: 'ai-accepted',
      recordedAt: JUL
    })
    h = recordFact(h, {
      field: 'budgetIndication',
      value: '$80k',
      validFrom: SEP,
      validFromSource: 'call',
      source: 'ai-accepted',
      recordedAt: NOW
    })
    const [july, sept] = h
    expect(july?.value).toBe('$50k')
    expect(july?.validUntil).toBe(SEP) // the superseder's validFrom — recorded at NOW, closed in September
    expect(july?.supersededBy).toBe(sept?.id)
    expect(sept?.validUntil).toBeUndefined()
    expect(currentFact(h, 'budgetIndication')?.value).toBe('$80k')
  })

  it('a fact dated EARLIER than the open one enters history already superseded', () => {
    // The rep typed a budget today; then accepts an older suggestion from a July call.
    let h = recordFact([], {
      field: 'budgetIndication',
      value: 'typed today',
      validFrom: NOW,
      validFromSource: 'approx',
      source: 'user',
      recordedAt: NOW
    })
    h = recordFact(h, {
      field: 'budgetIndication',
      value: 'from July',
      validFrom: JUL,
      validFromSource: 'call',
      source: 'ai-accepted',
      recordedAt: NOW
    })
    expect(currentFact(h, 'budgetIndication')?.value).toBe('typed today')
    const july = h.find((f) => f.value === 'from July')
    expect(july?.validUntil).toBe(NOW)
  })

  it('clearing REDACTS every fact of that field — dates and sources stay, the words go', () => {
    let h = recordFact([], {
      field: 'personalNotes',
      value: 'neighbour back at 6',
      validFrom: AUG,
      validFromSource: 'approx',
      source: 'user',
      recordedAt: AUG
    })
    h = recordFact(h, {
      field: 'timeline',
      value: 'Q4',
      validFrom: AUG,
      validFromSource: 'approx',
      source: 'user',
      recordedAt: AUG
    })
    h = recordFact(h, {
      field: 'personalNotes',
      value: null,
      validFrom: NOW,
      validFromSource: 'approx',
      source: 'user',
      recordedAt: NOW
    })
    const notes = h.filter((f) => f.field === 'personalNotes')
    expect(notes).toHaveLength(2)
    for (const f of notes) {
      expect(f.value).toBeNull()
      expect(f.redacted).toBe(true)
    }
    expect(notes[0]?.validFrom).toBe(AUG) // the date survives
    expect(JSON.stringify(h)).not.toContain('neighbour')
    expect(currentFact(h, 'timeline')?.value).toBe('Q4') // another field is untouched
  })

  it('caps a field at 20 facts, dropping the oldest CLOSED first, never the open one', () => {
    let h: ContactFact[] = []
    for (let i = 0; i < MAX_FACTS_PER_FIELD + 5; i++) {
      const at = new Date(Date.parse(JUL) + i * 86_400_000).toISOString()
      h = recordFact(h, {
        field: 'timeline',
        value: `v${i}`,
        validFrom: at,
        validFromSource: 'approx',
        source: 'user',
        recordedAt: at
      })
    }
    expect(h).toHaveLength(MAX_FACTS_PER_FIELD)
    expect(currentFact(h, 'timeline')?.value).toBe(`v${MAX_FACTS_PER_FIELD + 4}`)
    expect(h.find((f) => f.value === 'v0')).toBeUndefined()
  })
})

describe('factsAsOf', () => {
  const history = recordFact(
    recordFact([], {
      field: 'budgetIndication',
      value: '$50k',
      validFrom: JUL,
      validFromSource: 'call',
      source: 'ai-accepted',
      recordedAt: JUL
    }),
    {
      field: 'budgetIndication',
      value: '$80k',
      validFrom: SEP,
      validFromSource: 'stated',
      source: 'user',
      recordedAt: SEP
    }
  )
  const contact = { budgetIndication: '$80k', timeline: 'Q4', factHistory: history }

  it('an open fact, a closed fact, and a NULL-validFrom fallback', () => {
    expect(factsAsOf(contact, NOW).budgetIndication).toMatchObject({
      value: '$80k',
      validFrom: SEP,
      validFromSource: 'stated'
    })
    expect(factsAsOf(contact, AUG).budgetIndication).toMatchObject({
      value: '$50k',
      validFrom: JUL,
      validFromSource: 'call',
      source: 'ai-accepted'
    })
    // Timeline has no history: the flat value, undated — a pre-release value.
    expect(factsAsOf(contact, NOW).timeline).toEqual({
      value: 'Q4',
      validFrom: null,
      validFromSource: null,
      source: null
    })
  })

  it('a gap before the first fact falls back to the flat value, undated', () => {
    expect(factsAsOf(contact, '2026-01-01T00:00:00.000Z').budgetIndication).toMatchObject({
      value: '$80k',
      validFrom: null
    })
  })

  it('a redacted fact covering the moment yields nothing — the words are gone', () => {
    const cleared = recordFact(history, {
      field: 'budgetIndication',
      value: null,
      validFrom: NOW,
      validFromSource: 'approx',
      source: 'user',
      recordedAt: NOW
    })
    expect(
      factsAsOf({ ...contact, budgetIndication: undefined, factHistory: cleared }, NOW)
        .budgetIndication
    ).toBeNull()
    expect(
      factsAsOf({ ...contact, budgetIndication: undefined, factHistory: cleared }, AUG)
        .budgetIndication
    ).toBeNull()
  })

  it('a tie on validFrom is broken by the latest recordedAt', () => {
    const a: ContactFact = {
      id: 'a',
      field: 'timeline',
      value: 'first',
      validFrom: JUL,
      validFromSource: 'approx',
      recordedAt: JUL,
      source: 'user'
    }
    const b: ContactFact = {
      id: 'b',
      field: 'timeline',
      value: 'second',
      validFrom: JUL,
      validFromSource: 'approx',
      recordedAt: AUG,
      source: 'user'
    }
    // Hand-built, un-derived windows — both open — to exercise the tie rule itself.
    expect(factsAsOf({ factHistory: [a, b] }, NOW).timeline?.value).toBe('second')
  })

  it('renders absolute days only: "since …, from a call", "noted …", "since …"', () => {
    expect(
      describeFactDate({
        value: 'x',
        validFrom: JUL,
        validFromSource: 'call',
        source: 'ai-accepted'
      })
    ).toBe(' (since 2026-07-14, from a call)')
    expect(
      describeFactDate({ value: 'x', validFrom: AUG, validFromSource: 'approx', source: 'user' })
    ).toBe(' (noted 2026-08-21)')
    expect(
      describeFactDate({ value: 'x', validFrom: SEP, validFromSource: 'stated', source: 'user' })
    ).toBe(' (since 2026-09-02)')
    expect(
      describeFactDate({ value: 'x', validFrom: null, validFromSource: null, source: null })
    ).toBe('')
  })
})

describe('applyHistoryToFlat', () => {
  it('follows the open fact where there is one and leaves undated fields alone', () => {
    const h = recordFact([], {
      field: 'title',
      value: 'CFO',
      validFrom: SEP,
      validFromSource: 'approx',
      source: 'user',
      recordedAt: SEP
    })
    const out = applyHistoryToFlat({ title: 'VP', budgetIndication: 'approved' }, h)
    expect(out).toEqual({ title: 'CFO', budgetIndication: 'approved' })
  })
})

describe('mergeFactHistories', () => {
  const fact = (
    id: string,
    field: ContactFact['field'],
    value: string | null,
    validFrom: string
  ): ContactFact => ({
    id,
    field,
    value,
    validFrom,
    validFromSource: 'approx',
    recordedAt: validFrom,
    source: 'user',
    ...(value === null ? { redacted: true as const } : {})
  })

  it('unions by id and reports when local held something the cloud copy lacked', () => {
    const local = [fact('a', 'timeline', 'Q3', JUL), fact('b', 'timeline', 'Q4', SEP)]
    const incoming = [fact('a', 'timeline', 'Q3', JUL), fact('c', 'budgetIndication', '$1', AUG)]
    const { merged, restoredFromLocal } = mergeFactHistories(local, incoming)
    expect(merged.map((f) => f.id).sort()).toEqual(['a', 'b', 'c'])
    expect(restoredFromLocal).toBe(true)
    expect(currentFact(merged, 'timeline')?.id).toBe('b')
  })

  it('identical history on both sides is NOT "restored" — nothing to bump, nothing to loop', () => {
    const h = [fact('a', 'timeline', 'Q3', JUL), fact('b', 'timeline', 'Q4', SEP)]
    const { merged, restoredFromLocal } = mergeFactHistories(h, h)
    expect(restoredFromLocal).toBe(false)
    expect(merged).toHaveLength(2)
    // and a superset on the INCOMING side is not "restored from local" either
    expect(mergeFactHistories([h[0]!], h).restoredFromLocal).toBe(false)
  })

  it('redaction wins a shared id — in either direction', () => {
    const words = [fact('a', 'personalNotes', 'neighbour back at 6', AUG)]
    const cleared = [fact('a', 'personalNotes', null, AUG), fact('z', 'personalNotes', null, NOW)]
    for (const [local, incoming] of [
      [words, cleared],
      [cleared, words]
    ] as const) {
      const { merged } = mergeFactHistories(local, incoming)
      expect(JSON.stringify(merged)).not.toContain('neighbour')
      expect(merged.every((f) => f.redacted)).toBe(true)
    }
  })

  it('a clearing on one side redacts that field’s older facts the clearing device never saw', () => {
    const local = [fact('x', 'personalNotes', 'only on this machine', JUL)]
    const incoming = [fact('z', 'personalNotes', null, NOW)]
    const { merged } = mergeFactHistories(local, incoming)
    expect(JSON.stringify(merged)).not.toContain('only on this machine')
  })

  it('a value entered AFTER a clearing is a new claim and keeps its words', () => {
    const local = [fact('z', 'personalNotes', null, AUG)]
    const incoming = [fact('n', 'personalNotes', 'new note', SEP)]
    const { merged } = mergeFactHistories(local, incoming)
    expect(currentFact(merged, 'personalNotes')?.value).toBe('new note')
  })
})

describe('sanitizeFactHistory — off disk and off the cloud, so untrusted', () => {
  const good = {
    id: 'f1',
    field: 'title',
    value: 'CFO',
    validFrom: SEP,
    validFromSource: 'call',
    recordedAt: SEP,
    source: 'ai-accepted',
    callId: 'call-1'
  }

  it('keeps a well-formed fact and re-derives its window', () => {
    const out = sanitizeFactHistory(
      [{ ...good, validUntil: '1999-01-01T00:00:00.000Z', supersededBy: 'planted' }],
      passthrough
    )
    expect(out).toHaveLength(1)
    expect(out?.[0]).toMatchObject({ id: 'f1', field: 'title', value: 'CFO', callId: 'call-1' })
    expect(out?.[0]?.validUntil).toBeUndefined() // never trusted from disk
    expect(out?.[0]?.supersededBy).toBeUndefined()
  })

  it('drops a fact on an UNDATED field — a tampered payload cannot plant one on email', () => {
    expect(
      sanitizeFactHistory([{ ...good, field: 'email', value: 'x@y.z' }], passthrough)
    ).toBeUndefined()
  })

  it('drops bad ids, unparseable dates, and values the field’s own sanitizer rejects', () => {
    expect(sanitizeFactHistory([{ ...good, id: '../etc' }], passthrough)).toBeUndefined()
    expect(sanitizeFactHistory([{ ...good, validFrom: 'yesterday' }], passthrough)).toBeUndefined()
    expect(sanitizeFactHistory([good], () => undefined)).toBeUndefined()
    expect(sanitizeFactHistory('not a list', passthrough)).toBeUndefined()
  })

  it('a null value is a clearing and comes back redacted, whatever the flag said', () => {
    const out = sanitizeFactHistory([{ ...good, value: null }], passthrough)
    expect(out?.[0]).toMatchObject({ value: null, redacted: true })
  })

  it('unknown enum values fall back rather than fail (approx, import)', () => {
    const out = sanitizeFactHistory(
      [{ ...good, validFromSource: 'guess', source: 'martian' }],
      passthrough
    )
    expect(out?.[0]).toMatchObject({ validFromSource: 'approx', source: 'import' })
  })
})
