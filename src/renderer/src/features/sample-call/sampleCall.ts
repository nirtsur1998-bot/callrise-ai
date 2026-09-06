/**
 * M36 Stage 1 — the sample call: the first useful moment for a stranger with
 * NO keys, NO context and nothing recorded yet.
 *
 * On the Stage 2 clean-machine walk (2026-09-05) a stranger who finished the
 * wizard and pressed "Start my first call" landed on a live view that could
 * transcribe nothing — no Deepgram key, no AI key — and the only thing the
 * product had shown them was setup. This is a complete, fictional call,
 * bundled with the app, rendered read-only from this file: transcript, the
 * cues CallRise would have shown live, and a coaching read. It is NEVER
 * written to the user's store — no record, no memory, no contact — so it
 * cannot be confused with, or backed up as, a real call. That is a deliberate
 * choice: what the app stores is the founder's decision, and a sample that
 * leaves no trace needs none.
 *
 * Everything here is invented. The names do not belong to anyone.
 */
import type { CallSegment } from '@renderer/features/calls/types'

export const SAMPLE_CALL_TITLE = 'Sample call · Northwind Solar × the Okafor household'
export const SAMPLE_CALL_DURATION_LABEL = '6 min'

/** speaker 0 = the rep (you), speaker 1 = the customer. */
export const SAMPLE_SEGMENTS: CallSegment[] = [
  { speaker: 0, role: 'rep', text: "Hi Priya, thanks for taking the call. Last time you mentioned the summer bill went past three hundred dollars a month. Is that still the picture?" },
  { speaker: 1, role: 'other', text: "It is. July was three forty. We've got the two air conditioners running most of the day, and the pool pump." },
  { speaker: 0, role: 'rep', text: "Okay, so that's the pain. I ran the numbers on your roof from the satellite view. A seven kilowatt system with one battery covers about ninety percent of that usage." },
  { speaker: 1, role: 'other', text: "And what does that come to? Because the last quote we got was for twenty-six thousand and honestly that ended the conversation." },
  { speaker: 0, role: 'rep', text: "Nineteen thousand after the federal credit, including the battery. I know that's still a big number. Can I ask what your timeline is for deciding, and who else needs to be part of it?" },
  { speaker: 1, role: 'other', text: "My husband, definitely. And we'd want it done before next summer. But nineteen is still a lot. What if we skip the battery?" },
  { speaker: 0, role: 'rep', text: "Without the battery you'd be at fourteen two, but you'd be selling power back at the daytime rate and buying it back in the evening at nearly triple. For your usage pattern the battery pays for itself in about four years." },
  { speaker: 1, role: 'other', text: "Hm. The other company didn't explain it like that. They just had the one price." },
  { speaker: 0, role: 'rep', text: "That's the thing to compare, then: are both quotes including storage, and what's the warranty on the panels? Ours is twenty-five years on output. If it would help, I can put both options side by side in one page and send it tonight, so you and your husband can look at it together." },
  { speaker: 1, role: 'other', text: "Yes, do that. If the four-year thing holds up we'd probably go with the battery. Can we talk again Thursday?" },
  { speaker: 0, role: 'rep', text: "Thursday works. I'll send the comparison tonight and a calendar invite for Thursday at ten. Thanks, Priya." }
]

export interface SampleCue {
  /** Which turn (index into SAMPLE_SEGMENTS) the cue would have fired after. */
  afterSegment: number
  kind: 'objection' | 'buying-signal' | 'discovery' | 'next-step'
  text: string
}

/** What the live coaching cues would have shown, and when. Written by hand
 *  for this transcript — no model was run; the point is to show the SHAPE of
 *  a cue at the moment it appears, not to claim a model produced it. */
export const SAMPLE_CUES: SampleCue[] = [
  { afterSegment: 3, kind: 'objection', text: 'Price objection — the last quote ended the conversation. Anchor on the monthly bill before the total.' },
  { afterSegment: 5, kind: 'discovery', text: 'Decision-maker named: the husband. Timeline: before next summer.' },
  { afterSegment: 7, kind: 'buying-signal', text: "They're comparing you on explanation, not price. Ask what the other quote included." },
  { afterSegment: 9, kind: 'next-step', text: 'Buying signal: "we\'d probably go with the battery". Lock the next step.' }
]

export interface SampleCoaching {
  summary: string
  strengths: string[]
  improvements: string[]
  nextAction: string
  tasks: string[]
}

/** The post-call coaching read, hand-written for this transcript. In the real
 *  product this is produced by your AI provider from the transcript; this one
 *  exists so a stranger can see what that output LOOKS like before adding a
 *  key. It is labelled as a sample wherever it is shown. */
export const SAMPLE_COACHING: SampleCoaching = {
  summary:
    'Second call with Priya about a 7 kW system with battery. Price ($19k after credit) is the objection; the previous $26k quote killed the last conversation. The husband is the co-decider and the deadline is next summer. Priya leaned toward the battery once the evening-rate maths was explained. Next step agreed: side-by-side comparison tonight, call Thursday 10:00.',
  strengths: [
    'Opened on the customer\'s own number ($340 in July) instead of a pitch.',
    'Asked for the timeline and the other decision-maker in one question.',
    'Turned "skip the battery" into a maths explanation rather than a discount.'
  ],
  improvements: [
    'The $19k number landed before the value did — lead with the four-year payback, then the price.',
    'Never asked what the competitor\'s $26k actually included; the comparison would be stronger with it.'
  ],
  nextAction: 'Send the two-option comparison tonight and the Thursday 10:00 invite.',
  tasks: ['Send side-by-side comparison to Priya (tonight)', 'Calendar: Thursday 10:00 follow-up with Priya and her husband']
}

const SEEN_KEY = 'callrise.sampleCall.seen'

export function isSampleCallSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1'
  } catch {
    return false
  }
}

export function markSampleCallSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1')
  } catch {
    /* a private window or a blocked store: the card simply shows again */
  }
}
