// M25 Sales Brain Phase 3 — L3 PROCEDURAL MEMORY (spec section 1): "the
// user's own talk-ratio/question-count/monologue norms vs the research
// defaults." Deliberately NOT stored as L2 semantic-memory rows in
// memory.db — this is a statistical computation over data that already
// exists (past coached calls' own metrics, in calls-fs.ts), not an
// AI-extracted fact needing evidence/verification the way L2 memories do.
// Storing a redundant copy of numbers that already live on each call record
// would just be a second source of truth to keep in sync. Pure functions,
// no Electron/DB import — the caller (calls.ts) gathers the raw samples
// from calls-fs.ts and hands them here.
import type { TalkRatioTarget } from '../coaching/benchmarks'

/** Never overrides the research-backed population default with too small a
 *  sample — a rep's first few calls could easily be unrepresentative
 *  outliers, and "confidently wrong" personalization is worse than
 *  accurate population defaults. */
export const MIN_SAMPLE_SIZE = 5

export interface TalkRatioSample {
  talkRatio: number | null
}

/** Personal talk-ratio target: the rep's own average share of talk time on
 *  their past calls of the SAME call type (comparing a rep's cold-call
 *  ratio against their own discovery-call history would be comparing two
 *  different kinds of conversation). Returns null (→ caller falls back to
 *  the population TALK_RATIO_TARGETS default) when there's no personalization
 *  info: fewer than MIN_SAMPLE_SIZE calls with a real talk ratio for this
 *  call type. `warnAbovePct` is kept from the population default's own
 *  MARGIN above target (not re-derived from personal variance, which would
 *  need a much bigger sample to be meaningful) — only the target itself
 *  personalizes. */
export function computePersonalTalkRatioTarget(
  samples: TalkRatioSample[],
  populationDefault: TalkRatioTarget
): TalkRatioTarget | null {
  const ratios = samples.map((s) => s.talkRatio).filter((r): r is number => r !== null)
  if (ratios.length < MIN_SAMPLE_SIZE) return null

  const personalAvgPct = (ratios.reduce((sum, r) => sum + r, 0) / ratios.length) * 100
  const margin = populationDefault.warnAbovePct - populationDefault.repTargetPct
  return { repTargetPct: Math.round(personalAvgPct), warnAbovePct: Math.round(personalAvgPct + margin) }
}

export interface QuestionCountSample {
  count: number
}

/** Personal discovery-question-count target — same MIN_SAMPLE_SIZE floor
 *  and same-call-type-only comparison as the talk-ratio target above. The
 *  personal "healthy zone" is a narrow band around the rep's own median,
 *  not their full range (a wide range would make almost every call count
 *  as "on target", defeating the point of a benchmark at all). */
export function computePersonalQuestionTarget(
  samples: QuestionCountSample[]
): { min: number; max: number } | null {
  if (samples.length < MIN_SAMPLE_SIZE) return null
  const counts = [...samples.map((s) => s.count)].sort((a, b) => a - b)
  const median = counts[Math.floor(counts.length / 2)]
  return { min: Math.max(0, median - 2), max: median + 2 }
}
