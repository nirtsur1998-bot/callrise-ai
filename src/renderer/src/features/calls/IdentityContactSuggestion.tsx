import { Sparkles, X, Link2, UserPlus } from 'lucide-react'
import { Button } from '@renderer/components/Button'
import { IconButton } from '@renderer/components/IconButton'

interface IdentityContactSuggestionProps {
  name: string
  /** Set when the resolved identity is already linked to a KNOWN contact
   *  (source:'contact' in the resolution cascade) — offer to link that
   *  contact directly rather than create a duplicate. */
  existingContactName?: string
  onLink: () => void
  onCreate: () => void
  onDismiss: () => void
  busy?: boolean
}

/** Shown on the Call Detail page when a name was resolved for the other
 *  party (calendar/contact-record/self-intro) but the call itself has no
 *  linked contact yet — and no calendar-match suggestion is already
 *  showing (that one takes priority, since it also carries an email).
 *  Never auto-links/auto-creates; the rep always confirms. M23 Workstream D. */
export function IdentityContactSuggestion({
  name,
  existingContactName,
  onLink,
  onCreate,
  onDismiss,
  busy
}: IdentityContactSuggestionProps): React.JSX.Element {
  return (
    <div className="rounded-xl border border-accent/30 bg-accent-soft/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <div>
            <p className="text-[13px] font-medium text-ink">
              Detected <span className="font-semibold">{name}</span> on this call — no contact linked yet.
            </p>
            <p className="mt-0.5 text-[12px] text-muted">
              {existingContactName
                ? `Matches your existing contact ${existingContactName}.`
                : 'Confirm before creating a contact.'}
            </p>
          </div>
        </div>
        <IconButton icon={X} label="Not now" onClick={onDismiss} />
      </div>
      <div className="mt-3 flex justify-end">
        {existingContactName ? (
          <Button size="sm" icon={Link2} onClick={onLink} disabled={busy}>
            Link to {existingContactName}
          </Button>
        ) : (
          <Button size="sm" variant="secondary" icon={UserPlus} onClick={onCreate} disabled={busy}>
            Create contact for {name}
          </Button>
        )}
      </div>
    </div>
  )
}
