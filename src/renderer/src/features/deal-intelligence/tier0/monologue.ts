// Longest-rep-monologue timer (M24 §2 — "monologue > 90s").
//
// Adapts features/live/monologue.ts's MonologueTracker (which re-scans a
// full turn buffer on every call) into an incremental streaming version: one
// turn folds in O(1) rather than re-walking history, which is what a
// per-turn engine reducer wants. Same semantics — "uninterrupted" is
// measured by TURNS, not silence, so a pause for breath mid-monologue never
// resets the clock, only the other side actually getting a turn in does.

import type { LiveCallState, LiveTurn, Tier0Signal } from '../types'

const DEFAULT_MONOLOGUE_THRESHOLD_MS = 90_000

export function detectMonologue(
  state: LiveCallState,
  turn: LiveTurn,
  previousRole: LiveTurn['role'] | null,
  config: { monologueThresholdMs: number }
): { patch: Partial<LiveCallState>; signals: Tier0Signal[] } {
  const threshold = config.monologueThresholdMs ?? DEFAULT_MONOLOGUE_THRESHOLD_MS

  if (turn.role !== 'rep' || state.repSpeaker === null) {
    // The floor just changed hands (or nobody's identified as rep yet) — the
    // run is over regardless of how it ended.
    return {
      patch: { repMonologueStartAtMs: null, currentRepMonologueMs: 0 },
      signals: []
    }
  }

  const runStartAtMs =
    previousRole === 'rep' && state.repMonologueStartAtMs !== null
      ? state.repMonologueStartAtMs
      : turn.atMs
  const currentRepMonologueMs = Math.max(0, turn.atMs - runStartAtMs)
  const longestRepMonologueMs = Math.max(state.longestRepMonologueMs, currentRepMonologueMs)

  const signals: Tier0Signal[] = []
  // Edge-triggered: fire once on the turn that crosses the threshold, not on
  // every subsequent rep turn while the monologue continues.
  if (currentRepMonologueMs >= threshold && state.currentRepMonologueMs < threshold) {
    signals.push({
      type: 'long-monologue',
      atMs: turn.atMs,
      evidence: [{ role: turn.role, text: turn.text, atMs: turn.atMs }],
      detail: `Rep has held the floor for ${Math.round(currentRepMonologueMs / 1000)}s`
    })
  }

  return {
    patch: { repMonologueStartAtMs: runStartAtMs, currentRepMonologueMs, longestRepMonologueMs },
    signals
  }
}
