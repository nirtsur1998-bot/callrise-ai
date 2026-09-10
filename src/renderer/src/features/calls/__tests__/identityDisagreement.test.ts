// M39 — the disagreement surface's logic, tested against the SIX real cases.
//
// Every "flags" case below is a call that exists on the founder's profile
// today. Every "stays silent" case is one of the 291 that must not be touched:
// a false flag is the expensive error here, because two of them and the rep
// stops reading the surface at all.
import { describe, expect, it } from 'vitest'
import { identityDisagreement, namesCorrespond } from '../identityDisagreement'

const c = (id: string, name: string): { id: string; name: string } => ({ id, name })

// The founder's corpus, trimmed to the names that matter for these cases.
const CONTACTS = [
  c('kerry', 'kerry'),
  c('andre', 'Andre'),
  c('damien', 'Damien Donehue'),
  c('emma', 'emma'),
  c('daniel', 'Daniel'),
  c('philip-genio', 'Philip Genio'),
  c('kevin-mooney', 'Kevin Mooney'),
  c('harvey1', 'Harvey'),
  c('paul1', 'Paul'),
  c('paul2', 'Paul'),
  c('thomas', 'Thomas')
]

const run = (spokenName: string, linkedContactId: string): ReturnType<typeof identityDisagreement> =>
  identityDisagreement({ spokenName, linkedContactId, contacts: CONTACTS })

describe('M39 — flags the six real contradictions', () => {
  it('"Harvey" on a call linked to kerry', () => {
    const d = run('Harvey', 'kerry')
    expect(d).not.toBeNull()
    expect(d?.linkedContact.name).toBe('kerry')
    expect(d?.suggestion).toEqual({ kind: 'link', contact: c('harvey1', 'Harvey') })
  })

  it('"Anshur" on a call linked to Andre — nobody by that name, so offer to create', () => {
    const d = run('Anshur', 'andre')
    expect(d?.suggestion.kind).toBe('create')
  })

  it('"Paul Trader" on a call linked to Damien Donehue — and TWO Pauls, so refuse to choose', () => {
    // The strict half still applies to the suggestion: flagging is lenient,
    // but what it offers INSTEAD is a produced answer and must refuse a tie.
    const d = run('Paul Trader', 'damien')
    expect(d).not.toBeNull()
    expect(d?.suggestion.kind).toBe('ambiguous')
    expect(d?.suggestion.kind === 'ambiguous' && d.suggestion.candidates).toHaveLength(2)
  })

  it('"Thomas" on a call linked to emma', () => {
    expect(run('Thomas', 'emma')?.suggestion).toEqual({ kind: 'link', contact: c('thomas', 'Thomas') })
  })

  it('"Cheryl" on a call linked to Daniel', () => {
    expect(run('Cheryl', 'daniel')?.suggestion.kind).toBe('create')
  })

  it('"Philip Collins" on a call linked to Philip Genio — two different Philips', () => {
    // Shared first name, different surname, both given in full. That IS a
    // contradiction, and the leniency rule must not swallow it.
    const d = run('Philip Collins', 'philip-genio')
    expect(d).not.toBeNull()
    expect(d?.suggestion.kind).toBe('create')
  })
})

describe('M39 — and stays silent on the 291, which is the expensive half', () => {
  it('says nothing when the buyer gave LESS of the same name', () => {
    // The case that made the first measurement report 7 instead of 6.
    expect(run('Kevin', 'kevin-mooney')).toBeNull()
  })

  it('says nothing when the buyer gave MORE of the same name', () => {
    expect(run('Paul Trader', 'paul1')).toBeNull()
  })

  it('says nothing when the names are identical but differently cased or spaced', () => {
    expect(run('  KERRY  ', 'kerry')).toBeNull()
    expect(run('damien   donehue', 'damien')).toBeNull()
  })

  it('says nothing when there is no spoken name at all', () => {
    expect(identityDisagreement({ spokenName: undefined, linkedContactId: 'kerry', contacts: CONTACTS })).toBeNull()
    expect(identityDisagreement({ spokenName: '   ', linkedContactId: 'kerry', contacts: CONTACTS })).toBeNull()
  })

  it('says nothing when the call has no contact link — that is the OTHER surface', () => {
    // An unlinked call is the existing IdentityContactSuggestion's job. Two
    // banners for one call would be the app arguing with itself.
    expect(identityDisagreement({ spokenName: 'Harvey', linkedContactId: undefined, contacts: CONTACTS })).toBeNull()
  })

  it('says nothing when the linked contact cannot be found', () => {
    // A link we cannot explain is not a contradiction — it is a missing
    // record, and telling the rep their link is wrong on that basis would be
    // a false flag produced by our own incomplete data.
    expect(run('Harvey', 'no-such-contact')).toBeNull()
  })

  it('never offers to "fix" a call by linking it to the contact it is already on', () => {
    const d = run('Harvey', 'kerry')
    expect(d?.suggestion.kind === 'link' && d.suggestion.contact.id).not.toBe('kerry')
  })
})

describe('M39 — namesCorrespond, the leniency rule on its own', () => {
  it.each([
    ['Kevin', 'Kevin Mooney'],
    ['Kevin Mooney', 'Kevin'],
    ['Paul Trader', 'Paul'],
    ['sarah', 'Sarah'],
    ['Sarah  Chen', 'sarah chen']
  ])('%j and %j are the same person', (a, b) => {
    expect(namesCorrespond(a, b)).toBe(true)
  })

  it.each([
    ['Harvey', 'kerry'],
    ['Philip Collins', 'Philip Genio'],
    ['Thomas', 'emma'],
    ['Paul Trader', 'Damien Donehue']
  ])('%j and %j are NOT', (a, b) => {
    expect(namesCorrespond(a, b)).toBe(false)
  })

  it('treats an empty side as nothing to contradict', () => {
    expect(namesCorrespond('', 'kerry')).toBe(true)
    expect(namesCorrespond('Harvey', '')).toBe(true)
  })
})
