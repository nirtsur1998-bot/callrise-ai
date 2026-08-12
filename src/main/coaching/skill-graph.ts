// M23 Workstream A2 — the Skill Graph. Turns one call's existing six-
// dimension rubric score + this module's deterministic benchmarks into 8
// longitudinal skill scores (0–100), and rolls per-call scores across a
// rep's call history into trend lines / streaks for the Progress dashboard
// and the Focus Skill loop (focus-skill.ts).
//
// Deliberately NOT a parallel AI-scoring pass: every skill is either a
// direct read of an existing rubric dimension (discovery/objection/value/
// engagement, already AI-scored and evidence-verified in coach.ts) or a
// deterministic adjustment from this module's own benchmark computations.
// The one skill with no existing analogue (methodology adherence) is scored
// by a small optional addition to coach.ts's SAME AI call — see coach.ts —
// rather than a second round-trip.

import type {
  CoachDimension,
  CoachDimensionKey,
  CoachMetrics,
  CallType,
  MethodologyAssessment,
  SkillKey,
  SkillScoreSet
} from '../calls-fs'
import { SKILL_KEYS } from '../calls-fs'
import {
  DISCOVERY_QUESTION_TARGET,
  MONOLOGUE_FLAG_SECONDS,
  MONOLOGUE_WARN_SECONDS,
  TALK_RATIO_TARGETS,
  type BenchmarkSnapshot,
  type TalkRatioTarget
} from './benchmarks'

/** M25 Phase 3 (L3 procedural memory) — the rep's own personal norms,
 *  computed by memory/personal-benchmarks.ts from their own call history
 *  when Sales Brain is on and there's enough of it (see that module's
 *  MIN_SAMPLE_SIZE floor). Both fields are independently optional and
 *  default to undefined — computeSkillScores() falls back to the exact
 *  population-default behavior for whichever one is absent, so a rep with
 *  Sales Brain off (or too little history yet) sees byte-for-byte the same
 *  scores as before this existed. */
export interface PersonalBenchmarks {
  talkRatioTarget?: TalkRatioTarget
  questionTarget?: { min: number; max: number }
}

export { SKILL_KEYS }

export const SKILL_LABEL: Record<SkillKey, string> = {
  discovery: 'Discovery & questioning',
  listening: 'Listening & talk balance',
  objectionHandling: 'Objection handling',
  valueArticulation: 'Value articulation',
  pricing: 'Pricing conversations',
  momentum: 'Momentum & closing',
  rapport: 'Rapport & tone',
  methodology: 'Methodology adherence'
}

/** Which rubric dimension (if any) each skill is seeded from — used both by
 *  the scorer below and by the Focus Skill loop to find a matching
 *  improvement to reuse as a micro-behavior. */
