// BUG-226 — which calendar event is the meeting happening right now?
//
// This used to be `all.find(...)` over `[...calEvents, ...googleEvents,
// ...outlookEvents]`: the FIRST event covering now, across three merged
// sources, with no tie-break and no dedupe. Back-to-back meetings, an
// overlapping invitation, or the SAME meeting arriving from two providers all
// resolved by array order — which is to say, by which feed happened to load.
//
// WHY IT MATTERS MORE THAN A WRONG LABEL. `useLiveDealFacts` already reads
// `meeting.contactId` and builds the live deal-facts line from that contact's
// history, so a wrong match already puts the wrong client's facts on screen.
// On screen that is recoverable — the rep sees a name that is wrong and
// discounts it. Under BUG-222 it would not be: a cue does not present itself
// as being about a client, it arrives as advice, mid-sentence, with nothing on
// it to check against. Wrong-client facts spoken into a live call are worse
// than no facts.
//
// THE RULE THIS FOLLOWS is not invented here. `calls-fs.ts:474-486` already
// states it for the call→deal link, and it is the same problem:
//
//   EXPLICIT, NEVER INFERRED. A guessed link is indistinguishable from a real
//   one in every later analysis, and a wrong attribution does not announce
//   itself... the app may OFFER the link; it never records one on the user's
//   behalf.
//
// So this ranks by how EXPLICIT the evidence is, and where two candidates are
// genuinely indistinguishable it returns NOTHING. An arbitrary pick is a
// guess wearing a confident face; no match is a visibly empty line the rep can
// read as "I don't know". The cost of the wrong client is higher than the cost
// of no client.
import type { CalendarEvent } from '../calendar/types'

/** A meeting is considered live from 10 minutes before it starts until it
 *  ends — unchanged from the original, this is not what was wrong. */
const EARLY_MS = 10 * 60_000

export interface MeetingMatch {
  meeting: CalendarEvent | null
  /** Why — for tests, and so an ambiguous outcome can be told apart from an
   *  empty calendar by anything that later wants to say so in the UI. */
  reason: 'none' | 'single' | 'ranked' | 'ambiguous'
  /** How many distinct meetings covered this moment, after mirrors of the
   *  same meeting were collapsed. */
  candidates: number
}

function coversNow(e: CalendarEvent, now: number): boolean {
  if (e.allDay) return false
  const start = new Date(e.start).getTime()
  const end = new Date(e.end).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false
  return now >= start - EARLY_MS && now <= end
}

/**
 * Collapse provider mirrors of ONE meeting.
 *
 * A meeting the user created here and linked to Google exists twice: as a
 * local event carrying `externalId`, and as the Google feed's own copy whose
 * `id` IS that external id. Those are not two candidates and must never make
 * the match look ambiguous. Keyed on the external identity where there is one,
 * so the two collapse onto the same key; events with no link keep their own id.
 *
 * Where a key collides, the LOCAL copy wins, because it is the one that can
 * carry `contactId` — provider feeds have no such field (it is "app-local
 * metadata only, never pushed to Google/Outlook", events-fs.ts:75-78).
 */
function collapseMirrors(events: CalendarEvent[]): CalendarEvent[] {
  const byIdentity = new Map<string, CalendarEvent>()
  for (const e of events) {
    const key = e.externalId ?? e.id
    const held = byIdentity.get(key)
    if (!held) {
      byIdentity.set(key, e)
      continue
    }
    // Prefer whichever copy carries the hand-made link; then the local one.
    const heldScore = (held.contactId ? 2 : 0) + (held.provider ? 0 : 1)
    const nextScore = (e.contactId ? 2 : 0) + (e.provider ? 0 : 1)
    if (nextScore > heldScore) byIdentity.set(key, e)
  }
  return [...byIdentity.values()]
}

/**
 * The ranking signals, most explicit first. Every one is a fact the USER
 * supplied or a fact about this event specifically — never array order, and
 * never the provider it came from, which says nothing about which meeting the
 * rep is actually in.
 */
function signals(e: CalendarEvent, now: number): number[] {
  const start = new Date(e.start).getTime()
  const end = new Date(e.end).getTime()
  return [
    // 1. The rep linked this event to a contact or deal BY HAND, in the
    //    New/Edit Event dialog. Nothing else here is user intent; this is.
    e.contactId || e.dealId ? 1 : 0,
    // 2. Already started, rather than merely inside the 10-minute early
    //    window. A meeting in progress beats one about to begin.
    now >= start ? 1 : 0,
    // 3. The narrower window. Given a 30-minute meeting nested inside a
    //    day-long "focus block", the specific one is the meeting.
    Number.isFinite(end - start) ? -(end - start) : Number.NEGATIVE_INFINITY
  ]
}

/**
 * Rank the meetings covering `now` and return one only if the top candidate is
 * genuinely distinguishable from the runner-up.
 *
 * Deterministic: given the same events and the same instant it returns the
 * same answer regardless of the order the three feeds loaded in.
 */
export function matchLiveMeeting(events: CalendarEvent[], now: number): MeetingMatch {
  const live = collapseMirrors(events.filter((e) => coversNow(e, now)))
  if (live.length === 0) return { meeting: null, reason: 'none', candidates: 0 }
  if (live.length === 1) return { meeting: live[0], reason: 'single', candidates: 1 }

  const scored = live
    .map((e) => ({ e, s: signals(e, now) }))
    .sort((a, b) => {
      for (let i = 0; i < a.s.length; i++) if (a.s[i] !== b.s[i]) return b.s[i] - a.s[i]
      return 0
    })

  const [best, runnerUp] = scored
  const tied = best.s.every((v, i) => v === runnerUp.s[i])
  // TIED ON EVERY SIGNAL -> NOTHING. Two meetings the app cannot tell apart is
  // a real state, and the rep is the one who can resolve it. Picking one would
  // be right half the time and silently wrong the other half, which is the
  // failure mode this whole file exists to remove.
  if (tied) return { meeting: null, reason: 'ambiguous', candidates: live.length }
  return { meeting: best.e, reason: 'ranked', candidates: live.length }
}
