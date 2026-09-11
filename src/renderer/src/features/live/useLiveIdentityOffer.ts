/**
 * M39 Stage 2 — holds the live identity offer and the rep's answer to it.
 *
 * THE PROBLEM THIS HOOK EXISTS TO SOLVE. On the Call Detail page "Link to
 * Kerry" writes a link immediately, because a Call record is sitting on disk
 * waiting for it. Mid-call there is no such record: the live transcript lives
 * in main's accumulator plus a journal, and the persisted Call is minted at
 * `calls:save` with a FRESH uuid — the live call id is not even the id the
 * record ends up with. Wiring the chip's button straight to
 * `calls:setContact(liveCallId, …)` would therefore call a handler whose
 * `getCall` returns null, which returns null, which looks exactly like
 * success from the renderer. A silent no-op that reads as a working button is
 * the worst available outcome, so the decision is HELD here and applied at
 * the one moment there is something to apply it to: `handleSaved`.
 *
 * WHAT IT DOES NOT TOUCH. Not the calendar event. The meeting is where the
 * mid-call link lives, so "correcting" it is tempting — and for an Outlook or
 * Google event that write is an EGRESS: it would push a contact change out to
 * the founder's real calendar. (LiveView's own `events.update` for the saved
 * call id is guarded by `meeting.source === 'local'` for the same reason.) The
 * rep's answer changes the call record and nothing else; the meeting keeps
 * whatever the calendar says.
 *
 * GATES ARE INHERITED, NOT REBUILT. `enabled` is passed in from the same
 * `contactIntelligence.mode` and consent values the rest of the Live screen
 * already reads, and the name itself only exists when the self-intro opt-in is
 * on. Nothing new is gated here.
 *
 * THE LIFETIME — and what the first version of this comment got wrong.
 *
 * This hook lives in LiveView, and LiveView unmounts on every screen
 * navigation. The original header said that dropped the held decision. Traced
 * properly, it does not: `setOnSaved` is deliberately never cleared on unmount
 * (see its doc comment in useLiveCall.ts), so `handleSaved` outlives the view,
 * and its closure still reaches a `useRef` object whose fiber is gone. An
 * unmount on its own is harmless.
 *
 * The loss is on the way BACK. A remount builds a FRESH ref,
 * `identityOfferApplyRef` is repointed at the new closure, and the answer
 * given before the navigation becomes unreachable — while the chip, whose
 * `dismissed`/`acceptedName` are plain `useState`, asks again as if nothing
 * had been said. Right about the consequence, wrong about the trigger, which
 * matters: "don't navigate away" was never the mitigation, and the case that
 * actually loses an answer is the one a rep is most likely to do — check the
 * pipeline, come back.
 *
 * FIXED by moving the held answer up to `LiveCallProvider`, whose lifetime is
 * the CALL's rather than the view's (`liveIdentity` in useLiveCall.ts). The
 * hook still owns the question; it no longer owns the answer. `held` is
 * optional so the hook stays testable and usable without a Provider, and the
 * fallback is the old view-lifetime ref — said out loud, because a default
 * that silently reintroduces the bug would be worse than no default.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { liveIdentityOffer, type LiveIdentityOffer } from './liveIdentityOffer'
import type { Contact } from '@renderer/features/contacts/types'
import type { LiveIdentityHeld } from './useLiveCall'

/** What the rep chose, kept until there is a call record to write it to. */
export type PendingDecision =
  { kind: 'link'; contactId: string; contactName: string } | { kind: 'create'; name: string }

/** The two IPC calls the decision needs, named so a test can supply them.
 *  There is no renderHook in this repo, so the part worth testing — the
 *  writes — is a plain function and the hook is the thin part around it. */
export interface IdentityWriteApi {
  setContact: (callId: string, contactId: string) => Promise<unknown>
  createContact: (input: { name: string }) => Promise<{ id: string } | null>
}

/**
 * Apply the rep's answer to a call that now EXISTS. Returns the contact id
 * linked, or null when there was nothing to do or it failed.
 *
 * Never throws. A failed link costs a click — the Call Detail page asks the
 * same question again — and must never interfere with the save it rides on.
 */
export async function applyIdentityDecision(
  decision: PendingDecision | null,
  callId: string,
  contacts: { id: string; name: string }[],
  api: IdentityWriteApi
): Promise<string | null> {
  if (!decision || !callId) return null
  try {
    if (decision.kind === 'link') {
      await api.setContact(callId, decision.contactId)
      return decision.contactId
    }
    // Same dedupe as the Call Detail page's createAndLinkIdentity: a name-only
    // signal has no email to dedupe by, so without this the same buyer heard
    // on two calls mints two contact records with no way to merge them later.
    const existing = contacts.find(
      (c) => c.name.trim().toLowerCase() === decision.name.trim().toLowerCase()
    )
    const contact = existing ?? (await api.createContact({ name: decision.name }))
    if (!contact) return null
    await api.setContact(callId, contact.id)
    return contact.id
  } catch {
    return null
  }
}

