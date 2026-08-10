// Calendar-overlap attendee matching (M19 Task 2, Part B step 2) — the
// main-process twin of src/renderer/src/features/contacts/calendarMatch.ts's
// overlap algorithm. Duplicated rather than shared because main can't import
// renderer code (the established pattern in this repo — see coach-pdf.ts's
// own duplicate of speakerLabel()); kept deliberately identical in behavior.
//
// Google/Outlook's `attendees` already EXCLUDES the connected account's own
// entry (see GoogleEvent/OutlookEvent's doc comments in google.ts/outlook.ts),
// so a genuine 1:1 meeting's attendees array has exactly one entry — the
// other person — with no separate "who's the organizer" check needed.

export interface CalendarAttendee {
  email: string
  name?: string
}

interface OverlapEvent {
  title: string
  start: string
  end: string
  allDay: boolean
  attendees?: CalendarAttendee[]
}

export interface AttendeeMatch {
  attendee: CalendarAttendee
  eventTitle: string
  eventStart: string
  /** True when this event had exactly one attendee (a genuine 1:1) — the
   *  brief's "highest confidence" case, vs. a group meeting where picking
   *  one attendee as "the other person" would be a guess. */
  isOneOnOne: boolean
}

const DEFAULT_BUFFER_MS = 15 * 60 * 1000

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && aEnd > bStart
}

/**
 * Find calendar events that overlap the call's time window (with a buffer —
 * calls rarely start/end exactly on the invite time) and return one match per
 * unique attendee email, closest event first. Pure time-based matching, never
 * a guess from the transcript.
 */
export function findOverlappingAttendees(
  call: { startedAtMs: number; durationMs: number },
  events: OverlapEvent[],
  bufferMs: number = DEFAULT_BUFFER_MS
): AttendeeMatch[] {
  const callStart = call.startedAtMs
  const callEnd = callStart + Math.max(call.durationMs, 0)
  if (!Number.isFinite(callStart)) return []

  const candidates = events
    .filter((e) => !e.allDay && e.attendees && e.attendees.length > 0)
    .filter((e) => {
      const eStart = new Date(e.start).getTime()
      const eEnd = new Date(e.end).getTime()
      return overlaps(callStart - bufferMs, callEnd + bufferMs, eStart, eEnd)
    })
    .sort(
      (a, b) =>
        Math.abs(new Date(a.start).getTime() - callStart) -
        Math.abs(new Date(b.start).getTime() - callStart)
    )

  const seen = new Set<string>()
  const matches: AttendeeMatch[] = []
  for (const event of candidates) {
    const attendees = event.attendees ?? []
    for (const attendee of attendees) {
      if (seen.has(attendee.email)) continue
      seen.add(attendee.email)
      matches.push({
        attendee,
        eventTitle: event.title,
        eventStart: event.start,
        isOneOnOne: attendees.length === 1
      })
    }
  }
  return matches
}

/** The brief's specific rule: "in a 1:1, the single non-organizer attendee
 *  IS the other person." Returns the closest 1:1 match only — a group
 *  meeting never guesses which attendee was actually on this call. */
export function bestOneOnOneMatch(
  call: { startedAtMs: number; durationMs: number },
  events: OverlapEvent[],
  bufferMs?: number
): AttendeeMatch | null {
  const matches = findOverlappingAttendees(call, events, bufferMs)
  return matches.find((m) => m.isOneOnOne) ?? null
}

/** "sarah.chen@acme.com" -> "Sarah Chen" — the fallback when an attendee has
 *  an email but no display name. Splits on common separators, title-cases
 *  each part, drops anything that's purely numeric (ids, not name parts). */
export function nameFromEmailLocalPart(email: string): string | undefined {
  const local = email.split('@')[0]
  if (!local) return undefined
  const parts = local
    .split(/[._+-]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !/^\d+$/.test(p))
  if (parts.length === 0) return undefined
  return parts
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(' ')
}
