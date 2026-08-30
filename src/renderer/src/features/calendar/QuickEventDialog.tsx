import { useMemo, useState } from 'react'
import { X, CalendarPlus, Settings2 } from 'lucide-react'
import { format } from 'date-fns'
import { Modal } from '@renderer/components/Modal'
import { IconButton } from '@renderer/components/IconButton'
import { Button } from '@renderer/components/Button'
import { fieldClass } from '@renderer/components/field'
import { parseEventText } from './naturalLanguageDate'
import type { EventDraft } from './types'

interface QuickEventDialogProps {
  /** When opened from an empty grid slot, the time that slot represents —
   *  used as the parse's reference point AND as the fallback when the typed
   *  text has no date in it at all, so clicking 3pm Thursday and typing just
   *  a title lands at 3pm Thursday, not "now". */
  slotStart?: Date
  onClose: () => void
  onCreate: (draft: EventDraft) => Promise<void>
  /** Hand the parsed-so-far draft to the full event dialog (notes, contact,
   *  deal, reminders) — nothing typed is lost when the user wants more.
   *
   *  OPTIONAL, and omitted on purpose by callers that have no full editor to
   *  hand off to (the ⌘K palette lives outside CalendarView, which owns the
   *  editor and its create/update plumbing). An earlier build offered the
   *  button there anyway and simply navigated to the Calendar — which threw
   *  away everything the user had typed. A button that says "more options"
   *  must not be a button that means "start again", so where the handoff
   *  can't carry the draft, the button isn't shown at all. */
  onMoreOptions?: (draft: EventDraft) => void
}

function toDraft(title: string, start: Date, end: Date): EventDraft {
  return {
    title,
    allDay: false,
    startDate: format(start, 'yyyy-MM-dd'),
    endDate: format(end, 'yyyy-MM-dd'),
    startTime: format(start, 'HH:mm'),
    endTime: format(end, 'HH:mm'),
    notes: '',
    reminderMinutes: []
  }
}

/** M31 calendar-research Slice A — the compact create surface, matching the
 *  Google/Outlook convention of click-empty-slot → small card (title + time)
 *  with "More options" for the full editor, rather than throwing the whole
 *  modal at someone adding a 30-minute call.
 *
 *  The live preview line under the field is deliberately non-negotiable (see
 *  docs/M31-calendar-research.md §2.3): Fantastical's long-running complaint
 *  threads are all about a parser silently eating title words or re-dating
 *  an event, and the fix is simply SHOWING the interpretation before it's
 *  saved. Parsing stays date/time-only for the same reason — a sales contact
 *  list is full of names like "April" and "May". */
export function QuickEventDialog({
  slotStart,
  onClose,
  onCreate,
  onMoreOptions
}: QuickEventDialogProps): React.JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parsed = useMemo(() => parseEventText(text, slotStart ?? new Date()), [text, slotStart])

  // With no date typed, an empty-slot open keeps the slot's own time rather
  // than jumping to "now" — the click already expressed a time.
  const start = !parsed.matched && slotStart ? slotStart : parsed.start
  const end = !parsed.matched && slotStart ? new Date(slotStart.getTime() + 30 * 60_000) : parsed.end
  const previewLine =
    !parsed.matched && slotStart
      ? `${format(start, 'EEE, MMM d')}, ${format(start, 'h:mm a')}–${format(end, 'h:mm a')}`
      : parsed.preview

  const canSave = text.trim().length > 0 && !busy

  const submit = async (): Promise<void> => {
    if (!canSave) return
    setBusy(true)
    setError(null)
    try {
      await onCreate(toDraft(parsed.title || text.trim(), start, end))
    } catch {
      setBusy(false)
      setError('Could not save the event. Please try again.')
    }
  }

  return (
    <Modal onClose={busy ? () => {} : onClose} title="New event" initialFocus={false}>
      <div className="flex items-center justify-between gap-4 border-b border-line-soft px-6 py-4">
        <h2 className="text-sm font-semibold">New event</h2>
        <IconButton icon={X} label="Close" onClick={onClose} disabled={busy} />
      </div>

      <div className="px-6 py-5">
        <input
          type="text"
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canSave) {
              e.preventDefault()
              void submit()
            }
          }}
          placeholder="Call Ben Tuesday at 2pm"
          className={fieldClass}
        />
        {/* The trust mechanism: what the parser understood, before saving. */}
        <p className="mt-2 flex items-center gap-1.5 text-[12px] text-muted">
          <CalendarPlus className="h-3.5 w-3.5 shrink-0 text-faint" />
          {text.trim() ? previewLine : 'Type a title — add a day and time in plain words.'}
        </p>
        {parsed.title && parsed.matched && (
          <p className="mt-1 text-[11px] text-faint">Title: &ldquo;{parsed.title}&rdquo;</p>
        )}
        {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-line-soft px-6 py-4">
        {onMoreOptions ? (
          <Button
            variant="secondary"
            size="sm"
            icon={Settings2}
            disabled={busy}
            onClick={() => onMoreOptions(toDraft(parsed.title || text.trim(), start, end))}
          >
            More options
          </Button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canSave}>
            {busy ? 'Saving…' : 'Add event'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
