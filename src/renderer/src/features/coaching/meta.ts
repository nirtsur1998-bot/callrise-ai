import type { CoachDimensionKey, CoachMetrics } from './types'

export const DIMENSION_ORDER: CoachDimensionKey[] = [
  'discovery',
  'engagement',
  'objection',
  'value',
  'nextStep',
  'control'
]

export const DIMENSION_LABEL: Record<CoachDimensionKey, string> = {
  discovery: 'Discovery & qualification',
  engagement: 'Engagement & listening',
  objection: 'Objection handling',
  value: 'Value articulation',
  nextStep: 'Next-step specificity',
  control: 'Call control & structure'
}

export type Tone = 'good' | 'mid' | 'low' | 'neutral'

// Semantic status tokens (index.css) rather than raw emerald/amber/rose — so
// these tones stay on-brand AND adapt per theme (the raw Tailwind shades were
// identical in light + dark, washing out on white).
export const TONE_TEXT: Record<Tone, string> = {
  good: 'text-positive',
  mid: 'text-warning',
  low: 'text-danger',
  neutral: 'text-muted'
}

export const TONE_BAR: Record<Tone, string> = {
  good: 'bg-positive',
  mid: 'bg-warning',
  low: 'bg-danger',
  neutral: 'bg-faint'
}

export function scoreTone(score: number): Tone {
  if (score >= 4) return 'good'
  if (score === 3) return 'mid'
  return 'low'
}

/** Encouraging, growth-minded labels (never harsh) for the 0–100 overall. */
export function overallTier(score: number): { label: string; tone: Tone } {
  if (score >= 80) return { label: 'Excellent', tone: 'good' }
  if (score >= 65) return { label: 'Strong', tone: 'good' }
  if (score >= 50) return { label: 'Solid', tone: 'mid' }
  if (score >= 35) return { label: 'Developing', tone: 'mid' }
  return { label: 'Early', tone: 'low' }
}

export function speakerLabel(speaker: number, repSpeaker: number | null): string {
  if (repSpeaker === null) return `Speaker ${speaker + 1}`
  return speaker === repSpeaker ? 'You' : 'Buyer'
}

export interface MetricRow {
  label: string
  value: string
  hint: string
  tone: Tone
}

/** The deterministic metrics, formatted with gentle benchmark hints. */
export function metricRows(m: CoachMetrics): MetricRow[] {
  const rows: MetricRow[] = []

  if (m.talkRatio === null) {
    rows.push({ label: 'You talked', value: 'N/A', hint: 'needs 2 speakers', tone: 'neutral' })
  } else {
    rows.push({
      label: 'You talked',
      value: `${Math.round(m.talkRatio * 100)}%`,
      hint: 'aim ~43%',
      tone: m.talkRatio > 0.65 ? 'mid' : 'good'
    })
  }

  const monoValue =
    m.longestMonologueMinutes !== null
      ? `${m.longestMonologueWords}w · ~${m.longestMonologueMinutes}m`
      : `${m.longestMonologueWords}w`
  const monoWatch =
    (m.longestMonologueMinutes !== null && m.longestMonologueMinutes > 2) ||
    m.longestMonologueWords > 300
  rows.push({
    label: 'Longest monologue',
    value: monoValue,
    hint: 'watch > 2m',
    tone: monoWatch ? 'mid' : 'neutral'
  })

  rows.push({
    label: 'Your questions',
    value: `${m.questionCount}`,
    hint: 'aim 11–14',
    tone: m.questionCount >= 11 ? 'good' : m.questionCount < 6 ? 'mid' : 'neutral'
  })

  rows.push({
    label: 'Pace',
    value: m.wordsPerMinute !== null ? `${m.wordsPerMinute} wpm` : 'N/A',
    hint: 'words / min',
    tone: 'neutral'
  })

  rows.push({ label: 'Back-and-forth', value: `${m.turns}`, hint: 'turns', tone: 'neutral' })

  return rows
}
