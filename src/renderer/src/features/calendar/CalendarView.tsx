import { useMemo, useState } from 'react'
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
import { useCalendar } from './useCalendar'
import { GoogleConnect } from '@renderer/features/google/GoogleConnect'
import { MonthGrid } from './MonthGrid'
import { WeekGrid } from './WeekGrid'
import { EventDialog } from './EventDialog'
import {
  buildItems,
  draftToInput,
  draftFromEvent,
  newDraft,
  ITEM_STYLES,
  KIND_LABEL
} from './items'
import type { CalendarEvent, CalendarItemKind, EventDraft } from './types'

type View = 'month' | 'week'

interface DialogState {
  mode: 'new' | 'edit'
  draft: EventDraft
  eventId?: string
}

function rangeTitle(cursor: Date, view: View): string {
  if (view === 'month') return format(cursor, 'MMMM yyyy')
  const start = startOfWeek(cursor, { weekStartsOn: 0 })
  const end = addDays(start, 6)
  return isSameMonth(start, end)
    ? `${format(start, 'MMM d')} – ${format(end, 'd, yyyy')}`
    : `${format(start, 'MMM d')} – ${format(end, 'MMM d, yyyy')}`
}

export function CalendarView(): React.JSX.Element {
  const { events, tasks, calls, loading, createEvent, updateEvent, deleteEvent } = useCalendar()
  const [view, setView] = useState<View>('month')
  const [cursor, setCursor] = useState<Date>(() => new Date())
  const [dialog, setDialog] = useState<DialogState | null>(null)

  const items = useMemo(() => buildItems(events, tasks, calls), [events, tasks, calls])

  const goPrev = (): void => setCursor((c) => (view === 'month' ? subMonths(c, 1) : subWeeks(c, 1)))
  const goNext = (): void => setCursor((c) => (view === 'month' ? addMonths(c, 1) : addWeeks(c, 1)))

  const openNew = (day: Date, hour?: number): void =>
    setDialog({ mode: 'new', draft: newDraft(day, hour) })
  const openEdit = (event: CalendarEvent): void =>
    setDialog({ mode: 'edit', draft: draftFromEvent(event), eventId: event.id })
  const zoomDay = (day: Date): void => {
    setCursor(day)
    setView('week')
  }

  const submitDialog = async (draft: EventDraft): Promise<void> => {
    if (!dialog) return
    const input = draftToInput(draft)
    if (dialog.mode === 'edit' && dialog.eventId) await updateEvent(dialog.eventId, input)
    else await createEvent(input)
    setDialog(null)
  }

  const deleteDialog = async (): Promise<void> => {
    if (dialog?.eventId) await deleteEvent(dialog.eventId)
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
              className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-elevated hover:text-ink"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Legend />
          <div className="flex items-center gap-0.5 rounded-lg border border-line p-0.5">
            {(['month', 'week'] as View[]).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium capitalize transition',
                  view === v ? 'bg-accent-soft text-ink' : 'text-muted hover:text-ink'
                )}
              >
                {v}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => openNew(cursor, view === 'week' ? 9 : undefined)}
            className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white transition hover:brightness-110"
          >
            <Plus className="h-4 w-4" /> New event
          </button>
        </div>
      </header>

      {/* Google Calendar connection (M13, read-only) */}
      <GoogleConnect />

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
          <div className="flex h-full items-center justify-center text-sm text-faint">Loading…</div>
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
        />
      )}
    </div>
  )
}

function Legend(): React.JSX.Element {
  const kinds: CalendarItemKind[] = ['event', 'task', 'call']
  return (
    <div className="hidden items-center gap-3 text-[11px] text-faint sm:flex">
      {kinds.map((k) => (
        <span key={k} className="flex items-center gap-1.5">
          <span className={cn('h-2 w-2 rounded-full', ITEM_STYLES[k].dot)} />
          {KIND_LABEL[k]}s
        </span>
      ))}
    </div>
  )
}
