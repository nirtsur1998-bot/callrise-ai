// Deal Health Score (M24 §4) — Tier 2's output shape plus the one piece of
// it that's deliberately NOT asked of the model: trajectory. An LLM call has
// no memory between calls on this call's own history, so "is this trending
// up or down" is answered by comparing this score to the PREVIOUS one
// client-side (computeTrajectory below), not by asking the model to
// self-report a trend it cannot actually observe.

export interface HealthFactors {
  engagement: number
  sentiment: number
  objectionStatus: number
  momentum: number
  agendaCoverage: number
}

export type HealthTrajectory = 'up' | 'flat' | 'down'

export interface DealHealthScore {
  score: number
  trajectory: HealthTrajectory
  factors: HealthFactors
  topRecommendation: string
  computedAtMs: number
}

/** Smaller than it looks: two Tier 2 passes 2-3 minutes apart on a real call
 *  naturally drift a couple of points on noise alone (the model re-reads a
 *  slightly different transcript window each time) — a trajectory arrow that
 *  flips on every 1-point wobble would be worse than useless, since it would
 *  train the rep to ignore it within the first two updates. */
const TRAJECTORY_DEADBAND = 4

export function computeTrajectory(current: number, previous: number | null): HealthTrajectory {
  if (previous === null) return 'flat'
  const delta = current - previous
  if (delta > TRAJECTORY_DEADBAND) return 'up'
  if (delta < -TRAJECTORY_DEADBAND) return 'down'
  return 'flat'
}

function clamp0to100(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0
}

/** Defense in depth against a malformed tool call, same posture as
 *  deal-tier1.ts's sanitizeSignals — never trust the shape blindly just
 *  because the schema asked for it. Returns null (not a zeroed-out score)
 *  on anything unusable, so the caller can keep showing the LAST good score
 *  rather than flash a fake "0/100, everything is terrible" reading. */
export function sanitizeHealthScoreResponse(
  value: unknown,
  computedAtMs: number,
  previousScore: number | null
): DealHealthScore | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.score !== 'number' || !Number.isFinite(v.score)) return null

  const f = (v.factors && typeof v.factors === 'object' ? v.factors : {}) as Record<string, unknown>
  const topRecommendation =
    typeof v.topRecommendation === 'string' ? v.topRecommendation.trim().slice(0, 300) : ''
  if (!topRecommendation) return null

  const score = clamp0to100(v.score)
  return {
    score,
    trajectory: computeTrajectory(score, previousScore),
    factors: {
      engagement: clamp0to100(f.engagement),
      sentiment: clamp0to100(f.sentiment),
      objectionStatus: clamp0to100(f.objectionStatus),
      momentum: clamp0to100(f.momentum),
      agendaCoverage: clamp0to100(f.agendaCoverage)
    },
    topRecommendation,
    computedAtMs
  }
}
