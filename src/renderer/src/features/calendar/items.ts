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
  },
  google: {
    chip: 'bg-emerald-500/15 text-emerald-200',
    block: 'border-l-2 border-emerald-400 bg-emerald-500/15 text-emerald-100',
    dot: 'bg-emerald-400'
  },
  outlook: {
    chip: 'bg-blue-600/15 text-blue-300',
    block: 'border-l-2 border-blue-500 bg-blue-600/15 text-blue-200',
    dot: 'bg-blue-500'
  }
}

export const KIND_LABEL: Record<CalendarItemKind, string> = {
  event: 'Event',
  task: 'Task',
  call: 'Call',
  google: 'Google',
  outlook: 'Outlook'
}

const MIN_CALL_MINUTES = 15

/** Merge manual events, due tasks, past calls, and Google/Outlook events into
 *  one render-ready list. Google/Outlook events are read-only overlays UNLESS
 *  two-way sync is on for that provider, in which case editing/deleting one
 *  adopts it. */
export function buildItems(
  events: CalendarEvent[],
  tasks: Task[],
  calls: CallSummary[],
  googleEvents: CalendarEvent[] = [],
  googleWritable = false,
  outlookEvents: CalendarEvent[] = [],
  outlookWritable = false
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

  // Events we pushed to Google/Outlook get pulled back by the read-only sync.
  // Drop any pulled copy that matches a local event's remote link, so a
  // two-way-synced event shows ONCE (as the editable local copy), never
  // twice. A JSON-tuple key is collision-proof (structure is encoded), and
  // keeps this file plain text.
  const linkedKeys = new Set<string>()
  for (const e of events) {
    if (e.provider && e.externalId) linkedKeys.add(JSON.stringify([e.provider, e.externalId]))
  }

  const externalOverlays: {
    list: CalendarEvent[]
    kind: 'google' | 'outlook'
    writable: boolean
    subtitle: string
  }[] = [
    { list: googleEvents, kind: 'google', writable: googleWritable, subtitle: 'Google Calendar' },
    {
      list: outlookEvents,
      kind: 'outlook',
      writable: outlookWritable,
      subtitle: 'Outlook Calendar'
    }
  ]

  for (const overlay of externalOverlays) {
    for (const g of overlay.list) {
      if (g.provider && g.externalId && linkedKeys.has(JSON.stringify([g.provider, g.externalId])))
        continue
      // Editable when two-way sync is on for THIS provider AND the event lives
      // on a WRITABLE calendar (owner/writer). The dialog handles all-day +
      // multi-day, so any writable event can be edited; read-only calendars
      // (holidays, subscribed) stay read-only chips.
      const editable = overlay.writable && g.writable === true
      items.push({
        key: `${overlay.kind}-${g.id}`,
        kind: overlay.kind,
        title: g.title,
        start: new Date(g.start),
        end: new Date(g.end),
        allDay: g.allDay,
        event: editable ? g : undefined,
        subtitle: overlay.subtitle
      })
    }
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
  const date = format(start, 'yyyy-MM-dd')
  return {
    title: '',
    allDay: false,
    startDate: date,
    endDate: date,
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
    allDay: e.allDay,
    startDate: format(start, 'yyyy-MM-dd'),
    // All-day `end` is stored as the last ms of the final day, so its local date
    // IS the (inclusive) end day — exactly what the dialog shows.
    endDate: format(end, 'yyyy-MM-dd'),
    startTime: format(start, 'HH:mm'),
    endTime: format(end, 'HH:mm'),
    notes: e.notes ?? '',
    contactId: e.contactId,
    dealId: e.dealId
  }
}

/** Convert a draft into the payload window.api.events.create/update expects.
 *  All-day events store local-midnight start → inclusive last-ms of the end day,
 *  matching how pulled Google all-day events are stored (so they round-trip). */
export function draftToInput(draft: EventDraft): {
  title: string
  start: string
  end: string
  allDay: boolean
  notes: string | null
  contactId: string | null
  dealId: string | null
} {
  const title = draft.title.trim() || 'Untitled event'
  const notes = draft.notes.trim() || null
  const contactId = draft.contactId ?? null
  const dealId = draft.dealId ?? null
  const endDate = draft.endDate >= draft.startDate ? draft.endDate : draft.startDate // never before start
  if (draft.allDay) {
    const [ey, em, ed] = endDate.split('-').map(Number)
    return {
      title,
      start: combineLocalIso(draft.startDate, '00:00'),
      end: new Date(ey, em - 1, ed, 23, 59, 59, 999).toISOString(),
      allDay: true,
      notes,
      contactId,
      dealId
    }
  }
  return {
    title,
    start: combineLocalIso(draft.startDate, draft.startTime),
    end: combineLocalIso(endDate, draft.endTime),
    allDay: false,
    notes,
    contactId,
    dealId
  }
}
