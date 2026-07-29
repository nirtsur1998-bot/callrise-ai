// The core naming cascade (M19 Task 2, Part B) — pure decision logic, no IO.
// Takes already-fetched data (contacts, calendar events, the user's own
// name) and decides what each observed speaker key should be named, with a
// confidence and a source. Callers (resolve-for-call.ts) own fetching the
// data; this module owns the DECISION, which is what actually needs to be
// gotten right and is worth testing in isolation.
//
// Cascade order (first hit wins, per speaker key):
//   1. user's own name          -> the caller's own channel/speaker key
//   2. calendar attendee (1:1)  -> highest confidence
//   3. contact record match     -> via the calendar attendee's email
//   4. meeting-app participants -> NOT IMPLEMENTED (see docs/speaker-id.md)
//   5. self-intro extraction    -> handled separately, live-session-scoped
//      (see live-cue.ts's buyerName extension) — not part of this
//      post-hoc/on-save cascade at all.
//   6. voice profile             -> NOT IMPLEMENTED (schema-only, see
//      voice-profile.ts) — deliberately not an ML feature in this milestone.
//   7. fallback "Speaker N"     -> the existing renderer behavior; this
//      cascade simply produces no entry, which IS the fallback.

import { speakerIdentityKey, type SpeakerIdentityRecord } from '../calls-fs'
import { bestOneOnOneMatch, nameFromEmailLocalPart, type CalendarAttendee } from './calendar-match'

export interface ObservedSegment {
  speaker: number
  channel?: number
}

export interface ContactLookup {
  findByEmail(email: string): Promise<{ id: string; name: string } | null>
}

export interface CalendarEventLike {
  title: string
  start: string
  end: string
  allDay: boolean
  attendees?: CalendarAttendee[]
}

export interface ResolveInput {
  /** Every segment observed in the call — used only to enumerate which
   *  (channel, speaker) keys actually occurred, so resolution never invents
   *  an identity for a speaker who was never actually in this call. */
  segments: ObservedSegment[]
  /** True when this session used Deepgram multichannel (channel 0 = mic,
   *  channel 1 = other party) — see transcription.ts. */
  multichannel: boolean
  /** 0-based speaker number of the rep, once known (post live-cue lock or
   *  post-coaching). Required to resolve "me" in a MONO call; irrelevant for
   *  multichannel, where channel 0 always is the rep. */
  repSpeaker: number | null
  /** The signed-in user's own display name, if known. */
  userName: string | null
  call: { startedAtMs: number; durationMs: number }
  calendarEvents: CalendarEventLike[]
}

export type ResolvedIdentities = Record<string, Omit<SpeakerIdentityRecord, 'resolvedAt'>>

function observedKeys(segments: ObservedSegment[]): Set<string> {
  return new Set(segments.map(speakerIdentityKey))
}

function myKey(input: ResolveInput): string | null {
  if (input.multichannel) return speakerIdentityKey({ speaker: 0, channel: 0 })
  if (input.repSpeaker === null) return null
  return speakerIdentityKey({ speaker: input.repSpeaker })
}

/**
 * Step 1 + steps 2-3 combined. Pure — given the inputs, decides names. Does
 * NOT touch step 5 (self-intro, live-only) or step 6 (voice profile,
 * unimplemented) — those are separate call sites entirely.
 */
export async function resolveCascade(input: ResolveInput, contacts: ContactLookup): Promise<ResolvedIdentities> {
  const result: ResolvedIdentities = {}
  const observed = observedKeys(input.segments)
  const me = myKey(input)

  // --- Step 1: the user's own name -----------------------------------------
  if (me && observed.has(me) && input.userName) {
    result[me] = { name: input.userName, source: 'user-profile', confidence: 'high' }
  }

  // --- Steps 2-3: calendar attendee (+ contact refinement) -----------------
  // Only when there is EXACTLY ONE non-me speaker key observed — a genuine
  // 1:1. Multiple non-me keys means multiple distinct people were diarized
  // (or the "me" key itself couldn't be determined), and picking one of them
  // as "the" other party would be a guess this cascade explicitly refuses to
  // make (per the brief: unknown speaker degrades to "Speaker N", never a
  // wrong name).
  const otherKeys = [...observed].filter((k) => k !== me)
  if (otherKeys.length === 1) {
    const otherKey = otherKeys[0]
    const match = bestOneOnOneMatch(input.call, input.calendarEvents)
    if (match) {
      // Step 3 refines step 2: if the calendar attendee's email matches a
      // saved contact, prefer the CONTACT's name (the rep's own record of
      // this person, potentially corrected/fuller than however their
      // calendar invite happened to spell it) and link contactId so a
      // rename can flow back, and so future calls resolve instantly.
      const contact = await contacts.findByEmail(match.attendee.email)
      if (contact) {
        result[otherKey] = {
          name: contact.name,
          source: 'contact',
          confidence: 'high',
          contactId: contact.id
        }
      } else {
        const name = match.attendee.name?.trim() || nameFromEmailLocalPart(match.attendee.email)
        if (name) {
          result[otherKey] = { name, source: 'calendar', confidence: 'high' }
        }
      }
    }
  }

  return result
}
