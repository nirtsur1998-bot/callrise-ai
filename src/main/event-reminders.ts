// M31 calendar-research Slice A — the reminder-honesty fix (design audit
// item #23: "Reminders on calendar events are silently inert until two-way
// sync is on (fine print only)").
//
// A calendar event's `reminderMinutes` are pushed to Google/Outlook so THAT
// provider fires its own native push notification. That only works for an
// event actually synced in two-way mode — so on a local-only event, or with
// sync off entirely, picking "15m" did visibly nothing, forever, with only
// fine print to say so. A control that claims to work and doesn't is exactly
// the species this milestone has been killing.
//
// This is the fallback: when the provider will NOT fire a reminder for an
// event, the app fires its own local notification instead. Deliberately
// scoped small:
//   • It never competes with the provider (see providerOwnsReminder) — no
//     double notifications.
//   • It only fires while the app is running. That's an honest limit, and
//     the picker's copy now says so rather than implying otherwise. (The
//     fire-while-closed path is alerts.ts's server-side dispatcher, a
//     different, cloud-gated feature — see BUG-083.)
//   • Timers are only armed for the next few hours and rebuilt periodically,
//     so a calendar with years of events doesn't hold thousands of timers.
import { listEvents, type CalendarEvent } from './events-fs'
import { isAnySyncEnabled } from './calendar-sync'
import { showNativeNotification } from './notifications'
import { format } from 'date-fns'

/** Only arm real timers for reminders due within this window; a periodic
 *  rebuild pulls in the next batch as it approaches. setTimeout is also not
 *  reliable at multi-hour delays (and would silently drift across sleep). */
export const HORIZON_MS = 4 * 60 * 60 * 1000
const REBUILD_INTERVAL_MS = 30 * 60 * 1000

/**
 * Whether Google/Outlook will fire this event's reminder itself, meaning the
 * local fallback must stay silent. Mirrors the exact condition events-fs
 * documents for `reminderMinutes` taking effect: two-way sync on, AND this
 * event actually pushed (linked + synced). Pure so the
 * never-double-notify rule is testable without Electron or the network.
 */
export function providerOwnsReminder(
  event: Pick<CalendarEvent, 'externalId' | 'sync'>,
  syncEnabled: boolean
): boolean {
  if (!syncEnabled) return false
  if (!event.externalId) return false
  return event.sync?.state === 'synced'
}

export interface PlannedReminder {
  event: CalendarEvent
  minutes: number
  /** Epoch ms this reminder should fire. */
  fireAt: number
  /** Stable identity for "already delivered" bookkeeping. Includes `start`
   *  so MOVING an event legitimately re-arms its reminders, while an
   *  unchanged event seen by a later rebuild does not re-fire. */
  key: string
}

/**
 * Which reminders should be armed right now. Pure: no disk, no clock, no
 * timers — `now` and `syncEnabled` are passed in, so every skip rule
 * (past events, all-day, beyond the horizon, provider-owned, already fired)
 * is directly testable.
 */
export function planReminders(
  events: CalendarEvent[],
  now: number,
  syncEnabled: boolean,
  alreadyFired: ReadonlySet<string> = new Set()
): PlannedReminder[] {
  const planned: PlannedReminder[] = []
  for (const event of events) {
    if (!event.reminderMinutes?.length) continue
    // An all-day event has no meaningful "N minutes before" moment, and the
    // providers treat all-day reminders differently anyway — out of scope
    // rather than guessed at.
    if (event.allDay) continue
    const start = new Date(event.start).getTime()
    if (!Number.isFinite(start) || start <= now) continue
    if (providerOwnsReminder(event, syncEnabled)) continue

    for (const minutes of event.reminderMinutes) {
      const key = `${event.id}:${minutes}:${event.start}`
      if (alreadyFired.has(key)) continue
      const fireAt = start - minutes * 60_000
      if (fireAt <= now || fireAt - now > HORIZON_MS) continue
      planned.push({ event, minutes, fireAt, key })
    }
  }
  return planned
}

/** Every reminder key an event set could still legitimately fire — used to
 *  prune the delivered-set so it can't grow without bound across a long
 *  session (and so a deleted or moved event's key is forgotten). */
export function liveReminderKeys(events: CalendarEvent[]): Set<string> {
  const keys = new Set<string>()
  for (const event of events) {
    for (const minutes of event.reminderMinutes ?? []) {
      keys.add(`${event.id}:${minutes}:${event.start}`)
    }
  }
  return keys
}

export function reminderNotification(event: CalendarEvent, minutes: number): {
  title: string
  body: string
} {
  const lead = minutes >= 60 ? `${Math.round(minutes / 60)}h` : `${minutes}m`
  return {
    title: event.title || 'Untitled event',
    body: `Starts in ${lead} — ${format(new Date(event.start), 'h:mm a')}`
  }
}

// --- Runtime wiring (timers + disk), kept thin over the pure core above ----

const fired = new Set<string>()
let timers: NodeJS.Timeout[] = []
let rebuildTimer: NodeJS.Timeout | null = null
let eventsDirPath: (() => string) | null = null

async function rebuild(): Promise<void> {
  if (!eventsDirPath) return
  for (const t of timers) clearTimeout(t)
  timers = []

  let events: CalendarEvent[]
  let syncEnabled: boolean
  try {
    events = await listEvents(eventsDirPath())
    syncEnabled = await isAnySyncEnabled()
  } catch {
    return // a reminder is never worth crashing or retrying aggressively over
  }

  const now = Date.now()
  for (const { event, minutes, fireAt, key } of planReminders(events, now, syncEnabled, fired)) {
    timers.push(
      setTimeout(() => {
        fired.add(key)
        showNativeNotification(reminderNotification(event, minutes))
      }, fireAt - now)
    )
  }

  const live = liveReminderKeys(events)
  for (const k of fired) if (!live.has(k)) fired.delete(k)
}

/** Call once at startup. `getEventsDir` is passed in rather than imported so
 *  this module never needs Electron's `app` at module load. */
export function startEventReminders(getEventsDir: () => string): void {
  eventsDirPath = getEventsDir
  void rebuild()
  if (!rebuildTimer) rebuildTimer = setInterval(() => void rebuild(), REBUILD_INTERVAL_MS)
}

/** Re-read events and re-arm timers — called whenever events change on disk
 *  so a just-created or just-edited reminder is armed immediately rather
 *  than up to REBUILD_INTERVAL_MS later. */
export function refreshEventReminders(): void {
  void rebuild()
}
