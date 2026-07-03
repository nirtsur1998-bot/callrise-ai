import { addMinutes, startOfDay, endOfDay, format } from 'date-fns'
import type { Task } from '@renderer/features/tasks/types'
import type { CallSummary } from '@renderer/features/calls/types'
import type { CalendarEvent, CalendarItem, CalendarItemKind, EventDraft } from './types'

/** Tailwind classes per kind: chips (month), blocks (week), and the legend dot. */
export const ITEM_STYLES: Record<CalendarItemKind, { chip: string; block: string; dot: string }> = {
  event: {
    chip: 'bg-accent-soft text-accent',
    block: 'border-l-2 border-accent bg-accent/15 text-ink',
    dot: 'bg-accent'
  },
  task: {
    chip: 'bg-amber-500/15 text-amber-200',
    block: 'border-l-2 border-amber-400 bg-amber-500/15 text-amber-100',
    dot: 'bg-amber-400'
  },
  call: {
    chip: 'bg-sky-500/15 text-sky-200',
    block: 'border-l-2 border-sky-400 bg-sky-500/15 text-sky-100',
    dot: 'bg-sky-400'
  }
}

export const KIND_LABEL: Record<CalendarItemKind, string> = {
  event: 'Event',
  task: 'Task',
  call: 'Call'
}

const MIN_CALL_MINUTES = 15

/** Merge manual events, due tasks, and past calls into one render-ready list. */
export function buildItems(
  events: CalendarEvent[],
  tasks: Task[],
  calls: CallSummary[]
): CalendarItem[] {
  const items: CalendarItem[] = []

  for (const e of events) {
    items.push({
      key: `event-${e.id}`,
      kind: 'event',
      title: e.title,
      start: new Date(e.start),
      end: new Date(e.end),
      allDay: e.allDay,
      event: e,
      subtitle: e.notes
    })
  }

  for (const t of tasks) {
    if (!t.dueAt) continue // tasks without a due date don't land on the calendar
    const day = startOfDay(new Date(t.dueAt))
    items.push({
      key: `task-${t.id}`,
      kind: 'task',
      title: t.title,
      start: day,
      end: day,
      allDay: true,
      done: t.status === 'done',
      subtitle: t.clientName
    })
  }

  for (const c of calls) {
    const start = new Date(c.createdAt)
    const minutes = Math.max(Math.round(c.durationMs / 60000), MIN_CALL_MINUTES)
    items.push({
      key: `call-${c.id}`,
      kind: 'call',
      title: c.title,
      start,
      end: addMinutes(start, minutes),
      allDay: false,
      subtitle: `${c.speakerCount} speaker${c.speakerCount === 1 ? '' : 's'}`
    })
  }

  return items
}

/** Items that overlap a given calendar day. */
export function itemsOnDay(items: CalendarItem[], day: Date): CalendarItem[] {
  const s = startOfDay(day).getTime()
  const e = endOfDay(day).getTime()
  return items.filter((it) => it.start.getTime() <= e && it.end.getTime() >= s)
}

/** Stable display order within a day: all-day first, then by start time. */
export function sortForDay(items: CalendarItem[]): CalendarItem[] {
  return [...items].sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1
    return a.start.getTime() - b.start.getTime()
  })
}

export function formatTime(d: Date): string {
  return format(d, 'h:mm a')
}

// --- Week-view overlap layout ----------------------------------------------

export interface LaidOutItem {
  item: CalendarItem
  lane: number
  lanes: number
}

/**
 * Pack overlapping timed items into side-by-side lanes (like Google Calendar):
 * each cluster of overlapping items is split into N equal columns.
 */
export function layoutColumns(items: CalendarItem[]): LaidOutItem[] {
  const sorted = [...items].sort(
    (a, b) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime()
  )
  const result: LaidOutItem[] = []
  let cluster: CalendarItem[] = []
  let clusterEnd = 0

  const flush = (): void => {
    const laneEnds: number[] = []
    const placed: { item: CalendarItem; lane: number }[] = []
    for (const it of cluster) {
      let lane = laneEnds.findIndex((end) => end <= it.start.getTime())
      if (lane === -1) {
        lane = laneEnds.length
        laneEnds.push(0)
      }
      laneEnds[lane] = it.end.getTime()
      placed.push({ item: it, lane })
    }
    for (const p of placed) result.push({ item: p.item, lane: p.lane, lanes: laneEnds.length })
    cluster = []
    clusterEnd = 0
  }

  for (const it of sorted) {
    if (cluster.length && it.start.getTime() >= clusterEnd) flush()
    cluster.push(it)
    clusterEnd = Math.max(clusterEnd, it.end.getTime())
  }
  if (cluster.length) flush()
  return result
}

// --- Event <-> draft conversion --------------------------------------------

function combineLocalIso(dateStr: string, timeStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const [hh, mm] = timeStr.split(':').map(Number)
  return new Date(y, m - 1, d, hh || 0, mm || 0, 0, 0).toISOString()
}

/** A blank draft for a new event on `day` (defaulting to `hour`, else 9am). */
export function newDraft(day: Date, hour?: number): EventDraft {
  const start = new Date(day)
  start.setHours(hour ?? 9, 0, 0, 0)
  const end = addMinutes(start, 60)
  return {
    title: '',
    date: format(start, 'yyyy-MM-dd'),
    startTime: format(start, 'HH:mm'),
    endTime: format(end, 'HH:mm'),
    notes: ''
  }
}

export function draftFromEvent(e: CalendarEvent): EventDraft {
  const start = new Date(e.start)
  const end = new Date(e.end)
  return {
    title: e.title,
    date: format(start, 'yyyy-MM-dd'),
    startTime: format(start, 'HH:mm'),
    endTime: format(end, 'HH:mm'),
    notes: e.notes ?? ''
  }
}

/** Convert a draft into the payload window.api.events.create/update expects. */
export function draftToInput(draft: EventDraft): {
  title: string
  start: string
  end: string
  notes: string | null
} {
  return {
    title: draft.title.trim() || 'Untitled event',
    start: combineLocalIso(draft.date, draft.startTime),
    end: combineLocalIso(draft.date, draft.endTime),
    notes: draft.notes.trim() || null
  }
}
