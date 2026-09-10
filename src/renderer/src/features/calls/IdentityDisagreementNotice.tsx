import { AlertTriangle, X, Link2, UserPlus, Users } from 'lucide-react'
import { Button } from '@renderer/components/Button'
import { IconButton } from '@renderer/components/IconButton'
import type { IdentityDisagreement } from './identityDisagreement'

interface IdentityDisagreementNoticeProps {
  disagreement: IdentityDisagreement
  onLink: (contactId: string) => void
  onCreate: () => void
  onDismiss: () => void
  busy?: boolean
}

/**
 * M39 — shown when the call IS linked to a contact and the other party
 * introduced themselves as somebody else.
 *
 * Sibling of IdentityContactSuggestion, which handles the opposite case (a name
 * and NO link). Deliberately the same vocabulary — "Detected X on this call",
 * "Link to Y", "Create contact for X", dismiss as "Not now" — because it is the
 * same action in a different state, and a second language for one action is two
 * features for the rep to learn instead of one.
 *
 * The difference is the tone: this one is not a suggestion, it is a
 * contradiction, so it says what BOTH claims are and lets the existing link
 * stand as the default. The rep may well be right and the transcript wrong.
 *
 * MEASURED before it was built: 6 of the founder's 297 calls. The surface earns
 * its place by being rare — see identityDisagreement.ts for why the leniency
 * rule matters more here than the matcher's strictness does.
 */
export function IdentityDisagreementNotice({
  disagreement,
  onLink,
  onCreate,
  onDismiss,
  busy
}: IdentityDisagreementNoticeProps): React.JSX.Element {
  const { spokenName, linkedContact, suggestion } = disagreement
  return (
    // `warning`, NOT `warn`. The token is `--color-warning`; `text-warn` and
    // `bg-warn-soft` generate no CSS at all and fail silently, which is what
    // InterruptedCallPrompt.tsx has shipped with (see BUG-268). Checked against
    // the BUILT stylesheet, not the source: `.text-warning` appears 5 times in
    // out/renderer/assets/*.css and `.text-warn{` appears zero.
    <div className="rounded-xl border border-warning/30 bg-warning-soft/30 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div>
            <p className="text-[13px] font-medium text-ink">
              Detected <span className="font-semibold">{spokenName}</span> on this call — but it&rsquo;s
              linked to <span className="font-semibold">{linkedContact.name}</span>.
            </p>
            <p className="mt-0.5 text-[12px] text-muted">
              {suggestion.kind === 'link'
                ? `They introduced themselves by name. Link to ${suggestion.contact.name} instead?`
                : suggestion.kind === 'create'
                  ? `They introduced themselves by name, and ${spokenName} isn't in your contacts yet.`
                  : `They introduced themselves by name, and ${suggestion.candidates.length} of your contacts are called that — pick the right one below.`}
            </p>
          </div>
        </div>
        <IconButton icon={X} label="Not now" onClick={onDismiss} />
      </div>
      <div className="mt-3 flex justify-end gap-2">
        {suggestion.kind === 'link' && (
          <Button
            size="sm"
            icon={Link2}
            onClick={() => onLink(suggestion.contact.id)}
            disabled={busy}
          >
            Link to {suggestion.contact.name}
          </Button>
        )}
        {suggestion.kind === 'create' && (
          <Button size="sm" variant="secondary" icon={UserPlus} onClick={onCreate} disabled={busy}>
            Create contact for {spokenName}
          </Button>
        )}
        {suggestion.kind === 'ambiguous' && (
          // No default button. Picking one of several identically-named
          // contacts is the rep's call — offering one would be right about a
          // third of the time and silently wrong the rest, which is the exact
          // failure the matcher refuses to make.
          <span className="flex items-center gap-1.5 text-[12px] text-muted">
            <Users className="h-3.5 w-3.5" />
            Use &ldquo;Link a contact&rdquo; below to choose
          </span>
        )}
      </div>
    </div>
  )
}
