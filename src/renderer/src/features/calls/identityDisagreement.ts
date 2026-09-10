/**
 * M39 — the app holds two identity claims about the same call and shows the rep
 * only the one more likely to be wrong.
 *
 * MEASURED on the founder's profile 2026-09-10: 47 calls carry a self-intro
 * identity, every one of them is linked to a contact, and on **6 of them the
 * spoken name contradicts the linked contact** — "Harvey" on a call linked to
 * kerry, "Paul Trader" on one linked to Damien Donehue. Nothing surfaces the
 * contradiction, so the rep sees the link (which is wrong) and never the name
 * (which came from the buyer's own mouth).
 *
 * THE ERROR BUDGET HERE IS NOT THE MATCHER'S, and that is the whole design.
 * `matchContactByName` PRODUCES an answer — picks one contact out of fifty with
 * nothing to check itself against — so it is strict and refuses ties. This
 * FLAGS an answer that already exists, and the founder's rule for that is:
 *
 *   "Two false flags and I stop reading the surface. A refused match costs a
 *    link; a false correction costs the feature."
 *
 * So the bias inverts: lenient about incompleteness, strict only about
 * contradiction. Reusing the matcher's rules here reported 7 of 297 calls, two
 * of which ("Kevin" vs contact "Kevin Mooney") were one person described at
 * different lengths. Leniency in both directions took it to 6, all genuine.
 */
export interface ContactLike {
  id: string
  name: string
}

export interface IdentityDisagreement {
  /** What the buyer called themselves, as extracted from the transcript. */
  spokenName: string
  /** The contact this call is currently linked to. */
  linkedContact: ContactLike
  /**
   * What to offer instead, decided the same way `matchContactByName` decides —
   * strictly, because this half PRODUCES an answer even though the flag itself
   * does not:
   *   'link'      — exactly one other contact carries the spoken name
   *   'create'    — no contact carries it
   *   'ambiguous' — several do, so the rep picks; we must not choose
   */
  suggestion:
    | { kind: 'link'; contact: ContactLike }
    | { kind: 'create' }
    | { kind: 'ambiguous'; candidates: ContactLike[] }
}

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * Do these two names describe the same person? Deliberately generous: only a
 * genuine contradiction should ever reach the rep.
 *
 *   "Kevin"          vs "Kevin Mooney"   -> consistent (the buyer gave less)
 *   "Paul Trader"    vs "Paul"           -> consistent (the buyer gave more)
 *   "Philip Collins" vs "Philip Genio"   -> CONTRADICTION, two different people
 */
export function namesCorrespond(spoken: string, contactName: string): boolean {
  const s = norm(spoken)
  const c = norm(contactName)
  if (!s || !c) return true // nothing to contradict
  if (s === c) return true
  const sw = s.split(' ')
  const cw = c.split(' ')
  // One side gave only a first name, and it is the other's first name.
  if (sw.length === 1 && cw.length > 1) return sw[0] === cw[0]
  if (cw.length === 1 && sw.length > 1) return cw[0] === sw[0]
  return false
}

/** The strict half — the same two rules `matchContactByName` uses in main. */
function suggestFor(spoken: string, contacts: ContactLike[], excludeId: string): IdentityDisagreement['suggestion'] {
  const s = norm(spoken)
  const pool = contacts.filter((c) => c.id !== excludeId)

  const exact = pool.filter((c) => norm(c.name) === s)
  if (exact.length === 1) return { kind: 'link', contact: exact[0] }
  if (exact.length > 1) return { kind: 'ambiguous', candidates: exact }

  const words = s.split(' ')
  if (words.length > 1) {
    const byFirst = pool.filter((c) => norm(c.name) === words[0])
    if (byFirst.length === 1) return { kind: 'link', contact: byFirst[0] }
    if (byFirst.length > 1) return { kind: 'ambiguous', candidates: byFirst }
  }
  return { kind: 'create' }
}

/**
 * Returns the disagreement to surface, or null when there is nothing to say —
 * which is the answer for 291 of the founder's 297 calls, and must stay that
 * way. Null when: no spoken name, no link, the link is to a contact we cannot
 * see, or the two names correspond.
 */
export function identityDisagreement(input: {
  spokenName: string | undefined
  linkedContactId: string | undefined
  contacts: ContactLike[]
}): IdentityDisagreement | null {
  const spoken = (input.spokenName ?? '').trim()
  if (!spoken || !input.linkedContactId) return null
  const linked = input.contacts.find((c) => c.id === input.linkedContactId)
  if (!linked) return null // a link we cannot explain is not a contradiction
  if (namesCorrespond(spoken, linked.name)) return null
  return {
    spokenName: spoken,
    linkedContact: linked,
    suggestion: suggestFor(spoken, input.contacts, linked.id)
  }
}

/**
 * THE ONE SOURCE THIS SURFACE IS ALLOWED TO SPEAK FOR.
 *
 * Every line of the notice's copy says "They introduced themselves by name",
 * so the identity behind it has to actually BE a self-introduction. The
 * component first fed it `otherPartyIdentity` — "the first identity whose
 * source isn't user-profile" — which is a wider set: calendar, contact,
 * participant-list, voice-profile and manual all qualify for that.
 *
 * MEASURED on the founder's profile 2026-09-10, which is why this is a fix and
 * not a tidy-up. Identity records there: 144 user-profile, 47 self-intro, 1
 * manual. Raw contradictions under the wider selector: 14. Under self-intro
 * alone: 13. The extra one is the `manual` record — a name the REP TYPED —
 * and it would have been shown back to them under a sentence claiming the
 * buyer had said it.
 *
 * A manual rename that disagrees with the link is usually not an error either:
 * renaming the speaker to the human who actually joined, while the call stays
 * linked to the account's main contact, is a legitimate thing to do. Flagging
 * it would spend the surface's whole error budget — "two false flags and I
 * stop reading it" — on the one source where the rep already knows the answer.
 */
export function selfIntroName(
  identities: Record<string, { name?: unknown; source?: unknown } | undefined> | undefined
): string | undefined {
  if (!identities) return undefined
  const found = Object.values(identities).find((v) => v && v.source === 'self-intro')
  return typeof found?.name === 'string' ? found.name : undefined
}
