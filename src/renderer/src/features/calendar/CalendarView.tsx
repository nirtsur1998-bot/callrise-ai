import { useEffect, useMemo, useState } from 'react'
import {
  format,
  startOfWeek,
  startOfMonth,
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
import { CalendarConnectBar } from './CalendarConnectBar'
import { QuickEventDialog } from './QuickEventDialog'
import { AgendaRail } from './AgendaRail'
import { buildChipContext } from './chipContext'
import { usePrepBriefStatuses } from './usePrepBriefStatuses'
import { useContacts } from '@renderer/features/contacts/useContacts'
import { useDeals } from '@renderer/features/deals/useDeals'
import { useDealStages } from '@renderer/features/deals/useDealStages'
import { useCalendarPreview } from './useCalendarPreview'
import { loadCalendarView, saveCalendarView } from './viewPreference'
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
  /** M31 Slice B — open the call that was recorded during a meeting. Optional
   *  so the calendar still works anywhere that can't navigate to a call. */
  onOpenCall?: (callId: string) => void
}

export function CalendarView({
  deepLinkEventId,
  onDeepLinkConsumed,
  onOpenCall
}: CalendarViewProps = {}): React.JSX.Element {
  const {
    events,
    tasks,
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
  // M31 Slice A — with the preview flag ON, the view defaults to Week and
  // remembers the last-used one (Google's own documented model: "after you
  // choose a new view, it becomes your default view until you change it").
  // With the flag OFF this is byte-for-byte today's behavior: hardcoded
  // 'month', nothing read from or written to localStorage. See
  // docs/M31-calendar-research.md §2.2 for why Week.
  const { enabled: calendarPreview } = useCalendarPreview()
  const [view, setViewState] = useState<View>(() => (calendarPreview ? loadCalendarView() : 'month'))
  const setView = (next: View): void => {
    setViewState(next)
    if (calendarPreview) saveCalendarView(next)
  }
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

  const baseItems = useMemo(
    () => buildItems(events, tasks, googleEvents, googleWritable, outlookEvents, outlookWritable),
    [events, tasks, googleEvents, googleWritable, outlookEvents, outlookWritable]
  )

  // M31 Slice B — the sales context on each chip: who the meeting is with,
  // the deal's stage, a risk marker, and whether a prep brief is actually
  // ready. Preview-flagged like the rest of Slice A/B; with the flag off
  // this costs nothing (no IPC, no context attached, chips render exactly
  // as before).
  const { contacts } = useContacts()
  const { deals } = useDeals()
  const { stages } = useDealStages()
  const briefStatuses = usePrepBriefStatuses(baseItems, calendarPreview)

  const items = useMemo(() => {
    if (!calendarPreview) return baseItems
    const sources = {
      contactById: new Map(contacts.map((c) => [c.id, c])),
      dealById: new Map(deals.map((d) => [d.id, d])),
      stageById: new Map(stages.map((s) => [s.id, s])),
      briefStatusByEventId: briefStatuses
    }
    return baseItems.map((item) => {
      const context = buildChipContext(item, sources)
      return context ? { ...item, context } : item
    })
  }, [baseItems, calendarPreview, contacts, deals, stages, briefStatuses])

  // The range the grid is actually showing. Derived from the SAME rules each
  // grid uses to lay itself out (month = the fixed 6-week window starting on
  // the week containing the 1st; week = the containing Sun–Sat), so the
  // agenda rail can never list a different span than the grid draws.
  const visibleRange = useMemo(() => {
    if (view === 'week') {
      const start = startOfWeek(cursor, { weekStartsOn: 0 })
      return { start, end: addDays(start, 6) }
    }
    const gridStart = startOfWeek(startOfMonth(cursor), { weekStartsOn: 0 })
    return { start: gridStart, end: addDays(gridStart, 41) }
  }, [cursor, view])

  const goPrev = (): void => setCursor((c) => (view === 'month' ? subMonths(c, 1) : subWeeks(c, 1)))
  const goNext = (): void => setCursor((c) => (view === 'month' ? addMonths(c, 1) : addWeeks(c, 1)))

  // Preview: an empty-slot click opens the compact quick-create card first
  // (Google/Outlook's own convention), with "More options" escalating to the
  // full dialog carrying whatever was already typed. Default: straight to
  // the full dialog, exactly as today.
  const [quickSlot, setQuickSlot] = useState<Date | null>(null)
  const openNew = (day: Date, hour?: number): void => {
    if (calendarPreview) {
      const slot = new Date(day)
      if (hour !== undefined) slot.setHours(hour, 0, 0, 0)
      setQuickSlot(slot)
      return
    }
    setDialog({ mode: 'new', draft: newDraft(day, hour) })
  }
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
    if (dialog.event?.source === 'google' || dialog.event?.source === 'outlook') {
      await adoptEvent(dialog.event, input)
      setDialog(null)
    } else if (dialog.mode === 'edit' && dialog.eventId) {
      // Only close on a confirmed write — a failed save (e.g. a locked file)
      // must not look identical to a successful one (BUG-024).
      if (await updateEvent(dialog.eventId, input)) setDialog(null)
    } else {
      await createEvent(input)
      setDialog(null)
    }
  }

  const deleteDialog = async (): Promise<void> => {
    if (dialog?.event?.source === 'google' || dialog?.event?.source === 'outlook') {
      await deleteExternalEvent(dialog.event)
      setDialog(null)
    } else if (dialog?.eventId) {
      if (await deleteEvent(dialog.eventId)) setDialog(null)
    } else {
      setDialog(null)
    }
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

      {/* Google + Outlook connections. Preview: a compact status/prompt bar
          with the full cards one click away (research §2.6). Default: the
          original permanent side-by-side cards, unchanged. */}
      {calendarPreview ? (
        <CalendarConnectBar
          googleSyncing={googleSyncing}
          googleLastSynced={googleLastSynced}
          outlookSyncing={outlookSyncing}
          outlookLastSynced={outlookLastSynced}
          onRefreshGoogle={() => void refreshGoogle()}
          onRefreshOutlook={() => void refreshOutlook()}
        />
      ) : (
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
      )}

      {items.length === 0 && !loading && (
        <p className="mb-3 flex items-center gap-2 text-[13px] text-faint">
          <CalendarDays className="h-4 w-4" />
          Your calendar is empty — click any day to add an event. Your tasks show up here
          automatically too.
        </p>
      )}

      {/* Body. Preview adds the agenda rail beside the grid — the grid keeps
          its own width and behaviour, so this is additive rather than a
          re-layout (research §2.1: the list exists so the grid is ALLOWED to
          truncate without hiding anything). Hidden below xl, where taking
          256px from the grid would cost more than the list gives back. */}
      <div className="flex min-h-0 flex-1 gap-4">
        <div className="min-h-0 min-w-0 flex-1">
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
        {calendarPreview && !loading && (
          // Threshold picked from the real machine, not from the breakpoint
          // scale: this display is 1600 physical px at 125% Windows scaling,
          // i.e. ~1280 CSS px — exactly Tailwind's `xl` minimum, so `xl:flex`
          // sat on the boundary and lost (a scrollbar is enough to tip it),
          // and the rail never appeared. 1200px clears that edge case while
          // still hiding the rail on displays where surrendering 256px would
          // squeeze the seven-column grid harder than the list is worth.
          <div className="hidden min-[1200px]:flex">
            <AgendaRail
              items={items}
              rangeStart={visibleRange.start}
              rangeEnd={visibleRange.end}
              onEditEvent={openEdit}
            />
          </div>
        )}
      </div>

      {quickSlot && (
        <QuickEventDialog
          slotStart={quickSlot}
          onClose={() => setQuickSlot(null)}
          onCreate={async (draft) => {
            await createEvent(draftToInput(draft))
            setQuickSlot(null)
          }}
          onMoreOptions={(draft) => {
            setQuickSlot(null)
            setDialog({ mode: 'new', draft })
          }}
        />
      )}

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
          onOpenCall={
            dialog.event?.callId && onOpenCall
              ? () => {
                  setDialog(null)
                  onOpenCall(dialog.event!.callId!)
                }
              : undefined
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
  const kinds: CalendarItemKind[] = ['event', 'task', 'google', 'outlook']
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
