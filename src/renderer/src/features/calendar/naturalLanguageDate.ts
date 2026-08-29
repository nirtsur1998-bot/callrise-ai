import * as chrono from 'chrono-node'
import { format, roundToNearestMinutes } from 'date-fns'

// M31 Stage 4 calendar research — deliberately NARROW scope: chrono-node
// parses the date/time half only (the free, solved part of what made
// Fantastical famous); everything else in the typed text becomes the title
// verbatim. No invitee grammar, no locations, no recurrence, no slash syntax
// — those are the proprietary, hard-to-get-right half, and their documented
// failure mode (Fantastical over-parsing colleague names like "April"/"May"
// into dates) is aimed straight at a sales contact list made of names.
// `forwardDate: true` is load-bearing: without it, a bare weekday ("demo
// friday") resolves to the CLOSEST Friday, which is often the one that just
// passed — silently scheduling in the past is worse than any parse mistake
// this file could otherwise make.

const DEFAULT_DURATION_MINUTES = 30
const DEFAULT_HOUR_WHEN_UNSPECIFIED = 9

export interface ParsedEventInput {
  /** Everything NOT consumed by the date/time match — the event title. Empty
   *  string when the whole input was a date/time phrase (e.g. "tomorrow
   *  2pm"); callers should apply their own "Untitled event" fallback, same
   *  as the full dialog's draftToInput already does, rather than duplicating
   *  that default here. */
  title: string
  start: Date
  end: Date
  /** False when nothing date/time-like was found at all — start/end are
   *  just "now, rounded to the next half hour." True whenever chrono matched
   *  something, even a date with no explicit time (see hadExplicitTime). */
  matched: boolean
  /** True only when the matched phrase included a specific time of day (not
   *  just a date) — distinguishes "Friday at 2pm" from a bare "Friday",
   *  which still needs a defaulted hour. */
  hadExplicitTime: boolean
  /** One line for the live preview UI — the trust mechanism that makes a
   *  parse mistake visible before the event is saved, per the research
   *  doc's read of Fantastical's over-parsing complaints. */
  preview: string
}

function roundUpToNextHalfHour(d: Date): Date {
  return roundToNearestMinutes(d, { nearestTo: 30, roundingMethod: 'ceil' })
}

function formatPreview(start: Date, end: Date, matched: boolean, hadExplicitTime: boolean): string {
  const day = format(start, 'EEE, MMM d')
  const startTime = format(start, 'h:mm a')
  const endTime = format(end, 'h:mm a')
  if (!matched) return `${day}, ${startTime}–${endTime} (no date found — using now)`
  if (!hadExplicitTime) return `${day}, ${startTime}–${endTime} (no time given — defaults to 9 AM)`
  return `${day}, ${startTime}–${endTime}`
}

export function parseEventText(text: string, now: Date = new Date()): ParsedEventInput {
  const results = chrono.parse(text, now, { forwardDate: true })

  if (results.length === 0) {
    const start = roundUpToNextHalfHour(now)
    const end = new Date(start.getTime() + DEFAULT_DURATION_MINUTES * 60_000)
    return {
      title: text.trim(),
      start,
      end,
      matched: false,
      hadExplicitTime: false,
      preview: formatPreview(start, end, false, false)
    }
  }

  // Only the first match is used — see the file header on why this stays
  // narrow rather than trying to fuse a second phrase like "for 30 minutes"
  // (chrono returns that as its own separate, oddly-anchored match, not a
  // duration modifier on the first one).
  const match = results[0]
  const hadExplicitTime = match.start.isCertain('hour')
  let start = match.start.date()
  if (!hadExplicitTime) {
    start = new Date(start)
    start.setHours(DEFAULT_HOUR_WHEN_UNSPECIFIED, 0, 0, 0)
  }
  const end = match.end
    ? match.end.date()
    : new Date(start.getTime() + DEFAULT_DURATION_MINUTES * 60_000)

  const before = text.slice(0, match.index)
  const after = text.slice(match.index + match.text.length)
  const title = `${before} ${after}`.replace(/\s+/g, ' ').trim()

  return {
    title,
    start,
    end,
    matched: true,
    hadExplicitTime,
    preview: formatPreview(start, end, true, hadExplicitTime)
  }
}
