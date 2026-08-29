import { addMinutes, startOfDay, endOfDay, format } from 'date-fns'
import type { Task } from '@renderer/features/tasks/types'
import type { CalendarEvent, CalendarItem, CalendarItemKind, EventDraft } from './types'

/** Tailwind classes per kind: chips (month), blocks (week), and the legend dot. */
export const ITEM_STYLES: Record<CalendarItemKind, { chip: string; block: string; dot: string }> = {
  event: {
    chip: 'bg-accent-soft text-accent',
    block: 'border-l-2 border-accent bg-accent/15 text-ink',
    dot: 'bg-accent'
  },
  // M31 Stage 4: task/google moved off --color-warning/--color-positive onto
  // their own track tokens. A chip's colour says where the item came from —
  // a category — and borrowing a status colour made every task read as a
  // warning and every Google meeting read as a success.
  task: {
    chip: 'bg-track-task-soft text-track-task',
    block: 'border-l-2 border-track-task bg-track-task-soft text-track-task',
    dot: 'bg-track-task'
  },
  google: {
    chip: 'bg-track-google-soft text-track-google',
    block: 'border-l-2 border-track-google bg-track-google-soft text-track-google',
    dot: 'bg-track-google'
  },
  outlook: {
    chip: 'bg-track-outlook-soft text-track-outlook',
    block: 'border-l-2 border-track-outlook bg-track-outlook-soft text-track-outlook',
    dot: 'bg-track-outlook'
  }
}

export const KIND_LABEL: Record<CalendarItemKind, string> = {
  event: 'Event',
  task: 'Task',
  google: 'Google',
  outlook: 'Outlook'
}

/** Merge manual events, due tasks, and Google/Outlook events into one
 *  render-ready list. Google/Outlook events are read-only overlays UNLESS
 *  two-way sync is on for that provider, in which case editing/deleting one
 *  adopts it. Past calls deliberately do NOT appear here (BUG-135, M31
 *  Stage 2's calendar-design pass) — a calendar dominated by call history
 *  rather than upcoming events read as cluttered at real call volume; that
 *  history already lives in Past Calls and each contact/deal's own timeline. */
export function buildItems(
  events: CalendarEvent[],
  tasks: Task[],
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
    notes: '',
    reminderMinutes: []
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
    dealId: e.dealId,
    reminderMinutes: e.reminderMinutes ?? []
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
  reminderMinutes: number[]
} {
  const title = draft.title.trim() || 'Untitled event'
  const notes = draft.notes.trim() || null
  const contactId = draft.contactId ?? null
  const dealId = draft.dealId ?? null
  const reminderMinutes = draft.reminderMinutes
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
      dealId,
      reminderMinutes
    }
  }
  return {
    title,
    start: combineLocalIso(draft.startDate, draft.startTime),
    end: combineLocalIso(endDate, draft.endTime),
    allDay: false,
    notes,
    contactId,
    dealId,
    reminderMinutes
  }
}

/* M31 Stage 4 — the risk and prep-brief markers.
 *
 * These are dots drawn ON TOP of a coloured chip fill, which is why they get
 * their own module-level constants rather than being inlined twice: the
 * failure mode is not "wrong hue", it's "no contrast against the thing
 * underneath". A medium-risk dot was --color-warning amber sitting on an
 * amber event chip, and the ready-brief dot was --color-accent — the exact
 * same amber as the chip fill it sat on. Both were, in the literal sense,
 * invisible on the items most likely to have them.
 *
 * The load-bearing fix is the ring, not the hue: a ring in --color-canvas
 * separates the dot from ANY chip fill in either theme, because canvas is
 * the page ground and is therefore maximally distant from every fill drawn
 * on it. That holds even for a track colour we add later.
 *
 * Hues, on top of that: risk keeps danger/warning because risk genuinely IS
 * a severity — that reuse is correct and stays. The ready-brief dot moves
 * from accent to positive, which is also a real claim ("this is good to
 * open") rather than "this is ours". 'outdated' stays hollow: it means
 * "there is one, but opening it rebuilds it", a weaker claim that should
 * keep looking like one.
 */
const MARKER = 'h-1.5 w-1.5 shrink-0 rounded-full ring-1 ring-canvas'

export const RISK_DOT: Record<'high' | 'medium', string> = {
  high: `${MARKER} bg-danger`,
  medium: `${MARKER} bg-warning`
}

export const BRIEF_DOT: Record<'ready' | 'outdated', string> = {
  ready: `${MARKER} bg-positive`,
  outdated: `${MARKER} border border-current bg-transparent opacity-60`
}
