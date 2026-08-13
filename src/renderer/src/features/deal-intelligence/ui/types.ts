// Data contract for Live Deal Intelligence — owned by the orchestrating
// session's engine/data layer (see ../nudgeEngine.ts and ../types.ts), fixed
// by the design brief and reproduced verbatim here. This file exists so the
// UI layer has one canonical import for the shape it renders, independent of
// wherever the engine's own internal types end up settling — a presentational
// panel breaking because an unrelated engine refactor renamed something would
// be a needless coupling for a component that never reads the engine at all.

export type NudgeType = 'risk' | 'opportunity' | 'tactical'

export interface Nudge {
  id: string
  type: NudgeType
  /** Free-form classification, e.g. "price-objection", "buying-signal", "stalling". */
  subtype: string
  /** 0..1 — how confident the AI was. Every nudge here already cleared the
   *  engine's quality bar, so this is for DISPLAY, never for filtering. */
  confidence: number
  /** The exact quote from the transcript that triggered this — evidence-
   *  transparency is a core product requirement, not an optional detail. */
  evidenceQuote: string
  evidenceRole: 'rep' | 'other'
  /** One short, actionable sentence — what the rep should actually do/say. */
  suggestedCue: string
  createdAtMs: number
}

/** BUG-057 Phase 2 — 'timed-out' added, distinct from 'paused'. A
 *  HARD_CEILING_MS timeout is a live, responding provider that was just too
 *  slow; 'paused' means every configured model is unreachable or
 *  rate-limited. Kept as separate union members (not folded into 'paused')
 *  because every Record<DealIntelligenceStatus, ...> lookup below is
 *  exhaustive — the compiler forces every consumer to decide what this
 *  status looks like rather than silently inheriting 'paused''s copy. */
export type DealIntelligenceStatus = 'idle' | 'active' | 'paused' | 'timed-out'

// Tier 2's output shape — a slower (every 2-3 minutes), whole-call read that
// sits alongside the Tier 1 nudges above rather than replacing them. Mirrored
// verbatim from ../healthScore.ts per this file's own boundary above: the
// engine's `computeTrajectory`/`sanitizeHealthScoreResponse` logic never
// belongs here, only the shape.

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

export interface DealIntelligencePanelProps {
  /** false = beta toggle is off; render nothing. */
  enabled: boolean
  /** 'idle' = call not started / engine warming up. 'active' = normal
   *  operation, watching. 'paused' = the AI provider chain failed — degrade
   *  gracefully, never error, mirrors the app's existing "coaching paused"
   *  pattern elsewhere in the live view. */
  status: DealIntelligenceStatus
  /** Already gated/prioritized/deduped by the Nudge Engine — exactly what
   *  should be visible right now, most important/newest first. Typically
   *  0-3 items; the engine caps total cues per call, so this is never large. */
  nudges: Nudge[]
  onDismiss: (id: string) => void
  /** Optional per-nudge thumbs up/down, used later to tune engine sensitivity. */
  onFeedback?: (id: string, helpful: boolean) => void
  /** Latest Tier 2 health-score pass, or null if none has completed yet for
   *  this call. null renders nothing extra — never a placeholder or a zeroed
   *  score, which would misrepresent "no read yet" as "read: terrible." */
  healthScore: DealHealthScore | null
}
