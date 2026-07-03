// Renderer-side calendar types. The CalendarEvent shape mirrors what the
// preload bridge exposes (see src/preload/index.d.ts); kept local so the
// feature is self-contained, matching the calls/tasks convention.

export interface CalendarEvent {
  id: string
  title: string
  start: string // ISO datetime
  end: string // ISO datetime
  allDay: boolean
  notes?: string
  source: 'local'
  provider?: string
  externalId?: string
  createdAt: string
  updatedAt: string
}

/** The three things that can appear on the calendar. */
export type CalendarItemKind = 'event' | 'task' | 'call'

/**
 * A unified, render-ready item. Manual events are editable; tasks (on their
 * due date) and calls (when they happened) are read-only overlays.
 */
export interface CalendarItem {
  key: string // unique across kinds (kind-prefixed)
  kind: CalendarItemKind
  title: string
  start: Date
  end: Date
  allDay: boolean
  /** Present only for editable manual events. */
  event?: CalendarEvent
  /** Extra context for tooltips / styling. */
  subtitle?: string
  done?: boolean // for tasks
}

/** The editable fields for the create/edit dialog. */
export interface EventDraft {
  title: string
  date: string // YYYY-MM-DD (local)
  startTime: string // HH:mm
  endTime: string // HH:mm
  notes: string
}
