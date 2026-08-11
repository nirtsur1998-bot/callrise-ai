// Context fusion (M24 §5) — "at call start, build a cached deal context
// block: KYC brief + calendar event purpose + last call's summary if one
// exists." Deliberately does NOT re-derive any of that: M19's prep-brief
// pipeline already resolves contact/deal/last-call context and (when a real
// AI key is configured) turns it into ready prose — see
// main/prep-brief-fs.ts's assembleContext() and the Phase 1 codebase map's
// finding that window.api.prepBrief.getForEvent() is the richer, already-
// cached integration point. This file only adapts that result into the
// compact block Tier 1/2 prompts append, and degrades to "no context"
// whenever the meeting can't be resolved to a brief — never a blocking
// error, since a call with no calendar match is a normal, common case
// (ambient/manually-started calls), not a broken one.
//
// "Calendar event purpose" has no dedicated field anywhere in this codebase
// (confirmed during the Phase 1 map) — the closest analog, CalendarEvent's
// free-text `notes`, is included directly here rather than through the
// prep-brief pipeline (which doesn't thread it through either).

import type { CalendarEvent } from '@renderer/features/calendar/types'

export interface DealContext {
  /** Compact plain text ready to append to a Tier 1/2 prompt. Empty string
   *  when no context could be resolved — callers should treat that as
   *  "nothing extra to add," never as an error. */
  text: string
  available: boolean
}

const EMPTY_CONTEXT: DealContext = { text: '', available: false }

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export async function buildDealContext(meeting: CalendarEvent | null): Promise<DealContext> {
  if (!meeting) return EMPTY_CONTEXT

  try {
    const result = await window.api.prepBrief.getForEvent({
      eventId: meeting.id,
      title: meeting.title,
      startIso: meeting.start,
      attendees: meeting.attendees ?? [],
      contactId: meeting.contactId,
      dealId: meeting.dealId
    })
    if (!result.ok) return meeting.notes ? notesOnlyContext(meeting.notes) : EMPTY_CONTEXT

    const b = result.record.brief
    const lines = [
      `Who you're meeting: ${b.whoYoureMeeting}`,
      `Deal status: ${b.dealStatus}`,
      `Last time you spoke: ${b.lastTime}`,
      b.openCommitments.length > 0 ? `Open commitments: ${b.openCommitments.join('; ')}` : null,
      b.likelyObjections.length > 0
        ? `Likely objections going in: ${b.likelyObjections.join('; ')}`
        : null,
      meeting.notes ? `Meeting purpose (from the calendar invite): ${meeting.notes}` : null
    ].filter((line): line is string => Boolean(line))

    return { text: truncate(lines.join('\n'), 2_000), available: lines.length > 0 }
  } catch {
    // A failed IPC call is not a reason to block Tier 1/2 analysis — it just
    // runs without deal-specific grounding this pass, same as any call with
    // no calendar match at all.
    return meeting.notes ? notesOnlyContext(meeting.notes) : EMPTY_CONTEXT
  }
}

function notesOnlyContext(notes: string): DealContext {
  return { text: `Meeting purpose (from the calendar invite): ${notes}`, available: true }
}
