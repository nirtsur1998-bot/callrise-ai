// BUG-226 — the live meeting match had no tie-break and no dedupe.
//
// The old code was `all.find(...)` over `[...calEvents, ...googleEvents,
// ...outlookEvents]`, so the answer to "which meeting am I in" was decided by
// which calendar feed happened to load first. Several of these tests are
// written as ORDER PAIRS for that reason: the same events in a different order
// must give the same answer, which is precisely what the old code could not do.
import { describe, expect, it } from 'vitest'
import { matchLiveMeeting } from '../matchLiveMeeting'
import type { CalendarEvent } from '../../calendar/types'

const NOW = new Date('2026-09-10T14:30:00.000Z').getTime()
const at = (mins: number): string => new Date(NOW + mins * 60_000).toISOString()

function ev(over: Partial<CalendarEvent> & { id: string }): CalendarEvent {
  return {
    title: 'Meeting',
    start: at(-10),
    end: at(20),
    allDay: false,
    source: 'local',
    ...over
  } as CalendarEvent
}

describe('BUG-226 — the answer must not depend on which feed loaded first', () => {
  it('prefers the meeting the rep LINKED BY HAND, whichever order the feeds arrive in', () => {
    // The signal that matters: `contactId` on an event is set only from the
    // New/Edit Event dialog — it is user intent, and the only thing here that
    // is. The old code returned whichever came first in the array.
    const linked = ev({ id: 'linked', contactId: 'contact-1' })
    const unlinked = ev({ id: 'unlinked' })

    expect(matchLiveMeeting([unlinked, linked], NOW).meeting?.id).toBe('linked')
    expect(matchLiveMeeting([linked, unlinked], NOW).meeting?.id).toBe('linked')
  })

  it('prefers a meeting IN PROGRESS over one merely inside the 10-minute early window', () => {
    const started = ev({ id: 'started', start: at(-5), end: at(25) })
    const upcoming = ev({ id: 'upcoming', start: at(8), end: at(38) })

    expect(matchLiveMeeting([upcoming, started], NOW).meeting?.id).toBe('started')
    expect(matchLiveMeeting([started, upcoming], NOW).meeting?.id).toBe('started')
  })

  it('prefers the NARROWER window — the 30-minute call inside the day-long block', () => {
    const block = ev({ id: 'block', title: 'Focus time', start: at(-120), end: at(240) })
    const call = ev({ id: 'call', start: at(-5), end: at(25) })

    expect(matchLiveMeeting([block, call], NOW).meeting?.id).toBe('call')
    expect(matchLiveMeeting([call, block], NOW).meeting?.id).toBe('call')
  })

  it('applies the signals in order — a hand-link beats being further along', () => {
    // Explicitness outranks everything. A linked meeting still in its early
    // window wins over an unlinked one already running, because one of them is
    // something the rep said and the other is something the clock said.
    const linkedUpcoming = ev({ id: 'linked', contactId: 'c1', start: at(5), end: at(35) })
    const runningUnlinked = ev({ id: 'running', start: at(-5), end: at(25) })

    expect(matchLiveMeeting([runningUnlinked, linkedUpcoming], NOW).meeting?.id).toBe('linked')
    expect(matchLiveMeeting([linkedUpcoming, runningUnlinked], NOW).meeting?.id).toBe('linked')
  })
})

describe('BUG-226 — one meeting arriving twice is not two candidates', () => {
  it('collapses a local event and its provider mirror', () => {
    // A meeting created here and linked to Google exists twice: locally with
    // `externalId`, and in the Google feed whose `id` IS that external id.
    // Left uncollapsed these look like an ambiguous pair and would resolve to
    // NOTHING — turning a dedupe bug into a silently blank meeting line.
    const local = ev({ id: 'local-1', externalId: 'g-abc', contactId: 'c1' })
    const mirror = ev({ id: 'g-abc', provider: 'google:someone@example.com' })

    const r = matchLiveMeeting([local, mirror], NOW)
    expect(r.candidates).toBe(1)
    expect(r.reason).toBe('single')
    expect(r.meeting?.id).toBe('local-1') // the copy that can carry the hand link
  })

  it('keeps the copy carrying the contact link, whichever order they arrive in', () => {
    const local = ev({ id: 'local-1', externalId: 'g-abc', contactId: 'c1' })
    const mirror = ev({ id: 'g-abc', provider: 'google:someone@example.com' })
    const r = matchLiveMeeting([mirror, local], NOW)
    // `candidates` is load-bearing, not decoration. Asserting only on
    // contactId passed with the dedupe REMOVED — the two uncollapsed copies
    // went to ranking, where the linked one wins anyway, so the test proved
    // the ranking and claimed to prove the dedupe. Caught by the red-check
    // firing on its sibling and not on this.
    expect(r.candidates).toBe(1)
    expect(r.meeting?.contactId).toBe('c1')
  })

  it('does NOT collapse two genuinely different meetings', () => {
    const a = ev({ id: 'a' })
    const b = ev({ id: 'b' })
    expect(matchLiveMeeting([a, b], NOW).candidates).toBe(2)
  })
})

