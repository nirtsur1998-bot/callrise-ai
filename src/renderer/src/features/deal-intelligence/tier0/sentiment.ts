// Rolling sentiment trajectory (M24 §1) — a coarse Tier 0 keyword-lexicon
// estimate, tracked on the BUYER's turns only (deal sentiment is about their
// disposition, not the rep's). This is deliberately crude: real sentiment
// needs a model, which is Tier 1/2 territory (Phase 2/3). Phase 1 exists so
// LiveCallState.sentimentTrajectory has real data plumbed through it from
// day one, not a TODO — Tier 1/2 can refine or override individual points
// later without a shape change.

import type { LiveCallState, LiveTurn, Tier0Signal } from '../types'
import { SENTIMENT_TRAJECTORY_CAP } from '../types'

const POSITIVE_WORDS = [
  'great',
  'love',
  'excited',
  'perfect',
  'awesome',
  'fantastic',
  'definitely',
  'impressed',
  'helpful',
  'makes sense'
]
const NEGATIVE_WORDS = [
  'expensive',
  'concerned',
  'worried',
  'not sure',
  'frustrated',
  'disappointed',
  'complicated',
  'hesitant',
  'skeptical'
]

function score(text: string): number {
  const lower = text.toLowerCase()
  let hits = 0
  for (const w of POSITIVE_WORDS) if (lower.includes(w)) hits += 1
  for (const w of NEGATIVE_WORDS) if (lower.includes(w)) hits -= 1
  return Math.max(-1, Math.min(1, hits / 3))
}

export function detectSentiment(
  state: LiveCallState,
  turn: LiveTurn
): { patch: Partial<LiveCallState>; signals: Tier0Signal[] } {
  if (turn.role !== 'other') return { patch: {}, signals: [] }

  const s = score(turn.text)
  if (s === 0) return { patch: {}, signals: [] } // a neutral turn adds no information — don't dilute the trend with it

  const sentimentTrajectory = [...state.sentimentTrajectory, { atMs: turn.atMs, score: s }].slice(
    -SENTIMENT_TRAJECTORY_CAP
  )
  return { patch: { sentimentTrajectory }, signals: [] }
}
