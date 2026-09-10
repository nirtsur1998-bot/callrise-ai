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
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { liveIdentityOffer, type LiveIdentityOffer } from './liveIdentityOffer'
import type { Contact } from '@renderer/features/contacts/types'

/** What the rep chose, kept until there is a call record to write it to. */
export type PendingDecision =
  | { kind: 'link'; contactId: string; contactName: string }
  | { kind: 'create'; name: string }

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
}): UseLiveIdentityOffer {
  const { spokenName, linkedContactId, contacts, enabled } = input
  const [dismissed, setDismissed] = useState(false)
  const [acceptedName, setAcceptedName] = useState<string | null>(null)
  const pendingRef = useRef<PendingDecision | null>(null)

  // A new name means a new conversation's worth of question, so a dismissal
  // or an acceptance from the previous one must not silence it. Keyed on the
  // name rather than on the call, because `buyerName` is itself one-shot per
  // call in useLiveCues — when it changes, the call changed.
  useEffect(() => {
    setDismissed(false)
    setAcceptedName(null)
    pendingRef.current = null
  }, [spokenName])

  const offer = useMemo(
    () =>
      enabled && !dismissed
        ? liveIdentityOffer({ spokenName, linkedContactId, contacts })
        : null,
    [enabled, dismissed, spokenName, linkedContactId, contacts]
  )

  const link = useCallback((contactId: string, contactName: string) => {
    pendingRef.current = { kind: 'link', contactId, contactName }
    setAcceptedName(contactName)
  }, [])

  const create = useCallback((name: string) => {
    pendingRef.current = { kind: 'create', name }
    setAcceptedName(name)
  }, [])

  const dismiss = useCallback(() => {
    setDismissed(true)
    pendingRef.current = null
    setAcceptedName(null)
  }, [])

  const applyToSavedCall = useCallback(
    async (callId: string): Promise<string | null> => {
      const decision = pendingRef.current
      // Cleared BEFORE the awaits: a second save of the same conversation (a
      // recovery, a retry) must not re-apply a decision that already landed or
      // already failed. The rep answered once.
      pendingRef.current = null
      return applyIdentityDecision(decision, callId, contacts, {
        setContact: (id, contactId) => window.api.calls.setContact(id, contactId),
        createContact: (input) => window.api.contacts.create(input)
      })
    },
    [contacts]
  )

  return { offer, acceptedName, link, create, dismiss, applyToSavedCall }
}
