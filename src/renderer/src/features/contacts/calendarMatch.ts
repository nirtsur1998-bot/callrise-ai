import type { CalendarEvent } from '@renderer/features/calendar/types'

export interface CalendarAttendee {
  email: string
  name?: string
}

export interface CalendarMatch {
  event: CalendarEvent
  attendee: CalendarAttendee
}

// How close a calendar event must be to the call's actual start/end to count
// as "the same meeting" — calls rarely start/end exactly on the invite time
// (a few minutes of chit-chat, joining late, running over), so we allow some
// wiggle room rather than requiring an exact match.
const BUFFER_MS = 15 * 60 * 1000

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && aEnd > bStart
}

/**
 * Find Google Calendar events that happened around the same time as this
 * call, and return one candidate per unique attendee (closest event first).
 * Matching is purely TIME-BASED — start/end overlap, with a small buffer —
 * never a guess from the transcript. Only Google events carry attendee data
 * today, so manually-created local events never produce a suggestion.
 */
export function findCalendarMatches(
  call: { createdAt: string; durationMs: number },
  googleEvents: CalendarEvent[]
): CalendarMatch[] {
  const callStart = new Date(call.createdAt).getTime()
  const callEnd = callStart + Math.max(call.durationMs, 0)
  if (Number.isNaN(callStart)) return []

  const candidates = googleEvents
    .filter((e) => !e.allDay && e.attendees && e.attendees.length > 0)
    .filter((e) => {
      const eStart = new Date(e.start).getTime()
      const eEnd = new Date(e.end).getTime()
      return overlaps(callStart - BUFFER_MS, callEnd + BUFFER_MS, eStart, eEnd)
    })
    .sort(
      (a, b) =>
        Math.abs(new Date(a.start).getTime() - callStart) -
        Math.abs(new Date(b.start).getTime() - callStart)
    )

  const seen = new Set<string>()
  const matches: CalendarMatch[] = []
  for (const event of candidates) {
    for (const attendee of event.attendees ?? []) {
      if (seen.has(attendee.email)) continue
      seen.add(attendee.email)
      matches.push({ event, attendee })
    }
  }
  return matches
}

// --- Per-call dismissal (renderer-only; no new main-process storage) -------
// "Not now" shouldn't nag on every visit to the call, but it's not worth a
// full backend field for a Phase-1 foundation — a small local list is enough.
const DISMISSED_KEY = 'crm.dismissedCalendarMatches'

function readDismissed(): string[] {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

export function isMatchDismissed(callId: string): boolean {
  return readDismissed().includes(callId)
}

export function dismissMatch(callId: string): void {
  const current = readDismissed()
  if (current.includes(callId)) return
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...current, callId]))
  } catch {
    /* localStorage unavailable — the suggestion just reappears next visit */
  }
}
