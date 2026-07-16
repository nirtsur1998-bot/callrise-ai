import { CalendarClock, X, Link2, UserPlus } from 'lucide-react'
import { Button } from '@renderer/components/Button'
import { IconButton } from '@renderer/components/IconButton'
import type { CalendarMatch } from './calendarMatch'
import type { Contact } from './types'

const MAX_SHOWN = 3

function formatEventTime(startIso: string): string {
  return new Date(startIso).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

interface CalendarMatchSuggestionProps {
  matches: CalendarMatch[]
  contacts: Contact[]
  onLink: (contactId: string) => void
  onCreateAndLink: (attendee: CalendarMatch['attendee']) => void
  onDismiss: () => void
}

/** A confirm-first suggestion: "this call matches your calendar event X with
 *  Y — link them?" Never auto-links; the rep always taps to confirm. */
export function CalendarMatchSuggestion({
  matches,
  contacts,
  onLink,
  onCreateAndLink,
  onDismiss
}: CalendarMatchSuggestionProps): React.JSX.Element | null {
  if (matches.length === 0) return null
  const shown = matches.slice(0, MAX_SHOWN)

  return (
    <div className="rounded-xl border border-accent/30 bg-accent-soft/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <div>
            <p className="text-[13px] font-medium text-ink">
              This call happened around the same time as a calendar event
              {shown.length === 1 ? '' : 's'} you were invited to.
            </p>
            <p className="mt-0.5 text-[12px] text-muted">
              Matched by time, not by what was said — confirm before linking.
            </p>
          </div>
        </div>
        <IconButton icon={X} label="Not now" onClick={onDismiss} />
      </div>

      <ul className="mt-3 space-y-2">
        {shown.map(({ event, attendee }) => {
          const existing = contacts.find((c) => c.email?.toLowerCase() === attendee.email)
          return (
            <li
              key={`${event.id}-${attendee.email}`}
              className="flex items-center justify-between gap-3 rounded-lg border border-line-soft bg-canvas px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium text-ink">
                  {attendee.name || attendee.email}
                </p>
                <p className="truncate text-[11px] text-faint">
                  {event.title} · {formatEventTime(event.start)}
                </p>
              </div>
              {existing ? (
                <Button
                  size="sm"
                  icon={Link2}
                  onClick={() => onLink(existing.id)}
                  className="shrink-0"
                >
                  Link to {existing.name}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={UserPlus}
                  onClick={() => onCreateAndLink(attendee)}
                  className="shrink-0"
                >
                  Add as contact
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

interface AutoLinkedNoticeProps {
  contactName: string
  onUndo: () => void
}

/** Shown instead of the manual banner when Settings → CRM's "auto-link
 *  unambiguous matches" already linked this call — non-blocking, undoable
 *  (never a silent/irreversible action, per the "always confirm" spirit). */
export function AutoLinkedNotice({
  contactName,
  onUndo
}: AutoLinkedNoticeProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-positive/30 bg-positive-soft px-4 py-3">
      <div className="flex items-center gap-2.5">
        <Link2 className="h-4 w-4 shrink-0 text-positive" />
        <p className="text-[13px] text-ink">
          Automatically linked to <span className="font-medium">{contactName}</span> — matched by
          calendar time.
        </p>
      </div>
      <Button variant="secondary" size="sm" onClick={onUndo} className="shrink-0">
        Undo
      </Button>
    </div>
  )
}