export const SKILL_SOURCE_DIMENSION: Partial<Record<SkillKey, CoachDimensionKey>> = {
  discovery: 'discovery',
  objectionHandling: 'objection',
  valueArticulation: 'value',
  momentum: 'nextStep',
  rapport: 'engagement'
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function dimensionScore(dims: CoachDimension[], key: CoachDimensionKey): number | null {
  const d = dims.find((x) => x.key === key)
  return d ? d.score * 20 : null // 1–5 rubric -> 0–100 skill scale
}

/** 100 at the target, degrading linearly to 0 at target ± tolerance. */
function distanceScore(value: number, target: number, tolerance: number): number {
  const diff = Math.abs(value - target)
  return Math.round(clamp(100 - (diff / tolerance) * 100, 0, 100))
}

/** -15 once a monologue crosses the flag threshold (90s), a softer -7 in
 *  the warn band leading up to it — same two-stage read as the live
 *  monologue meter's warn/high tone split, applied here to the deterministic
 *  post-call longestMonologueMinutes metric (word-count/pace derived, since
 *  saved transcripts carry no wall-clock timestamp — see benchmarks.ts). */
function monologuePenalty(metrics: CoachMetrics): number {
  const seconds = (metrics.longestMonologueMinutes ?? 0) * 60
  if (seconds >= MONOLOGUE_FLAG_SECONDS) return -15
  if (seconds >= MONOLOGUE_WARN_SECONDS) return -7
  return 0
}

function scoreListening(metrics: CoachMetrics, callType: CallType, personalTarget?: TalkRatioTarget): number {
  if (metrics.talkRatio === null) return 50 // not enough signal — neutral, not a penalty
  const target = personalTarget ?? TALK_RATIO_TARGETS[callType]
  const repPct = metrics.talkRatio * 100
  // Being UNDER target (listening more) is never penalized the way being
  // over target is — a rep who talks less than the ideal share is not
  // failing "listening", so only score the shortfall on the over side.
  const ratioScore = repPct <= target.repTargetPct
    ? 100
    : distanceScore(repPct, target.repTargetPct, target.warnAbovePct - target.repTargetPct)
  return clamp(ratioScore + monologuePenalty(metrics), 0, 100)
}

/** -15..+10, scaled by distance from the 11-14 healthy zone (the brief's
 *  headline discovery-question-COUNT benchmark) — a separate signal from
 *  spread/evenness below; a rep can ask evenly-spread but too FEW questions,
 *  and this term is what catches that. */
function questionCountAdjust(count: number, personalTarget?: { min: number; max: number }): number {
  const { min, max } = personalTarget ?? DISCOVERY_QUESTION_TARGET
  if (count >= min && count <= max) return 10
  const target = count < min ? min : max
  return Math.round(clamp(10 - Math.abs(count - target) * 2, -15, 10))
}

function scoreDiscovery(
  dims: CoachDimension[],
  benchmark: BenchmarkSnapshot,
  personalTarget?: { min: number; max: number }
): number {
  const base = dimensionScore(dims, 'discovery') ?? 50
  // Count and spread are both capped small adjustments — the AI-scored
  // rubric dimension stays the dominant signal; these only refine it.
  const countAdjust = questionCountAdjust(benchmark.questionSpread.count, personalTarget)
  const evenness = benchmark.questionSpread.evenness
  const spreadAdjust = evenness === null ? 0 : Math.round((evenness - 0.5) * 30)
  return clamp(base + countAdjust + spreadAdjust, 0, 100)
}

function scorePricing(benchmark: BenchmarkSnapshot): number {
  const { buyerMentions, latePct } = benchmark.pricing
  // Too few calls mention pricing at all to say anything — neutral, not a
  // penalty (many good discovery calls legitimately never reach pricing).
  if (buyerMentions === 0) return 50
  const countScore =
    buyerMentions >= 3 && buyerMentions <= 4
      ? 100
      : distanceScore(buyerMentions, 3.5, 4) // gentle falloff either side of the healthy zone
  // Timing only matters on genuinely long calls (40+ min) — on a short call
  // "early" pricing talk is often just answering a direct question.
  if (benchmark.durationMinutes < 40 || latePct === null) return countScore
  const timingScore = Math.round(latePct * 100) // more of the mentions in the back half = better
  return Math.round(countScore * 0.6 + timingScore * 0.4)
}

/** A2's "buyer engagement (buyer questions + longest buyer monologue)"
 *  signal — layered on top of the AI-scored engagement/rapport dimension as
 *  a small deterministic nudge. A buyer who asks questions and gets real
 *  airtime reads as genuinely engaged; one who barely speaks and never
 *  asks anything is a real warning sign the base rubric score alone
 *  wouldn't necessarily catch (the rep can still sound warm and attentive
 *  while the buyer stays checked-out). */
function scoreRapport(dims: CoachDimension[], benchmark: BenchmarkSnapshot): number {
  const base = dimensionScore(dims, 'engagement') ?? 50
  const { questionCount, longestMonologueWords } = benchmark.buyerEngagement
  let adjust = 0
  if (questionCount >= 2) adjust += 5
  if (longestMonologueWords >= 40) adjust += 5
  if (questionCount === 0 && longestMonologueWords < 15) adjust -= 5
  return clamp(base + adjust, 0, 100)
}

function scoreMomentum(dims: CoachDimension[], benchmark: BenchmarkSnapshot): number {
  const base = dimensionScore(dims, 'nextStep') ?? 50
  return clamp(base + (benchmark.nextStepsLocked ? 10 : -10), 0, 100)
}

function scoreMethodology(
  dims: CoachDimension[],
  assessment: MethodologyAssessment | undefined
): number {
  if (assessment) return assessment.score * 20
  // No explicit assessment (Coach 2.0 was off, or the model omitted it) —
  // estimate from the two dimensions methodology adherence most overlaps
  // with, so the skill still has SOME reading rather than a hidden zero.
  const discovery = dimensionScore(dims, 'discovery') ?? 50
  const value = dimensionScore(dims, 'value') ?? 50
  return Math.round((discovery + value) / 2)
}

/** The one function everything else in this module builds toward: given a
 *  scored call's rubric dimensions + this module's own benchmark snapshot +
 *  (optionally) the methodology assessment, produce all 8 skill scores. */
export function computeSkillScores(
  dims: CoachDimension[],
  metrics: CoachMetrics,
  benchmark: BenchmarkSnapshot,
  methodologyAdherence?: MethodologyAssessment,
  personal?: PersonalBenchmarks
): SkillScoreSet {
  return {
    discovery: scoreDiscovery(dims, benchmark, personal?.questionTarget),
    listening: scoreListening(metrics, benchmark.callType, personal?.talkRatioTarget),
    objectionHandling: dimensionScore(dims, 'objection') ?? 50,
    valueArticulation: dimensionScore(dims, 'value') ?? 50,
    pricing: scorePricing(benchmark),
    momentum: scoreMomentum(dims, benchmark),
    rapport: scoreRapport(dims, benchmark),
    methodology: scoreMethodology(dims, methodologyAdherence)
  }
}

// --- Longitudinal rollup (Progress dashboard + Focus Skill loop) ----------

export interface SkillHistoryPoint {
  callId: string
  createdAt: string
  score: number
}

export interface SkillProgress {
  key: SkillKey
  /** Chronological, oldest first. */
  history: SkillHistoryPoint[]
  current: number | null
  trend: 'up' | 'down' | 'flat' | null
  /** Consecutive most-recent calls scoring at/above SKILL_TARGET — the
   *  "sustained improvement" signal the Focus Skill loop rotates on. */
  streakAboveTarget: number
}

/** A skill reads as "on target" for streak/rotation purposes above this. */
export const SKILL_TARGET = 80

const TREND_WINDOW = 3

/** Always a BALANCED recent-vs-prior comparison, sized down from
 *  TREND_WINDOW (3) when there isn't enough history for a full 3-vs-3 yet —
 *  e.g. 1-vs-1 at length 2-3, 2-vs-2 at length 4-5, a full 3-vs-3 from
 *  length 6 on. Never compares a 3-point recent average against a lone
 *  earliest data point. */
function trendFor(history: SkillHistoryPoint[]): 'up' | 'down' | 'flat' | null {
  const windowSize = Math.min(TREND_WINDOW, Math.floor(history.length / 2))
  if (windowSize === 0) return null
  const recent = history.slice(-windowSize)
  const prior = history.slice(-2 * windowSize, -windowSize)
  const avg = (pts: SkillHistoryPoint[]): number =>
    pts.reduce((s, p) => s + p.score, 0) / pts.length
  const delta = avg(recent) - avg(prior)
  if (delta > 3) return 'up'
  if (delta < -3) return 'down'
  return 'flat'
}

function streakAboveTarget(history: SkillHistoryPoint[]): number {
  let streak = 0
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].score < SKILL_TARGET) break
    streak++
  }
  return streak
}

/** Pure rollup — the caller (main-process IPC layer) is responsible for
 *  fetching the actual calls; this just turns "calls with a skills set,
 *  oldest first or not" into the per-skill trend/streak view. */
export function computeSkillProgress(
  calls: Array<{ id: string; createdAt: string; skills?: SkillScoreSet }>
): SkillProgress[] {
  const scored = calls
    .filter((c): c is { id: string; createdAt: string; skills: SkillScoreSet } => !!c.skills)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  return SKILL_KEYS.map((key) => {
    const history = scored.map((c) => ({ callId: c.id, createdAt: c.createdAt, score: c.skills[key] }))
    return {
      key,
      history,
      current: history.length ? history[history.length - 1].score : null,
      trend: trendFor(history),
      streakAboveTarget: streakAboveTarget(history)
    }
  })
}

/** A coarse, encouraging label for "current level" on the Progress
 *  dashboard — deliberately not a percentile or anything comparative. */
export function skillLevelLabel(score: number | null): string {
  if (score === null) return 'Not enough data yet'
  if (score >= 85) return 'Advanced'
  if (score >= 70) return 'Proficient'
  if (score >= 50) return 'Developing'
  return 'Early'
}
