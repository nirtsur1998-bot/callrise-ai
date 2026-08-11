// M23 Workstream A4 — the Focus Skill loop. Deliberate-practice coaching:
// pick ONE skill + one concrete micro-behavior to work on, keep it stable
// across calls until the rep has actually improved, then rotate.
//
// No extra AI call here either: the micro-behavior text is reused from
// coach.ts's own existing "mechanical" improvement (already tied to a
// verified transcript quote, per A5's evidence requirement) when its
// dimension matches the selected skill, and otherwise falls back to a
// small curated template per skill.

import { SKILL_KEYS, type CoachImprovement, type CoachingReport, type SkillKey } from '../calls-fs'
import { SKILL_LABEL, SKILL_SOURCE_DIMENSION, type SkillProgress } from './skill-graph'

/** Consecutive calls at/above SKILL_TARGET before the loop rotates away
 *  from the current focus — "sustained," not a single good call. */
export const ROTATE_AFTER_STREAK = 3

export interface FocusSkillState {
  skill: SkillKey
  microBehavior: string
  /** ISO — when this focus was (re)selected. */
  since: string
  /** The call whose improvement text the micro-behavior was drawn from, if any. */
  sourceCallId?: string
}

const MICRO_BEHAVIORS: Record<SkillKey, string[]> = {
  discovery: [
    'Ask 3 implication questions ("what happens if this doesn’t get solved?") before presenting any solution.',
    'After every buyer answer, ask one follow-up "why" or "how" before moving to your next question.'
  ],
  listening: [
    'After you finish a point, stop talking and count to 3 before continuing.',
    'Trade one talking point for one open question this call.'
  ],
  objectionHandling: [
    'When an objection comes up, restate it back in your own words before responding.',
    'Ask "is that the only thing holding you back?" after handling the first objection.'
  ],
  valueArticulation: [
    'Tie your very next feature mention to the specific pain the buyer already told you about.',
    'Replace one generic feature statement with a quantified outcome ("saves X hours/week").'
  ],
  pricing: [
    'Hold pricing until you’ve confirmed the buyer’s stated pain out loud at least once.',
    'When pricing comes up, ask one clarifying question about budget before quoting a number.'
  ],
  momentum: [
    'End the call by proposing a specific date out loud, not "I’ll follow up."',
    'Confirm the next step back to the buyer in one sentence before hanging up.'
  ],
  rapport: [
    'Reflect back one thing the buyer said, in their own words, before responding to it.',
    'Ask one non-business question naturally in the first two minutes.'
  ],
  methodology: [
    'Before the call ends, make sure you’ve identified who the economic buyer is.',
    'Explicitly surface the buyer’s decision-making process before proposing next steps.'
  ]
}

/** Deterministic pick from the template list — cycles by call count so
 *  repeated focus periods on the same skill don't always show the same
 *  line, without needing randomness (which workflow/test determinism here
 *  deliberately avoids). */
function templateMicroBehavior(skill: SkillKey, seed: number): string {
  const options = MICRO_BEHAVIORS[skill]
  return options[seed % options.length]
}

/**
 * Prefer THIS call's own mechanical improvement over a generic template —
 * reuses an already-evidence-verified quote, matching A5's "cite quoted
 * evidence" rule. NOTE: coach.ts produces exactly ONE mechanical
 * improvement per call (not one per dimension/skill), and CoachImprovement
 * carries no dimension tag to match against — so this can't verify the
 * improvement is actually ABOUT the selected skill. In practice the AI's
 * one mechanical improvement usually targets whatever it judged weakest,
 * which correlates well with a newly-rotated-into focus skill; still, only
 * reach for it on skills that map to a rubric dimension at all (via
 * SKILL_SOURCE_DIMENSION) — a skill with no dimension analogue (pricing,
 * methodology) is more likely to get a mismatched suggestion, so those
 * always use the curated template instead.
 */
function microBehaviorFor(skill: SkillKey, report: CoachingReport, seed: number): string {
  if (SKILL_SOURCE_DIMENSION[skill]) {
    const match = report.improvements.find(
      (imp: CoachImprovement) => imp.kind === 'mechanical' && imp.evidence
    )
    if (match) return match.title
  }
  return templateMicroBehavior(skill, seed)
}

/** Pick the lowest-scoring skill with enough history to be meaningful — the
 *  skill most worth deliberate practice right now. Ties broken by skill
 *  order (stable, not random). */
function lowestSkill(progress: SkillProgress[]): SkillKey {
  const withScores = progress.filter((p) => p.current !== null)
  const pool = withScores.length ? withScores : progress
  // SKILL_KEYS always has 8 entries, so today's one caller (computeSkillProgress's
  // output) can never produce an empty pool — but this is an exported pure
  // function with no guard on its input, so fail safe rather than throw.
  if (pool.length === 0) return SKILL_KEYS[0]
  let lowest = pool[0]
  for (const p of pool) {
    if ((p.current ?? 100) < (lowest.current ?? 100)) lowest = p
  }
  return lowest.key
}

/**
 * The core of the loop: keep the current focus unless it has shown
 * sustained improvement (ROTATE_AFTER_STREAK consecutive calls at/above
 * SKILL_TARGET), in which case rotate to whichever skill is now lowest.
 * Always returns a fresh micro-behavior string tied to the LATEST call, even
 * when the skill itself doesn't change, so the reminder stays concrete
 * rather than going stale.
 */
export function selectFocusSkill(
  progress: SkillProgress[],
  current: FocusSkillState | null,
  latestReport: CoachingReport,
  latestCallId: string,
  nowIso: string
): FocusSkillState {
  const currentProgress = current ? progress.find((p) => p.key === current.skill) : undefined
  const shouldRotate =
    !current || !currentProgress || currentProgress.streakAboveTarget >= ROTATE_AFTER_STREAK

  const skill = shouldRotate ? lowestSkill(progress) : current!.skill
  const seed = progress.find((p) => p.key === skill)?.history.length ?? 0

  return {
    skill,
    microBehavior: microBehaviorFor(skill, latestReport, seed),
    since: shouldRotate ? nowIso : current!.since,
    sourceCallId: latestCallId
  }
}

export function focusSkillLabel(skill: SkillKey): string {
  return SKILL_LABEL[skill]
}
