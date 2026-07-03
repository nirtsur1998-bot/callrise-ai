// Turns raw aggregated numbers into MEANING: a health tone (green/amber/red)
// and a plain-English, non-technical sentence. All deterministic if/else — no
// LLM, instant and offline. The Tone vocabulary is reused from the coaching
// screen so Analytics matches it (good=emerald, mid=amber, low=rose).

import type { Tone } from '@renderer/features/coaching/meta'
import type { CoachDimensionKey } from '@renderer/features/coaching/types'
import type { Analytics, DimensionTrend, ImproveArea, Granularity, PeriodBucket } from './aggregate'

/** Below this many coached calls (or tasks), caveat the metric as "early days". */
export const THIN_DATA = 3

// --- Health tones (the thresholds from the plan) ----------------------------

/** Talk ratio: green 40–55%, amber 30–40% / 55–65%, red <30% or >65%. */
export function talkRatioTone(ratio: number): Tone {
  if (ratio < 0.3 || ratio > 0.65) return 'low'
  if (ratio < 0.4 || ratio > 0.55) return 'mid'
  return 'good'
}

/** Coaching skill (1–5 average): green ≥4, amber 2.5–4, red <2.5. */
export function skillTone(avg: number): Tone {
  if (avg >= 4) return 'good'
  if (avg >= 2.5) return 'mid'
  return 'low'
}

/** Task completion: green ≥70%, amber 40–70%, red <40%. */
export function completionTone(rate: number): Tone {
  if (rate >= 0.7) return 'good'
  if (rate >= 0.4) return 'mid'
  return 'low'
}

function severityOf(tone: Tone): number {
  return tone === 'low' ? 2 : tone === 'mid' ? 1 : 0
}

// --- Per-skill friendly copy ------------------------------------------------

interface SkillCopy {
  /** Casual gerund phrase for "Your weak spot: {phrase}". */
  phrase: string
  /** A concrete next-call action. */
  action: string
  /** Short clause for the screen headline ("Your biggest opportunity: {clause}"). */
  headline: string
}

const SKILL_COPY: Record<CoachDimensionKey, SkillCopy> = {
  discovery: {
    phrase: "digging into the buyer's real needs",
    action: 'Ask more open questions about their problems before you start pitching.',
    headline: "dig into the buyer's real needs before pitching."
  },
  engagement: {
    phrase: "showing the buyer you're listening",
    action: 'Reflect back what they say in your own words so they feel heard.',
    headline: "show the buyer you're really listening."
  },
  objection: {
    phrase: 'handling concerns head-on',
    action: 'Invite objections and address them directly instead of glossing over them.',
    headline: 'tackle concerns head-on instead of glossing over them.'
  },
  value: {
    phrase: 'connecting your pitch to their situation',
    action: 'Tie your solution to their specific goals, not generic features.',
    headline: "connect your pitch to each buyer's specific situation."
  },
  nextStep: {
    phrase: 'locking down clear next steps',
    action: 'Aim to end every call with a specific date booked.',
    headline: 'lock down clear next steps at the end of calls.'
  },
  control: {
    phrase: 'steering the call',
    action: 'Set an agenda up front and keep the conversation on track.',
    headline: 'steer your calls with a clear agenda.'
  }
}

// --- Card verdicts ----------------------------------------------------------

export function talkRatioVerdict(ratio: number): string {
  if (ratio > 0.65) return "You're dominating calls — try to talk less and listen more."
  if (ratio > 0.55) return "You're talking a bit more than ideal — leave more room for the buyer."
  if (ratio >= 0.4) return "Nicely balanced — you're listening about as much as you talk."
  if (ratio >= 0.3)
    return "You're listening a lot — it's fine to steer the conversation a bit more."
  return "You're very quiet on calls — speak up and guide the conversation more."
}

/** A one-line "what to do" for a single weak skill. */
export function skillAction(key: CoachDimensionKey): string {
  return SKILL_COPY[key].action
}

export function weakSpotPhrase(key: CoachDimensionKey): string {
  return SKILL_COPY[key].phrase
}

