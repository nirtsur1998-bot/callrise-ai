import { Sparkles, X, Link2, UserPlus, Users } from 'lucide-react'
import { Button } from '@renderer/components/Button'
import { IconButton } from '@renderer/components/IconButton'
import type { IdentityDisagreement } from './identityDisagreement'

/** The same three-way answer the live chip and the disagreement notice use.
 *  One shape for "which contact is this name?" across all three surfaces. */
export type IdentitySuggestion = IdentityDisagreement['suggestion']

interface IdentityContactSuggestionProps {
  name: string
  /** Set when the resolved identity is already linked to a KNOWN contact
   *  (source:'contact' in the resolution cascade) — offer to link that
   *  contact directly rather than create a duplicate. Takes priority over
   *  `suggestion`, because a record is stronger evidence than a name. */
  existingContactName?: string
  /** BUG-273 — what the name lookup found among the rep's contacts. Absent
   *  (older callers) behaves as 'create', which is what this component always
   *  did; that default is the bug, so every current caller passes it. */
  suggestion?: IdentitySuggestion
  /** One line that tells two same-named candidates apart ("5 calls · last
   *  3d ago"). Only read for the ambiguous case. */
  describe?: (contact: { id: string; name: string }) => string | undefined
  onLink: () => void
  /** Link one of several same-named candidates — the ambiguous case. */
  onLinkCandidate?: (contactId: string) => void
  onCreate: () => void
  onDismiss: () => void
  busy?: boolean
}

/** Shown on the Call Detail page when a name was resolved for the other
 *  party (calendar/contact-record/self-intro) but the call itself has no
 *  linked contact yet — and no calendar-match suggestion is already
 *  showing (that one takes priority, since it also carries an email).
 *  Never auto-links/auto-creates; the rep always confirms. M23 Workstream D.
 *
 *  BUG-273 — it used to offer "Create contact for X" whenever the identity had
 *  not come from a contact RECORD, without ever looking X up by NAME. With two
 *  live contacts both called "Harvey" it offered a third. The ambiguous case is
 *  now rendered as the candidate list it is, in the live chip's own words
 *  ("N of your contacts are called that"), with a distinguisher per row —
 *  two rows both reading "Harvey" would be the same failure moved down a line. */
export function IdentityContactSuggestion({
  name,
  existingContactName,
  suggestion,
  describe,
  onLink,
  onLinkCandidate,
  onCreate,
  onDismiss,
  busy
}: IdentityContactSuggestionProps): React.JSX.Element {
  // The record match wins; otherwise the name lookup; otherwise create.
  const mode: 'record' | IdentitySuggestion['kind'] = existingContactName
    ? 'record'
    : (suggestion?.kind ?? 'create')
  const candidates = suggestion?.kind === 'ambiguous' ? suggestion.candidates : []

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
              {mode === 'record'
                ? `Matches your existing contact ${existingContactName}.`
                : mode === 'link' && suggestion?.kind === 'link'
                  ? `Matches your existing contact ${suggestion.contact.name}.`
                  : mode === 'ambiguous'
                    ? `${candidates.length} of your contacts are called that — pick the right one.`
                    : 'Confirm before creating a contact.'}
            </p>
          </div>
        </div>
        <IconButton icon={X} label="Not now" onClick={onDismiss} />
      </div>
      {mode === 'ambiguous' ? (
        // No default button. Picking one of several identically-named
        // contacts is the rep's call — offering one would be right about a
        // third of the time and silently wrong the rest, which is the exact
        // failure the matcher refuses to make. Every candidate, each with the
        // one line that separates it from its namesakes.
        <div className="mt-3 flex flex-col gap-1.5">
          {candidates.map((c) => {
            const detail = describe?.(c)
            return (
              <Button
                key={c.id}
                size="sm"
                variant="secondary"
                icon={Users}
                onClick={() => onLinkCandidate?.(c.id)}
                disabled={busy}
                className="justify-start"
              >
                Link to {c.name}
                {detail && <span className="ml-2 text-[11px] font-normal text-muted">{detail}</span>}
              </Button>
            )
          })}
        </div>
      ) : (
        <div className="mt-3 flex justify-end">
          {mode === 'record' ? (
            <Button size="sm" icon={Link2} onClick={onLink} disabled={busy}>
              Link to {existingContactName}
            </Button>
          ) : mode === 'link' && suggestion?.kind === 'link' ? (
            <Button
              size="sm"
              icon={Link2}
              onClick={() => onLinkCandidate?.(suggestion.contact.id)}
              disabled={busy}
            >
              Link to {suggestion.contact.name}
            </Button>
          ) : (
            <Button size="sm" variant="secondary" icon={UserPlus} onClick={onCreate} disabled={busy}>
              Create contact for {name}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
