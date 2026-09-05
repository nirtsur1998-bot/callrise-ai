// Renderer-side calendar types. The CalendarEvent shape mirrors what the
// preload bridge exposes (see src/preload/index.d.ts); kept local so the
// feature is self-contained, matching the calls/tasks convention.

import type { ChipContext } from './chipContext'

export type EventSyncState = 'local-only' | 'synced' | 'dirty' | 'deleted' | 'error'

export interface CalendarEvent {
  id: string
  title: string
  start: string // ISO datetime
  end: string // ISO datetime
  allDay: boolean
  notes?: string
  source: 'local' | 'google' | 'outlook'
  provider?: string
  externalId?: string
  htmlLink?: string
  /** Google/Outlook-only: true when the event's calendar allows writes. */
  writable?: boolean
  /** Google/Outlook-only: other invitees (the connected account itself is
   *  excluded when the provider can tell) — the CRM's calendar-match signal
   *  for suggesting who a call was with. */
  attendees?: { email: string; name?: string }[]
  remoteUpdatedAt?: string
  sync?: { state: EventSyncState; lastPushedAt?: string; lastError?: string }
  /** The event was linked to a calendar that no longer exists; it is kept here
   *  only, and this says why (main's EventOrphan). */
  orphaned?: { provider: string; externalId: string; reason: 'calendar-gone'; at: string }
  /** The contact/deal this event is with, if linked — app-local only, never
   *  pushed to Google/Outlook. Powers the follow-up dashboard. */
  contactId?: string
  dealId?: string
  /** M31 Slice B — the call recorded during this meeting, joining plan to
   *  outcome on one object. Only ever set at call-save time, when the app
   *  already knows which meeting is running; never inferred afterwards from
   *  contact + time overlap, which would be a guess. Absent on every meeting
   *  that predates this, and on any meeting with no recording. */
  callId?: string
  /** Minutes-before-start lead times for a REAL reminder pushed to the
   *  linked Google/Outlook event (that provider's own app fires the actual
   *  push notification) — distinct from CallRise's own in-app alerts. Only
   *  takes effect once the event is actually synced in two-way mode; see
   *  EventDialog's reminder picker. */
  reminderMinutes?: number[]
  createdAt: string
  updatedAt: string
}

/** What can appear on the calendar. Google/Outlook events are read-only
 *  overlays unless two-way sync makes them editable. */
export type CalendarItemKind = 'event' | 'task' | 'google' | 'outlook'

/**
 * A unified, render-ready item. Manual events are editable; tasks (on their
 * due date) and Google/Outlook events are read-only overlays.
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
  /** M31 Slice B — the sales context this chip carries (who the meeting is
   *  with, the deal's stage and risk, whether a prep brief is ready).
   *  Attached by CalendarView after buildItems, since it needs contacts/
   *  deals/stages that the pure item builder has no business loading.
   *  Absent whenever there's nothing true to say — see buildChipContext. */
  context?: ChipContext
}

/** The editable fields for the create/edit dialog. Supports all-day and
 *  multi-day events (start/end dates); times are used only when not all-day. */
export interface EventDraft {
  title: string
  allDay: boolean
  startDate: string // YYYY-MM-DD (local)
  endDate: string // YYYY-MM-DD (local; >= startDate)
  startTime: string // HH:mm (ignored when allDay)
  endTime: string // HH:mm (ignored when allDay)
  notes: string
  contactId?: string
  dealId?: string
  /** See CalendarEvent.reminderMinutes — the picker offers 5/10/15/20/30/45/60. */
  reminderMinutes: number[]
}
