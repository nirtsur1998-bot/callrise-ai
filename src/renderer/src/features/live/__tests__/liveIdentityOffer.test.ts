// M39 Stage 2 — what the live chip offers, and (mostly) what it doesn't.
//
// The silence cases matter more than the offers. This appears next to a live
// transcript while a real conversation is happening; the founder's standing
// rule for a surface that flags an existing answer is "two false flags and I
// stop reading it", and mid-call the rep cannot go and check.
//
// The contact fixtures are the founder's real shapes with fictional names:
// single-word contacts (35 of their 50 are), shared first names (8), and one
// exact collision (3 of those exist).
import { describe, expect, it } from 'vitest'
import { liveIdentityOffer } from '../liveIdentityOffer'

const c = (id: string, name: string): { id: string; name: string } => ({ id, name })

const CONTACTS = [
  c('kerry', 'kerry'),
  c('harvey', 'Harvey'),
  c('damien', 'Damien Donehue'),
  c('kevin-a', 'Kevin'),
  c('kevin-b', 'Kevin'),
  c('kevin-mooney', 'Kevin Mooney'),
  c('priya', 'Priya Raman')
]

const offer = (spokenName: string | null, linkedContactId?: string | null) =>
  liveIdentityOffer({ spokenName, linkedContactId, contacts: CONTACTS })

/** The suggestion, whichever shape the offer came back as — so a test can say
 *  "offers to link X" without first restating which branch it expects. */
const suggestionOf = (o: ReturnType<typeof offer>) =>
  o === null ? null : o.kind === 'unlinked' ? o.suggestion : o.disagreement.suggestion

describe('M39 — the live identity offer, unlinked', () => {
  it('offers the one contact that carries the name', () => {
    const o = offer('Harvey', null)
    expect(o?.kind).toBe('unlinked')
    expect(suggestionOf(o)).toEqual({ kind: 'link', contact: c('harvey', 'Harvey') })
  })

  it('offers to create when nobody carries it', () => {
    expect(suggestionOf(offer('Anshur Bell', null))).toEqual({ kind: 'create' })
  })

  it('REFUSES to choose when several carry it', () => {
    const s = suggestionOf(offer('Kevin', null))
    expect(s?.kind).toBe('ambiguous')
    expect(s?.kind === 'ambiguous' && s.candidates).toHaveLength(2)
  })

  it('matches a full spoken name against a single-word contact', () => {
    // 35 of the founder's 50 contacts are one word, so this is the common
    // shape, not the edge case.
    expect(suggestionOf(offer('Harvey Wells', null))).toEqual({
      kind: 'link',
      contact: c('harvey', 'Harvey')
    })
  })

  it('is silent when no name was heard', () => {
    expect(offer(null, null)).toBeNull()
    expect(offer('', null)).toBeNull()
    expect(offer('   ', 'kerry')).toBeNull()
  })
})

describe('M39 — the live identity offer, already linked', () => {
  it('says nothing when the name and the meeting link agree', () => {
    // THE CASE THAT MUST STAY SILENT, and the one that covers most calls: the
    // meeting is linked to the person who then introduces themselves.
    expect(offer('Harvey', 'harvey')).toBeNull()
  })

  it('stays silent when the buyer gave less of their name than the contact holds', () => {
    expect(offer('Kevin', 'kevin-mooney')).toBeNull()
  })

  it('stays silent when the buyer gave more of it', () => {
    expect(offer('Priya Raman Gupta', 'priya')).toBeNull()
  })

  it('flags a genuine contradiction, and offers the right contact', () => {
    // The founder's real "Harvey vs kerry" shape, mid-call.
    const o = offer('Harvey', 'kerry')
    expect(o?.kind).toBe('disagreement')
    expect(o?.kind === 'disagreement' && o.disagreement.linkedContact.name).toBe('kerry')
    expect(o?.kind === 'disagreement' && o.disagreement.suggestion).toEqual({
      kind: 'link',
      contact: c('harvey', 'Harvey')
    })
  })

  it('never offers the contact the meeting is already linked to', () => {
    // A "correction" that proposes the link you already have is worse than
    // saying nothing: it reads as a bug and spends the trust anyway.
    const o = offer('Harvey', 'kerry')
    expect(o?.kind === 'disagreement' && o.disagreement.suggestion.kind === 'link' && o.disagreement.suggestion.contact.id).not.toBe('kerry')
  })

  it('offers to create when the contradicting name is nobody we know', () => {
    const o = offer('Anshur Bell', 'damien')
    expect(o?.kind === 'disagreement' && o.disagreement.suggestion).toEqual({ kind: 'create' })
  })

  it('refuses to choose between contacts sharing the contradicting name', () => {
    const o = offer('Kevin', 'damien')
    expect(o?.kind === 'disagreement' && o.disagreement.suggestion.kind).toBe('ambiguous')
  })

  it('is silent when the meeting is linked to a contact this renderer cannot see', () => {
    // A gap in what we loaded is not a contradiction.
    expect(offer('Harvey', 'a-contact-not-in-the-list')).toBeNull()
  })
})

describe('M39 — the live offer and the post-call notice give the same answer', () => {
  // The founder's requirement for this stage was that the live version match
  // the post-call one "exactly — same words, same offer shape, same
  // create-or-link choice". Words are checked by reading the components; this
  // checks the SHAPE, by running both halves over the same inputs. They are
  // the same code path by construction (liveIdentityOffer delegates to
  // identityDisagreement), and this test is what would notice if that stopped
  // being true.
  it.each([
    ['Harvey', 'kerry'],
    ['Anshur Bell', 'damien'],
    ['Kevin', 'damien'],
    ['Harvey', 'harvey'],
    ['Kevin', 'kevin-mooney']
  ])('%j linked to %j decides identically on both surfaces', async (spoken, linked) => {
    const { identityDisagreement } = await import('@renderer/features/calls/identityDisagreement')
    const post = identityDisagreement({
      spokenName: spoken,
      linkedContactId: linked,
      contacts: CONTACTS
    })
    const live = offer(spoken, linked)
    expect(live?.kind === 'disagreement' ? live.disagreement : null).toEqual(post)
  })
})
