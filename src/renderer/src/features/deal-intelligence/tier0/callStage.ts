// Detected call stage (M24 §1) — a coarse heuristic (elapsed time, keyword
// spotting, objection presence), not a real classifier. Good enough to seed
// the field and to let Coaching Cues 2.0 be "stage-aware" from Phase 1 on;
// Tier 1/2 (Phase 2/3) can override it with actual judgement once they
// exist. Once a call reads as 'closing' it stays 'closing' — deals don't
// usually un-close, and a late objection shouldn't visually reset the stage
// back to 'objections' after the conversation has clearly moved to wrap-up.

import type { CallStage, LiveCallState, LiveTurn } from '../types'

const CLOSING_KEYWORDS = [
  'next steps',
  'contract',
  'sign',
  'move forward',
  'get started',
  'proposal',
  'pricing page'
]
const DEMO_KEYWORDS = ['let me show you', 'screen share', 'walk you through', 'demo', 'feature']

export function detectCallStage(state: LiveCallState, turn: LiveTurn): CallStage {
  if (state.callStage === 'closing') return 'closing'

  const lower = turn.text.toLowerCase()
  if (CLOSING_KEYWORDS.some((k) => lower.includes(k))) return 'closing'

  const elapsedMin = (turn.atMs - state.callStartedAtMs) / 60_000
  if (elapsedMin < 2 && state.objections.length === 0) return 'opening'

  if (DEMO_KEYWORDS.some((k) => lower.includes(k))) return 'demo-pitch'
  if (state.objections.length > 0) return 'objections'
  if (state.callStage === 'demo-pitch') return 'demo-pitch'

  return 'discovery'
}
