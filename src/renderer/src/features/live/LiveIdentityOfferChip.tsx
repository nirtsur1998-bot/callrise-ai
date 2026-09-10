import { AlertTriangle, Check, Link2, Sparkles, UserPlus, Users, X } from 'lucide-react'
import { Button } from '@renderer/components/Button'
import { IconButton } from '@renderer/components/IconButton'
import type { LiveIdentityOffer } from './liveIdentityOffer'

interface LiveIdentityOfferChipProps {
  offer: LiveIdentityOffer
  /** Set once the rep has accepted, so the chip can say it took. Mid-call
   *  there is no call record to read the answer back from — see `accepted`
   *  in LiveView for where the decision is actually held until the save. */
  acceptedName?: string | null
  onLink: (contactId: string, contactName: string) => void
  onCreate: (name: string) => void
  onDismiss: () => void
  busy?: boolean
}

/**
 * M39 Stage 2 — the live half of the identity offer.
 *
 * THE VOCABULARY IS COPIED, NOT REINVENTED. Every string here already exists on
 * the Call Detail page, in IdentityContactSuggestion and
 * IdentityDisagreementNotice: "Detected X on this call — no contact linked
 * yet", "— but it's linked to Y", "Link to Y", "Create contact for X", "Not
 * now", and the refusal to pick between identically-named contacts. Same
 * sentence, same button order, same colours (accent for an offer, warning for
 * a contradiction), same three outcomes. A rep who has dismissed one of these
 * after a call already knows what this is.
 *
 * WHAT IS DIFFERENT IS THE SIZE AND THE STAKES. This appears next to a live
 * transcript while someone is talking, so it is one line of statement and one
 * row of buttons, and it never takes focus or covers anything. And it can be
 * WRONG in a way the post-call version cannot be expensive about: the founder's
 * rule for a surface that flags an existing answer is "two false flags and I
 * stop reading it". So the existing link always stays the default — no button
 * is pre-selected, dismiss is always one click, and the ambiguous case offers
 * nothing at all rather than guessing between contacts who share a name.
 *
 * ACCEPTANCE IS DEFERRED, VISIBLY. There is no call record on disk during a
 * call, so "Link to Kerry" cannot write a link the way the post-call button
 * does — it records the rep's decision and LiveView applies it the moment the
 * call saves. The chip therefore has to say so itself, which is what the
 * accepted state below is: "Linked to Kerry when this call saves." A control
 * that silently does nothing until later is indistinguishable from one that
 * failed.
 */
export function LiveIdentityOfferChip({
  offer,
  acceptedName,
  onLink,
  onCreate,
  onDismiss,
  busy
}: LiveIdentityOfferChipProps): React.JSX.Element {
  const isDisagreement = offer.kind === 'disagreement'
  const suggestion = isDisagreement ? offer.disagreement.suggestion : offer.suggestion
  const spokenName = offer.spokenName

  const tone = isDisagreement
    ? { ring: 'border-warning/30 bg-warning-soft/30', icon: 'text-warning' }
    : { ring: 'border-accent/30 bg-accent-soft/40', icon: 'text-accent' }

  if (acceptedName) {
    return (
      <div className={`rounded-xl border ${tone.ring} px-3 py-2.5`}>
        {/* The sentence is ONE flex child, not three. With the text bare, the
            row's `gap-2` applied between every run — so an 8px gap opened on
            both sides of the bold name and the line read "Linked to  Harvey
            when this call saves." Invisible in the source, obvious in a
            screenshot, which is the only reason it was found. */}
        <p className="flex items-center gap-2 text-[12px] font-medium text-ink">
          <Check className="h-3.5 w-3.5 shrink-0 text-positive" />
          <span>
            Linked to <span className="font-semibold">{acceptedName}</span> when this call saves.
          </span>
        </p>
      </div>
    )
  }

  return (
    <div className={`rounded-xl border ${tone.ring} px-3 py-2.5`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          {isDisagreement ? (
            <AlertTriangle className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${tone.icon}`} />
          ) : (
            <Sparkles className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${tone.icon}`} />
          )}
          <div className="min-w-0">
            <p className="text-[12px] font-medium leading-snug text-ink">
              Detected <span className="font-semibold">{spokenName}</span> on this call —{' '}
              {isDisagreement ? (
                <>
                  but it&rsquo;s linked to{' '}
                  <span className="font-semibold">{offer.disagreement.linkedContact.name}</span>.
                </>
              ) : (
                <>no contact linked yet.</>
              )}
            </p>
            <p className="mt-0.5 text-[11px] leading-snug text-muted">
              {suggestion.kind === 'link'
                ? `Matches your existing contact ${suggestion.contact.name}.`
                : suggestion.kind === 'create'
                  ? 'Confirm before creating a contact.'
                  : `${suggestion.candidates.length} of your contacts are called that — pick the right one after the call.`}
            </p>
          </div>
        </div>
        <IconButton icon={X} label="Not now" onClick={onDismiss} />
      </div>
      <div className="mt-2 flex justify-end">
        {suggestion.kind === 'link' && (
          <Button
            size="sm"
            icon={Link2}
            disabled={busy}
            onClick={() => onLink(suggestion.contact.id, suggestion.contact.name)}
          >
            Link to {suggestion.contact.name}
          </Button>
        )}
        {suggestion.kind === 'create' && (
          <Button
            size="sm"
            variant="secondary"
            icon={UserPlus}
            disabled={busy}
            onClick={() => onCreate(spokenName)}
          >
            Create contact for {spokenName}
          </Button>
        )}
        {suggestion.kind === 'ambiguous' && (
          // No default button, exactly as on the Call Detail page. Picking one
          // of several identically-named contacts is the rep's call; offering
          // one would be right about a third of the time and silently wrong
          // the rest — and mid-call they cannot check.
          <span className="flex items-center gap-1.5 text-[11px] text-muted">
            <Users className="h-3 w-3" />
            Choose after the call
          </span>
        )}
      </div>
    </div>
  )
}
