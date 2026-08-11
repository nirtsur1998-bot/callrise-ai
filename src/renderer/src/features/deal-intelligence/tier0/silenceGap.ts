// Silence > 8s after a rep question (M24 §2).
//
// Turn-triggered, not clock-triggered: Phase 1 has no periodic tick, so this
// detects silence RETROACTIVELY, the moment the next turn (from either side)
// finally breaks it — not live, mid-silence. A future phase that wires this
// into a real call can add an engine.tick(nowMs) call on an interval if
// catching the silence AS it crosses 8s (rather than after) turns out to
// matter; Phase 1 doesn't need it since the Call Simulator replays a fixed
// transcript where every gap is already known in advance.

import type { LiveCallState, LiveTurn, Tier0Signal } from '../types'
import { RECENT_GAPS_CAP } from '../types'

function isQuestion(text: string): boolean {
  return text.trim().endsWith('?')
}

export function detectSilenceGap(
  state: LiveCallState,
  turn: LiveTurn,
  gapMs: number,
  config: { silenceAfterQuestionThresholdMs: number }
): { patch: Partial<LiveCallState>; signals: Tier0Signal[] } {
  const signals: Tier0Signal[] = []

  if (state.pendingRepQuestion && gapMs > config.silenceAfterQuestionThresholdMs) {
    signals.push({
      type: 'silence-after-question',
      atMs: turn.atMs,
      evidence: [
        state.pendingRepQuestion.evidence,
        { role: turn.role, text: turn.text, atMs: turn.atMs }
      ],
      detail: `${Math.round(gapMs / 1000)}s of silence after the rep's question`
    })
  }

  const pendingRepQuestion =
    turn.role === 'rep' && isQuestion(turn.text)
      ? { evidence: { role: turn.role, text: turn.text, atMs: turn.atMs } }
      : null

  const recentSilenceGapsMs = [...state.recentSilenceGapsMs, gapMs].slice(-RECENT_GAPS_CAP)

  return { patch: { pendingRepQuestion, recentSilenceGapsMs }, signals }
}
