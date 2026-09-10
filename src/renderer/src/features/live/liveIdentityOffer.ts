/**
 * M39 Stage 2 — the identity offer, moved from after the call to during it.
 *
 * WHY THIS IS A PLACEMENT CHANGE AND NOT A NEW FEATURE. The app already asks
 * this exact question twice on the Call Detail page: IdentityContactSuggestion
 * ("Detected X on this call — no contact linked yet") when nothing is linked,
 * and IdentityDisagreementNotice ("Detected X on this call — but it's linked to
 * Y") when something is and the name contradicts it. Both offer the same three
 * outcomes — link an existing contact, create one, or refuse to choose between
 * several. The rep has already learned that interaction. Teaching them a second
 * vocabulary for the same decision would be two features to learn instead of
 * one, so this module produces the SAME shapes and the chip reuses the SAME
 * words. What changes is when they can act: mid-call, while the name is worth
 * something, instead of after the conversation it would have helped.
 *
 * THE TWO CLAIMS IT COMPARES, and where each comes from mid-call:
 *   - the spoken name — `buyerName` from useLiveCues, extracted by the live
 *     coaching cue from a self-introduction. Already gated twice: by the
 *     `allowSelfIntroExtraction` opt-in in main, and (from this milestone) by
 *     `isNonName` at the point the model's answer enters the app, so "someone"
 *     and "Speaker 2" never reach here.
 *   - the current link — `currentMeeting.contactId`. Mid-call there IS no call
 *     record to carry a link (the persisted Call is minted at save, with a
 *     fresh id), so the meeting is the only thing that holds one. That is a
 *     real difference from the post-call surface and the reason this module
 *     exists at all rather than the page's logic being called directly.
 *
 * DELIBERATELY NOT HERE: any gate. Consent, the contact-intelligence mode and
 * the extraction opt-in are all enforced by the caller, on the same values the
 * rest of the Live screen already reads. A gate re-implemented next to the
 * feature it guards is a gate that can drift away from the original.
 */
import {
  identityDisagreement,
  suggestContactFor,
  type ContactLike,
  type IdentityDisagreement
} from '@renderer/features/calls/identityDisagreement'

export type LiveIdentityOffer =
  /** Nothing is linked to this conversation and a name was heard. The
   *  post-call twin is IdentityContactSuggestion. */
  | { kind: 'unlinked'; spokenName: string; suggestion: IdentityDisagreement['suggestion'] }
  /** Something IS linked and the name contradicts it. The post-call twin is
   *  IdentityDisagreementNotice, whose logic this reuses wholesale. */
  | { kind: 'disagreement'; spokenName: string; disagreement: IdentityDisagreement }

/**
 * Returns what to offer, or null — which must stay the answer for the large
 * majority of calls. Null when: no name was heard, or a link exists and the
 * name agrees with it (the common case, and the one where saying anything at
 * all would be noise about a settled question).
 */
export function liveIdentityOffer(input: {
  spokenName: string | null | undefined
  linkedContactId: string | null | undefined
  contacts: ContactLike[]
}): LiveIdentityOffer | null {
  const spokenName = (input.spokenName ?? '').trim()
  if (!spokenName) return null

  if (!input.linkedContactId) {
    return { kind: 'unlinked', spokenName, suggestion: suggestContactFor(spokenName, input.contacts) }
  }

  // A meeting linked to a contact this renderer cannot see is not a
  // contradiction — it is a gap in what we loaded. identityDisagreement()
  // already returns null for that; this just names why.
  const disagreement = identityDisagreement({
    spokenName,
    linkedContactId: input.linkedContactId,
    contacts: input.contacts
  })
  return disagreement ? { kind: 'disagreement', spokenName, disagreement } : null
}
