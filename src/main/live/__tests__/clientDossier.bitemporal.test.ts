// M39 §8 — "Known facts" read AS OF the call, with absolute days.
import { describe, expect, it } from 'vitest'
import { buildClientDossier, type DossierContact } from '../clientDossier'
import { recordFact } from '../../contact-facts'

const JUL = '2026-07-14T10:00:00.000Z'
const AUG = '2026-08-21T10:00:00.000Z'
const SEP = '2026-09-02T10:00:00.000Z'
const CALL = '2026-09-14T15:00:00.000Z'

const section = (text: string, heading: string): string[] => {
  const lines = text.split('\n')
  const start = lines.indexOf(`${heading}:`)
  if (start === -1) return []
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => !l.startsWith('- '))
  return end === -1 ? rest : rest.slice(0, end)
}

function contactWithHistory(): DossierContact {
  let h = recordFact([], {
    field: 'budgetIndication',
    value: '$50k',
    validFrom: JUL,
    validFromSource: 'call',
    source: 'ai-accepted',
    callId: 'c-jul',
    recordedAt: JUL
  })
  h = recordFact(h, {
    field: 'currentTooling',
    value: 'Salesforce',
    validFrom: SEP,
    validFromSource: 'stated',
    source: 'user',
    recordedAt: SEP
  })
  h = recordFact(h, {
    field: 'personalNotes',
    value: 'unable to go to the bank today',
    validFrom: AUG,
    validFromSource: 'approx',
    source: 'user',
    recordedAt: AUG
  })
  return {
    id: 'c1',
    name: 'ZZ Brett',
    budgetIndication: '$50k',
    currentTooling: 'Salesforce',
    personalNotes: 'unable to go to the bank today',
    timeline: 'Q4', // a pre-release value: no history
    factHistory: h
  }
}

describe('Known facts, bi-temporal', () => {
  it('renders each dated fact with its absolute day and leaves a pre-release value undated', () => {
    const { text } = buildClientDossier({
      contact: contactWithHistory(),
      calls: [],
      tasks: [],
      asOf: CALL
    })
    const facts = section(text, 'Known facts')
    expect(facts).toContain('- Budget: $50k (since 2026-07-14, from a call)')
    expect(facts).toContain('- Uses today: Salesforce (since 2026-09-02)')
    expect(facts).toContain('- Personal: unable to go to the bank today (noted 2026-08-21)')
    expect(facts).toContain('- Timeline: Q4')
  })

  it('a dossier rebuilt for an OLD call shows what was true THEN', () => {
    const contact = contactWithHistory()
    const superseded = recordFact(contact.factHistory!, {
      field: 'budgetIndication',
      value: '$80k',
      validFrom: SEP,
      validFromSource: 'call',
      source: 'ai-accepted',
      recordedAt: SEP
    })
    const c = { ...contact, budgetIndication: '$80k', factHistory: superseded }
    const now = section(
      buildClientDossier({ contact: c, calls: [], tasks: [], asOf: CALL }).text,
      'Known facts'
    )
    const then = section(
      buildClientDossier({ contact: c, calls: [], tasks: [], asOf: AUG }).text,
      'Known facts'
    )
    expect(now).toContain('- Budget: $80k (since 2026-09-02, from a call)')
    expect(then).toContain('- Budget: $50k (since 2026-07-14, from a call)')
    expect(then).not.toContain('- Uses today: Salesforce (since 2026-09-02)') // not yet true in August → falls back undated
  })

  it('a cleared (redacted) fact is absent, not "known"', () => {
    const contact = contactWithHistory()
    const cleared = recordFact(contact.factHistory!, {
      field: 'personalNotes',
      value: null,
      validFrom: SEP,
      validFromSource: 'approx',
      source: 'user',
      recordedAt: SEP
    })
    const c = { ...contact, personalNotes: undefined, factHistory: cleared }
    const facts = section(
      buildClientDossier({ contact: c, calls: [], tasks: [], asOf: CALL }).text,
      'Known facts'
    )
    expect(facts.some((l) => l.startsWith('- Personal:'))).toBe(false)
  })

  it('is byte-identical across two builds with dated facts in it', () => {
    const a = buildClientDossier({
      contact: contactWithHistory(),
      calls: [],
      tasks: [],
      asOf: CALL
    }).text
    const b = buildClientDossier({
      contact: contactWithHistory(),
      calls: [],
      tasks: [],
      asOf: CALL
    }).text
    expect(a).toBe(b)
    expect(a).not.toMatch(/\d+ (days?|weeks?) ago/)
  })

  it('a contact with no history renders exactly as before — no suffix, flat values', () => {
    const c: DossierContact = {
      id: 'c1',
      name: 'ZZ Brett',
      budgetIndication: '$50k',
      timeline: 'Q4'
    }
    const facts = section(
      buildClientDossier({ contact: c, calls: [], tasks: [], asOf: CALL }).text,
      'Known facts'
    )
    expect(facts).toEqual(['- Budget: $50k', '- Timeline: Q4'])
  })
})