/**
 * Should a newly-heard spoken name wipe the answer currently held?
 *
 * Pulled out of the effect and exported so the rule can be TESTED rather than
 * pinned as source text. There is no render harness in this repo, so an
 * assertion that the effect contains a particular line is the best a test
 * could otherwise do — and the three cases below are exactly the ones that
 * have gone wrong once each:
 *
 *   - `null` name: `useLiveCues` nulls `buyerName` mid-call when the rep
 *     switches cues off. Resetting there wipes an answer already given and
 *     already confirmed on screen.
 *   - SAME name: the effect re-runs on every mount, and the held state now
 *     outlives the view — so without this, coming back from Pipeline resets
 *     the very answer hoisting the ref was meant to preserve.
 *   - DIFFERENT name: a new conversation. The old answer must not carry, or a
 *     later buyer inherits an earlier one's link.
 *
 * Mutates `held` and returns whether it did, so a caller can sync its render
 * state without duplicating the condition.
 */
export function resetHeldForNewName(
  held: { current: LiveIdentityHeld },
  spokenName: string | null
): boolean {
  if (!spokenName) return false
  // Exact comparison, deliberately, not case- or whitespace-insensitive: this
  // value comes from the model on one call and is only ever compared with
  // itself within that call, so the only way it can differ is that the model
  // said something different — which is a new answer to ask about.
  if (held.current.forName === spokenName) return false
  held.current = { decision: null, dismissed: false, forName: spokenName }
  return true
}

export interface UseLiveIdentityOffer {
  /** What to show, or null for "say nothing" — the answer on most calls. */
  offer: LiveIdentityOffer | null
  /** Set once the rep has accepted, so the chip can confirm it took. */
  acceptedName: string | null
  link: (contactId: string, contactName: string) => void
  create: (name: string) => void
  dismiss: () => void
  /**
   * Apply the held decision to a call that now exists. Call from the save
   * handler. Resolves to the linked contact id, or null when there was
   * nothing to do or it failed — the caller does not block on either.
   */
  applyToSavedCall: (callId: string) => Promise<string | null>
}

export function useLiveIdentityOffer(input: {
  spokenName: string | null
  linkedContactId: string | null | undefined
  contacts: Contact[]
  enabled: boolean
  /** Where the rep's answer LIVES. Pass `liveCall.liveIdentity` so it survives
   *  this view unmounting and remounting. Omitted, it falls back to a
   *  view-lifetime ref and the pre-fix behaviour. */
  held?: { current: LiveIdentityHeld }
}): UseLiveIdentityOffer {
  const { spokenName, linkedContactId, contacts, enabled } = input
  const fallback = useRef<LiveIdentityHeld>({
    decision: null,
    dismissed: false,
    forName: null
  })
  const held = input.held ?? fallback

  // React state mirrors the ref only so the chip re-renders; the REF is the
  // truth, and it is what a remount reads back. Initialised FROM the ref, so
  // coming back to the Live screen mid-call shows "Linked to Kerry when this
  // call saves" rather than asking again.
  const [dismissed, setDismissed] = useState(held.current.dismissed)
  const [acceptedName, setAcceptedName] = useState<string | null>(() => {
    const d = held.current.decision
    return d ? (d.kind === 'link' ? d.contactName : d.name) : null
  })

  // A new name means a new conversation's worth of question, so a dismissal
  // or an acceptance from the previous one must not silence it. Keyed on the
  // name rather than on the call, because `buyerName` is itself one-shot per
  // call in useLiveCues — when it changes, the call changed.
  //
  // BUT ONLY ON A NON-NULL NAME, and that guard is the whole point.
  // `useLiveCues` nulls `buyerName` on its own reset (useLiveCues.ts, the
  // `shouldReset` branch — reachable mid-call when the rep switches cues off).
  // Resetting on that transition would clear a decision the rep has already
  // made and the chip has already confirmed with "Linked to Kerry when this
  // call saves", and `applyToSavedCall` would then find nothing to apply:
  // precisely the silent no-op this design exists to prevent, arrived at from
  // the other end. `applyToSavedCall` clears the ref when it consumes it, so
  // nothing here needs to clear it on the way out.
  //
  // AND ONLY ON A *DIFFERENT* NAME, which is new with the hoisted ref. The
  // effect re-runs on every mount, so without `forName` a remount mid-call
  // would reset the very answer this change exists to preserve — the bug
  // moved rather than fixed.
  useEffect(() => {
    if (!resetHeldForNewName(held, spokenName)) return
    setDismissed(false)
    setAcceptedName(null)
  }, [spokenName, held])

  const offer = useMemo(
    () =>
      enabled && !dismissed ? liveIdentityOffer({ spokenName, linkedContactId, contacts }) : null,
    [enabled, dismissed, spokenName, linkedContactId, contacts]
  )

  const link = useCallback(
    (contactId: string, contactName: string) => {
      held.current.decision = { kind: 'link', contactId, contactName }
      setAcceptedName(contactName)
    },
    [held]
  )

  const create = useCallback(
    (name: string) => {
      held.current.decision = { kind: 'create', name }
      setAcceptedName(name)
    },
    [held]
  )

  const dismiss = useCallback(() => {
    held.current.decision = null
    held.current.dismissed = true
    setDismissed(true)
    setAcceptedName(null)
  }, [held])

  const applyToSavedCall = useCallback(
    async (callId: string): Promise<string | null> => {
      const decision = held.current.decision
      // Cleared BEFORE the awaits: a second save of the same conversation (a
      // recovery, a retry) must not re-apply a decision that already landed or
      // already failed. The rep answered once.
      held.current.decision = null
      return applyIdentityDecision(decision, callId, contacts, {
        setContact: (id, contactId) => window.api.calls.setContact(id, contactId),
        createContact: (input) => window.api.contacts.create(input)
      })
    },
    [contacts, held]
  )

  return { offer, acceptedName, link, create, dismiss, applyToSavedCall }
}