export function completionVerdict(rate: number): string {
  if (rate >= 0.7) return "You're closing out most of your follow-ups — nice follow-through."
  if (rate >= 0.4)
    return "You're acting on about half your follow-ups — try to close more of them out."
  return 'Lots of follow-ups are slipping through — try to knock out more of your tasks.'
}

/** A neutral, informational summary of call volume (volume is never graded). */
export function activitySummary(
  buckets: PeriodBucket[],
  granularity: Granularity,
  totalCalls: number
): string {
  const unit = granularity === 'week' ? 'week' : 'month'
  const span =
    buckets.length > 1 ? ` across the last ${buckets.length} ${unit}s` : ` in the last ${unit}`
  let base = `You've logged ${totalCalls} call${totalCalls === 1 ? '' : 's'}${span}.`

  if (buckets.length >= 2) {
    const prior = buckets.slice(0, -1)
    const last = buckets[buckets.length - 1].count
    const priorAvg = prior.reduce((sum, b) => sum + b.count, 0) / prior.length
    if (priorAvg > 0 && last > priorAvg * 1.1) base += " You're picking up the pace lately."
    else if (priorAvg > 0 && last < priorAvg * 0.9)
      base += ' Things have been a bit quieter lately.'
  }
  return base
}

/** Strongest / weakest skill labels for the skills-card orientation line. */
export function strongestWeakest(dimensions: DimensionTrend[]): {
  strongest: CoachDimensionKey | null
  weakest: CoachDimensionKey | null
} {
  const scored = dimensions.filter(
    (d): d is DimensionTrend & { average: number } => d.average !== null
  )
  if (scored.length === 0) return { strongest: null, weakest: null }
  let hi = scored[0]
  let lo = scored[0]
  for (const d of scored) {
    if (d.average > hi.average) hi = d
    if (d.average < lo.average) lo = d
  }
  return { strongest: hi.key, weakest: lo.key }
}

/** The 1–2 areas worth improving — i.e. the lowest skills that aren't green. */
export function focusAreas(improve: ImproveArea[]): ImproveArea[] {
  return improve.filter((a) => skillTone(a.average) !== 'good')
}

// --- The single screen headline ---------------------------------------------

export type HeadlineSource = 'skill' | 'talk' | 'completion' | 'positive' | 'none'

export interface Headline {
  text: string
  tone: Tone
  source: HeadlineSource
}

/**
 * The one most important takeaway. Worst health signal wins; ties break by
 * priority (a skill gap is the most actionable, then talk balance, then tasks).
 */
export function pickHeadline(a: Analytics): Headline {
  interface Candidate {
    severity: number
    priority: number
    tone: Tone
    source: HeadlineSource
    text: string
  }
  const candidates: Candidate[] = []

  if (a.improve.length > 0) {
    const worst = a.improve[0]
    const tone = skillTone(worst.average)
    candidates.push({
      severity: severityOf(tone),
      priority: 0,
      tone,
      source: 'skill',
      text: `Your biggest opportunity: ${SKILL_COPY[worst.key].headline}`
    })
  }

  if (a.talkRatio.average !== null) {
    const r = a.talkRatio.average
    const tone = talkRatioTone(r)
    candidates.push({
      severity: severityOf(tone),
      priority: 1,
      tone,
      source: 'talk',
      text:
        r > 0.55
          ? 'Your biggest opportunity: talk less and let the buyer speak more.'
          : 'Your biggest opportunity: speak up and steer your calls more.'
    })
  }

  if (a.tasks.completionRate !== null) {
    const tone = completionTone(a.tasks.completionRate)
    candidates.push({
      severity: severityOf(tone),
      priority: 2,
      tone,
      source: 'completion',
      text: 'Your biggest opportunity: follow through on more of your tasks.'
    })
  }

  if (candidates.length === 0) {
    return {
      text: 'Coach a call to unlock your personalized insights.',
      tone: 'neutral',
      source: 'none'
    }
  }

  candidates.sort((x, y) => y.severity - x.severity || x.priority - y.priority)
  const top = candidates[0]
  if (top.severity === 0) {
    return {
      text: "You're off to a strong start — balanced calls and solid skills. Keep it up.",
      tone: 'good',
      source: 'positive'
    }
  }
  return { text: top.text, tone: top.tone, source: top.source }
}
