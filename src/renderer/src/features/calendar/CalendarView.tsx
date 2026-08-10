import { useEffect, useMemo, useState } from 'react'
import {
  format,
  startOfWeek,
  addDays,
  addMonths,
  subMonths,
  addWeeks,
  subWeeks,
  isSameMonth,
  getHours
} from 'date-fns'
import { ChevronLeft, ChevronRight, Plus, CalendarDays } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { Skeleton } from '@renderer/components/Skeleton'
import { SegmentedControl } from '@renderer/components/SegmentedControl'
import { useCalendar } from './useCalendar'
import { GoogleConnect } from '@renderer/features/google/GoogleConnect'
import { OutlookConnect } from '@renderer/features/outlook/OutlookConnect'
import { MonthGrid } from './MonthGrid'
import { WeekGrid } from './WeekGrid'
import { EventDialog } from './EventDialog'
import { PrepBriefModal, type PrepBriefMeeting } from '@renderer/features/prep-brief/PrepBriefModal'
import {
  buildItems,
  draftToInput,
  draftFromEvent,
  newDraft,
  ITEM_STYLES,
  KIND_LABEL
} from './items'
import type { CalendarEvent, CalendarItemKind, EventDraft } from './types'

function meetingFromEvent(event: CalendarEvent): PrepBriefMeeting {
  return {
    eventId: event.id,
    title: event.title,
    startIso: event.start,
    attendees: event.attendees ?? [],
    contactId: event.contactId,
    dealId: event.dealId
  }
}

type View = 'month' | 'week'

interface DialogState {
  mode: 'new' | 'edit'
  draft: EventDraft
  eventId?: string
  /** The source event being edited — used to route Google/Outlook events to adopt. */
  event?: CalendarEvent
}

function rangeTitle(cursor: Date, view: View): string {
  if (view === 'month') return format(cursor, 'MMMM yyyy')
  const start = startOfWeek(cursor, { weekStartsOn: 0 })
  const end = addDays(start, 6)
  return isSameMonth(start, end)
    ? `${format(start, 'MMM d')} – ${format(end, 'd, yyyy')}`
    : `${format(start, 'MMM d')} – ${format(end, 'MMM d, yyyy')}`
}

interface CalendarViewProps {
  /** A callrise://meeting/<eventId> deep link's target — one-shot, same
   *  preselect pattern as PastCallsView's initialSelectedId. Cleared via
   *  onDeepLinkConsumed once handled (found or not) so a later manual visit
   *  to Calendar doesn't keep reopening a stale link. */
  deepLinkEventId?: string | null
  onDeepLinkConsumed?: () => void
}

