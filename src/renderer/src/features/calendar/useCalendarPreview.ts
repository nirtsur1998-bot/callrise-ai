import { useSyncExternalStore } from 'react'
import { loadCalendarPreview, saveCalendarPreview } from './calendarPreview'

// ONE module-level store shared by every useCalendarPreview() instance — same
// reasoning as useNavigationPreview.ts: a per-hook useState would let
// Settings' toggle and CalendarView's own instance disagree about which is live.
let current = loadCalendarPreview()
const listeners = new Set<() => void>()

function setEnabled(next: boolean): void {
  saveCalendarPreview(next)
  current = next
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): boolean {
  return current
}

export interface UseCalendarPreview {
  enabled: boolean
  setEnabled: (next: boolean) => void
}

/** M31 calendar-research Slice A — the two actual behavior changes to the
 *  existing calendar (defaulting to Week instead of Month, and removing the
 *  permanent Connect Google/Outlook cards in favor of a compact banner) ship
 *  behind this flag, default OFF, per the founder's explicit instruction:
 *  both are muscle-memory-affecting changes to a screen used daily, so they
 *  need the same preview/revert discipline Stage 2 used for the sidebar.
 *  The purely additive pieces (⌘K event creation, the reminder-honesty fix)
 *  are NOT gated by this flag — they change nothing about existing behavior,
 *  matching how Stage 2 only flagged its own behavior changes, not its
 *  additions. */
export function useCalendarPreview(): UseCalendarPreview {
  const enabled = useSyncExternalStore(subscribe, getSnapshot)
  return { enabled, setEnabled }
}
