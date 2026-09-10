// M39 — the disagreement surface's logic, tested against the SIX real cases.
//
// Every "flags" case below is a call that exists on the founder's profile
// today. Every "stays silent" case is one of the 291 that must not be touched:
// a false flag is the expensive error here, because two of them and the rep
// stops reading the surface at all.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { identityDisagreement, namesCorrespond, selfIntroName } from '../identityDisagreement'

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

describe('M39 — only a self-introduction may be flagged', () => {
  // The notice says "They introduced themselves by name" three different ways
  // and has no other voice. Feeding it any other source makes that sentence a
  // false statement about a real person's call. All seven sources in the type
  // are enumerated here rather than sampled, because "the container the claim
  // names" is the whole type, not the ones that happen to be populated today.
  const SOURCES = [
    'user-profile',
    'calendar',
    'contact',
    'participant-list',
    'self-intro',
    'voice-profile',
    'manual'
  ] as const

  it.each(SOURCES.filter((s) => s !== 'self-intro'))('ignores a %s identity', (source) => {
    expect(selfIntroName({ 'mono/spk1': { name: 'Harvey', source } })).toBeUndefined()
  })

  it('returns the name for a self-intro identity', () => {
    expect(selfIntroName({ 'mono/spk1': { name: 'Harvey', source: 'self-intro' } })).toBe('Harvey')
  })

  it('picks the self-intro out of a record that also holds the rep and a rename', () => {
    // The real shape: the rep's own key is always present, and the founder's
    // profile carries one manual rename. `find()` order is not something to
    // rely on, so the selector is asked to skip past both.
    expect(
      selfIntroName({
        'mono/spk0': { name: 'Nir', source: 'user-profile' },
        'mono/spk2': { name: 'Someone Else', source: 'manual' },
        'mono/spk1': { name: 'Harvey', source: 'self-intro' }
      })
    ).toBe('Harvey')
  })

  it.each([
    ['no identities at all', undefined],
    ['an empty record', {}],
    ['an undefined entry', { 'mono/spk1': undefined }],
    ['a non-string name', { 'mono/spk1': { name: 42, source: 'self-intro' } }],
    ['a missing name', { 'mono/spk1': { source: 'self-intro' } }]
  ])('returns undefined for %s', (_label, input) => {
    expect(selfIntroName(input as Parameters<typeof selfIntroName>[0])).toBeUndefined()
  })

  it('a manual rename that contradicts the link produces NO disagreement', () => {
    // THE REGRESSION, stated as the product outcome rather than as a call to
    // the selector: this is the one extra flag the wider selector produced on
    // the founder's profile, and the rep would have been told the buyer said
    // a name that the rep typed themselves.
    const identities = { 'mono/spk1': { name: 'Harvey', source: 'manual' } }
    expect(
      identityDisagreement({
        spokenName: selfIntroName(identities),
        linkedContactId: 'kerry',
        contacts: CONTACTS
      })
    ).toBeNull()
  })

  it('CallDetail feeds the disagreement from selfIntroName, not otherPartyIdentity', () => {
    // A wiring check, because the bug was never in this module — it was in the
    // ONE line that chose what to hand it. A unit test of the selector cannot
    // fail if the component stops calling it.
    const src = readFileSync(join(__dirname, '..', 'CallDetail.tsx'), 'utf8')
    const call = src.match(/identityDisagreement\(\{[\s\S]*?\}\)/)
    expect(call, 'CallDetail must still call identityDisagreement').not.toBeNull()
    expect(call?.[0]).toContain('selfIntroName(call.speakerIdentities)')
    expect(call?.[0]).not.toContain('otherPartyIdentity')
  })
})
