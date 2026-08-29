// Which calendar view was last used. Google Calendar's own documented model
// ("after you choose a new view, it becomes your default view until you
// change it") — the research doc found no product that ships a *fixed*
// default anyone defends, and Outlook has no default-view setting at all.
// Renderer-only localStorage, same shape as calendarPreview.ts.

export type CalendarViewMode = 'month' | 'week'

const KEY = 'salesos.calendar.view'

/** The preview flag's new default. Cron/Notion Calendar documents Week as its
 *  own default ("defaults to a week view"), Amie triangulates to Week, and a
 *  rep's calendar questions ("what's next, am I prepared") are hour-resolution
 *  questions Month can't answer. Full reasoning: docs/M31-calendar-research.md
 *  §2.2. With the preview flag off, CalendarView keeps its original hardcoded
 *  'month' and never reads this file at all. */
export const PREVIEW_DEFAULT_VIEW: CalendarViewMode = 'week'

export function loadCalendarView(): CalendarViewMode {
  try {
    const raw = localStorage.getItem(KEY)
    return raw === 'month' || raw === 'week' ? raw : PREVIEW_DEFAULT_VIEW
  } catch {
    return PREVIEW_DEFAULT_VIEW
  }
}

export function saveCalendarView(view: CalendarViewMode): void {
  try {
    localStorage.setItem(KEY, view)
  } catch {
    /* best-effort: a view preference is non-critical */
  }
}
