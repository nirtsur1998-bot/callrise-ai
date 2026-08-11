// Talk-time ratio + interruption count (M24 §2).
//
// Reuses features/live/monologue.ts's proven approach: word counts as the
// talk-time proxy (deterministic, nothing beyond data already on hand), and
// no opinion offered until there's enough said to mean anything. An
// "interruption" here means the same thing MonologueTracker's reset does —
// the other side getting in after a rep turn, or vice versa — counted, not
// timed.

import type { LiveCallState, LiveTurn, Tier0Signal } from '../types'

const MIN_WORDS_FOR_RATIO = 40
const HIGH_TALK_RATIO = 0.65

function countWords(text: string): number {
  const m = text.trim().match(/\S+/g)
  return m ? m.length : 0
}

/**
 * `previousRole` is the role of the turn immediately before this one —
 * passed in explicitly (engine.ts captures it before any extractor runs)
 * rather than read off `state.lastTurnRole`, because multiple extractors
 * need "what was the previous turn" and only the first one to run may see
 * an unmutated value if each wrote its own answer back into the patch.
 */
export function detectTalkRatio(
  state: LiveCallState,
  turn: LiveTurn,
  previousRole: LiveTurn['role'] | null
): { patch: Partial<LiveCallState>; signals: Tier0Signal[] } {
  if (turn.role === 'unknown') return { patch: {}, signals: [] }

  const words = countWords(turn.text)
  const talkWords = {
    rep: state.talkWords.rep + (turn.role === 'rep' ? words : 0),
    other: state.talkWords.other + (turn.role === 'other' ? words : 0)
  }

  const total = talkWords.rep + talkWords.other
  const talkRatio =
    state.repSpeaker === null || total < MIN_WORDS_FOR_RATIO ? null : talkWords.rep / total

  const interruptionCount =
    previousRole !== null && previousRole !== turn.role
      ? state.interruptionCount + 1
      : state.interruptionCount

  const signals: Tier0Signal[] = []
  // Only fire the moment the ratio CROSSES into lopsided, not on every turn
  // while it stays there — a repeated nudge for the same ongoing condition
  // is exactly the spam Coaching Cues 2.0 is trying to avoid.
  if (
    talkRatio !== null &&
    talkRatio > HIGH_TALK_RATIO &&
    (state.talkRatio === null || state.talkRatio <= HIGH_TALK_RATIO)
  ) {
    signals.push({
      type: 'talk-ratio-skewed',
      atMs: turn.atMs,
      evidence: [{ role: turn.role, text: turn.text, atMs: turn.atMs }],
      detail: `Rep talk share crossed ${Math.round(HIGH_TALK_RATIO * 100)}%`
    })
  }

  return {
    patch: { talkWords, talkRatio, interruptionCount },
    signals
  }
}
