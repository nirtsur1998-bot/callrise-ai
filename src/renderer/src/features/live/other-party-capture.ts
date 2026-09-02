/**
 * M32 Stage 3b — the one fact every live instrument needs and none of them read.
 *
 * THE FINDING THIS EXISTS FOR, stated as one thing rather than as three bugs:
 * **no live instrument knew whether the other party was actually observable**,
 * and that produced three separate wrong behaviours on the same screen (Stage
 * 3a Findings 1, 2 and 3). It is a plumbing gap, not three defects: the
 * evidence was already there per turn and simply never reached the
 * instruments. `monologue.ts`'s own `Turn` did not even carry `channel`.
 *
 * So it lives here, in one place, rather than being re-derived at each call
 * site. **Any instrument added to the live screen must consult this before
 * scoring, judging or accusing** — otherwise it inherits the same bug, which is
 * exactly how this one reached three instruments.
 *
 * ── THE RULE, AND THE MISTAKE IT ALREADY SURVIVED ───────────────────────────
 *
 * The first version of this asked only "does any turn carry a channel?" — i.e.
 * is the multichannel path running. **That was wrong, and six existing
 * monologue tests caught it**, because a MONO stream can still contain both
 * sides: a speakerphone, or the rep's own mic picking the buyer up in the room.
 * Deepgram then diarizes two speakers with no channel on either. Suppressing
 * the instruments there would blind them on calls that are working fine.
 *
 * The honest question is not "is multichannel running" but **"can we see the
 * other side at all?"**, and there are two independent ways to see it:
 *
 *   1. a channel assignment on any turn — the multichannel path attributing
 *      sides to real audio; or
 *   2. more than one distinct diarized speaker — the other side is in the
 *      transcript even without channels.
 *
 * Only when NEITHER holds is the situation undecidable: one voice, no channels,
 * and no way to tell *"the buyer said nothing"* from *"the buyer was never
 * recorded"*. That is the state in which no instrument may produce a number.
 *
 * WHY NOT "is buyer capture switched on". A toggle says what was INTENDED.
 * BUG-172 was six weeks of the app believing capture was on while producing a
 * mono stream, so intent is exactly the wrong signal here. This reads evidence.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not require a turn on channel 1.
 * A call where channels exist but only channel 0 ever speaks is a **quiet
 * buyer** — real information, and the instruments should judge it. Requiring
 * channel 1 would suppress the gauge on every call where the buyer said little,
 * which is the mirror-image mistake, and the same one
 * `otherPartyPromisedButMissing` avoids in the call-detail marker.
 */

/** The minimal shape needed. Both live `Turn` types satisfy it. */
export interface TurnEvidence {
  speaker: number
  channel?: number
}

/**
 * Can the other party be observed on this call at all?
 *
 * True when either a channel assignment exists (multichannel attributing
 * sides) or more than one speaker has been diarized (both sides present in a
 * mono stream). False when there is one voice and no channels — where nothing
 * distinguishes a silent buyer from an unrecorded one.
 *
 * Also false for an empty buffer: at the start of a call nothing is known yet,
 * and the instruments have their own minimum-evidence gates for that window.
 */
export function otherPartyObservable(turns: ReadonlyArray<TurnEvidence>): boolean {
  if (turns.length === 0) return false
  if (turns.some((t) => t.channel === 0 || t.channel === 1)) return true
  return new Set(turns.map((t) => t.speaker)).size > 1
}