describe('BUG-226 — ambiguity resolves to NOTHING, never to a guess', () => {
  it('returns no meeting when two candidates are tied on every signal', () => {
    // The rule from calls-fs.ts, applied here: "EXPLICIT, NEVER INFERRED... the
    // app may OFFER the link; it never records one on the user's behalf."
    // Picking one would be right half the time and silently wrong the other
    // half — and under BUG-222 the wrong half becomes a wrong client's budget
    // spoken into a live call.
    const a = ev({ id: 'a', title: 'Acme' })
    const b = ev({ id: 'b', title: 'Globex' })

    const r = matchLiveMeeting([a, b], NOW)
    expect(r.meeting).toBeNull()
    expect(r.reason).toBe('ambiguous')
    expect(r.candidates).toBe(2)
  })

  it('two tied meetings do not become unambiguous by adding a third, distinguishable one', () => {
    // A ranked winner is only trustworthy if it beat the RUNNER-UP. A rule that
    // compared the best against the worst would call this resolved.
    const linkedA = ev({ id: 'a', contactId: 'c1' })
    const linkedB = ev({ id: 'b', contactId: 'c2' })
    const plain = ev({ id: 'c' })

    expect(matchLiveMeeting([linkedA, linkedB, plain], NOW).meeting).toBeNull()
  })

  it('still answers when the tie is broken by any single signal', () => {
    const a = ev({ id: 'a', start: at(-5), end: at(25) })
    const b = ev({ id: 'b', start: at(-5), end: at(26) }) // one minute wider
    expect(matchLiveMeeting([a, b], NOW).meeting?.id).toBe('a')
    expect(matchLiveMeeting([b, a], NOW).meeting?.id).toBe('a')
  })
})

describe('BUG-226 — the parts that were right stay right', () => {
  it('ignores all-day events', () => {
    expect(matchLiveMeeting([ev({ id: 'x', allDay: true })], NOW).meeting).toBeNull()
  })

  it('ignores an event with an unparseable time rather than treating it as live', () => {
    expect(matchLiveMeeting([ev({ id: 'x', start: 'not-a-date' })], NOW).meeting).toBeNull()
  })

  it('matches from 10 minutes before the start, and not 11', () => {
    expect(matchLiveMeeting([ev({ id: 'x', start: at(10), end: at(40) })], NOW).meeting?.id).toBe('x')
    expect(matchLiveMeeting([ev({ id: 'x', start: at(11), end: at(41) })], NOW).meeting).toBeNull()
  })

  it('stops matching once the meeting has ended', () => {
    expect(matchLiveMeeting([ev({ id: 'x', start: at(-40), end: at(-1) })], NOW).meeting).toBeNull()
  })

  it('an empty calendar is "none", which is not the same state as "ambiguous"', () => {
    expect(matchLiveMeeting([], NOW)).toEqual({ meeting: null, reason: 'none', candidates: 0 })
  })
})

describe('M39 Stage 0 — collapsing a mirror must not throw away who was invited', () => {
  // The two copies of a mirrored meeting hold DIFFERENT things: the local one
  // can carry `contactId`, the provider one carries `attendees`. Collapsing has
  // to pick a winner, and picking the local twin for its contactId silently
  // discarded the identity ladder's primary input — at the exact moment the
  // rest of M39 goes looking for it. So the winner inherits what it lacks.
  const INVITEE = [{ email: 'sarah.chen@acme-example.com', name: 'Sarah Chen' }]

  it('keeps the invitee list from the copy that loses the collapse', () => {
    const local = ev({ id: 'local', externalId: 'goog-1', contactId: 'contact-1' })
    const feed = ev({ id: 'goog-1', source: 'google', provider: 'google:a', attendees: INVITEE })

    for (const order of [
      [local, feed],
      [feed, local]
    ]) {
      const { meeting } = matchLiveMeeting(order, NOW)
      expect(meeting?.contactId).toBe('contact-1') // still the local winner
      expect(meeting?.attendees).toEqual(INVITEE) // and now it has both
    }
  })

  it('never lets the loser overwrite a list the winner already has', () => {
    // A local list was written deliberately (an adoption, or an edit). A stale
    // provider copy must not replace it.
    const own = [{ email: 'someone.else@acme-example.com' }]
    const local = ev({ id: 'local', externalId: 'goog-1', contactId: 'c-1', attendees: own })
    const feed = ev({ id: 'goog-1', source: 'google', provider: 'google:a', attendees: INVITEE })

    expect(matchLiveMeeting([local, feed], NOW).meeting?.attendees).toEqual(own)
    expect(matchLiveMeeting([feed, local], NOW).meeting?.attendees).toEqual(own)
  })

  it('still collapses to ONE candidate — inheriting must not un-dedupe', () => {
    const local = ev({ id: 'local', externalId: 'goog-1', contactId: 'c-1' })
    const feed = ev({ id: 'goog-1', source: 'google', provider: 'google:a', attendees: INVITEE })
    expect(matchLiveMeeting([local, feed], NOW)).toMatchObject({ reason: 'single', candidates: 1 })
  })

  it('leaves an unmirrored provider event exactly as it is', () => {
    const feed = ev({ id: 'goog-9', source: 'google', provider: 'google:a', attendees: INVITEE })
    expect(matchLiveMeeting([feed], NOW).meeting?.attendees).toEqual(INVITEE)
  })
})