export function CalendarView({
  deepLinkEventId,
  onDeepLinkConsumed
}: CalendarViewProps = {}): React.JSX.Element {
  const {
    events,
    tasks,
    calls,
    googleEvents,
    googleSyncing,
    googleLastSynced,
    loading,
    googleWritable,
    outlookEvents,
    outlookSyncing,
    outlookLastSynced,
    outlookWritable,
    createEvent,
    updateEvent,
    deleteEvent,
    adoptEvent,
    deleteExternalEvent,
    refreshGoogle,
    refreshOutlook
  } = useCalendar()
  const [view, setView] = useState<View>('month')
  const [cursor, setCursor] = useState<Date>(() => new Date())
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [prepBriefMeeting, setPrepBriefMeeting] = useState<PrepBriefMeeting | null>(null)

  // Resolve a deep-linked eventId against whichever of the three sources
  // actually has it — the merged useCalendar() collections are already the
  // one place that knows how to reconcile local/Google/Outlook ids.
  useEffect(() => {
    if (!deepLinkEventId) return
    const match = [...events, ...googleEvents, ...outlookEvents].find((e) => e.id === deepLinkEventId)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- responding to a deep link arriving, not deriving from render
    if (match) setPrepBriefMeeting(meetingFromEvent(match))
    onDeepLinkConsumed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the id should retrigger this, not every events-array identity change
  }, [deepLinkEventId])

  const items = useMemo(
    () =>
      buildItems(
        events,
        tasks,
        calls,
        googleEvents,
        googleWritable,
        outlookEvents,
        outlookWritable
      ),
    [events, tasks, calls, googleEvents, googleWritable, outlookEvents, outlookWritable]
  )

  const goPrev = (): void => setCursor((c) => (view === 'month' ? subMonths(c, 1) : subWeeks(c, 1)))
  const goNext = (): void => setCursor((c) => (view === 'month' ? addMonths(c, 1) : addWeeks(c, 1)))

  const openNew = (day: Date, hour?: number): void =>
    setDialog({ mode: 'new', draft: newDraft(day, hour) })
  const openEdit = (event: CalendarEvent): void =>
    setDialog({ mode: 'edit', draft: draftFromEvent(event), eventId: event.id, event })
  const zoomDay = (day: Date): void => {
    setCursor(day)
    setView('week')
  }

  const submitDialog = async (draft: EventDraft): Promise<void> => {
    if (!dialog) return
    const input = draftToInput(draft)
    // A Google/Outlook-origin event is adopted (a linked local copy) so the
    // edit PATCHes the same remote event; local events edit/create normally.
    if (dialog.event?.source === 'google' || dialog.event?.source === 'outlook')
      await adoptEvent(dialog.event, input)
    else if (dialog.mode === 'edit' && dialog.eventId) await updateEvent(dialog.eventId, input)
    else await createEvent(input)
    setDialog(null)
  }

  const deleteDialog = async (): Promise<void> => {
    if (dialog?.event?.source === 'google' || dialog?.event?.source === 'outlook')
      await deleteExternalEvent(dialog.event)
    else if (dialog?.eventId) await deleteEvent(dialog.eventId)
    setDialog(null)
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="min-w-[9rem] text-lg font-semibold tracking-tight">
            {rangeTitle(cursor, view)}
          </h2>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={goPrev}
              title="Previous"
              aria-label={view === 'month' ? 'Previous month' : 'Previous week'}
              className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-elevated hover:text-ink"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setCursor(new Date())}
              className="rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-muted transition hover:bg-elevated hover:text-ink"
            >
              Today
            </button>
            <button
              type="button"
              onClick={goNext}
              title="Next"
              aria-label={view === 'month' ? 'Next month' : 'Next week'}
              className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-elevated hover:text-ink"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Legend />
          <SegmentedControl
            value={view}
            onChange={setView}
            options={[
              { id: 'month', label: 'Month' },
              { id: 'week', label: 'Week' }
            ]}
          />
          <button
            type="button"
            onClick={() => openNew(cursor, view === 'week' ? 9 : undefined)}
            className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white transition hover:brightness-110"
          >
            <Plus className="h-4 w-4" /> New event
          </button>
        </div>
      </header>

      {/* Google + Outlook Calendar connections, side-by-side */}
      <div className="mb-3 flex flex-wrap gap-3 [&>*]:!mb-0 [&>*]:min-w-[300px] [&>*]:flex-1">
        <GoogleConnect
          onChange={() => void refreshGoogle()}
          syncing={googleSyncing}
          lastSynced={googleLastSynced}
        />
        <OutlookConnect
          onChange={() => void refreshOutlook()}
          syncing={outlookSyncing}
          lastSynced={outlookLastSynced}
        />
      </div>

      {items.length === 0 && !loading && (
        <p className="mb-3 flex items-center gap-2 text-[13px] text-faint">
          <CalendarDays className="h-4 w-4" />
          Your calendar is empty — click any day to add an event. Your tasks and past calls show up
          here automatically too.
        </p>
      )}

      {/* Body */}
      <div className="min-h-0 flex-1">
        {loading ? (
          <div className="grid h-full grid-cols-7 gap-1.5">
            {Array.from({ length: 35 }).map((_, i) => (
              <Skeleton key={i} className="rounded-lg" />
            ))}
          </div>
        ) : view === 'month' ? (
          <MonthGrid
            cursor={cursor}
            items={items}
            onNewEvent={(day) => openNew(day)}
            onEditEvent={openEdit}
            onZoomDay={zoomDay}
          />
        ) : (
          <WeekGrid
            cursor={cursor}
            items={items}
            onNewEvent={(start) => openNew(start, getHours(start))}
            onEditEvent={openEdit}
          />
        )}
      </div>

      {dialog && (
        <EventDialog
          initial={dialog.draft}
          isEdit={dialog.mode === 'edit'}
          onClose={() => setDialog(null)}
          onSubmit={submitDialog}
          onDelete={dialog.mode === 'edit' ? deleteDialog : undefined}
          onOpenPrepBrief={
            dialog.event ? () => setPrepBriefMeeting(meetingFromEvent(dialog.event!)) : undefined
          }
          syncEnabled={googleWritable || outlookWritable}
        />
      )}

      {prepBriefMeeting && (
        <PrepBriefModal meeting={prepBriefMeeting} onClose={() => setPrepBriefMeeting(null)} />
      )}
    </div>
  )
}

function Legend(): React.JSX.Element {
  const kinds: CalendarItemKind[] = ['event', 'task', 'call', 'google', 'outlook']
  return (
    <div className="hidden items-center gap-3 text-[11px] text-faint sm:flex">
      {kinds.map((k) => (
        <span key={k} className="flex items-center gap-1.5">
          <span className={cn('h-2 w-2 rounded-full', ITEM_STYLES[k].dot)} />
          {k === 'google' || k === 'outlook' ? KIND_LABEL[k] : `${KIND_LABEL[k]}s`}
        </span>
      ))}
    </div>
  )
}
