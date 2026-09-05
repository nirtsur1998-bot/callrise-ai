import type { BadgeTone } from '@renderer/components/Badge'
import type { GaugeTone } from '@renderer/components/ScoreGauge'
import type { CoachDimensionKey, CoachMetrics } from './types'
import type { SpeakerRole } from '@renderer/features/calls/types'
import { speakerKey } from '@renderer/features/live/speakerKey'

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

// Maps the coaching Tone scale onto Badge/ScoreGauge's tone vocabulary, so a
// score's Badge, ScoreGauge ring, and tier label always agree — ScoreGauge's
// own built-in toneFor() uses different score cutoffs than overallTier below,
// so any caller placing a gauge next to a tier label MUST pass this explicitly.
export const TONE_TO_BADGE: Record<Tone, BadgeTone> = {
  good: 'positive',
  mid: 'warning',
  low: 'danger',
  neutral: 'neutral'
}

// Same mapping, typed for ScoreGauge's tone prop (which has no 'accent').
export const TONE_TO_GAUGE: Record<Tone, GaugeTone> = {
  good: 'positive',
  mid: 'warning',
  low: 'danger',
  neutral: 'neutral'
}

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

// --- M19 Task 2: resolved speaker identities --------------------------------
// A call's speakerIdentities (main/calls-fs.ts's SpeakerIdentityRecord, minus
// resolvedAt — the renderer never needs it) is keyed by speakerKey() — see
// live/segments.ts. Kept as a separate lightweight type here (not imported
// from preload) since this file only needs name/source/confidence, and
// meta.ts is deliberately dependency-light (matches this file's existing
// style of small local types).
export type SpeakerIdentitySource =
  | 'user-profile'
  | 'calendar'
  | 'contact'
  | 'participant-list'
  | 'self-intro'
  | 'voice-profile'
  | 'manual'
export type SpeakerIdentityConfidence = 'high' | 'medium' | 'low'
export interface SpeakerIdentity {
  name: string
  source: SpeakerIdentitySource
  confidence: SpeakerIdentityConfidence
  contactId?: string
}
export type SpeakerIdentities = Record<string, SpeakerIdentity>

/** Human-readable text for the confidence-dot tooltip (M19 Task 2's "hover
 *  shows 'Matched from calendar invite'" requirement). */
export const SPEAKER_SOURCE_LABEL: Record<SpeakerIdentitySource, string> = {
  'user-profile': 'You — from your profile',
  calendar: 'Matched from calendar invite',
  contact: 'Matched from your saved contact',
  'participant-list': 'Matched from meeting participant list',
  'self-intro': 'They introduced themselves this way',
  'voice-profile': 'Recognized from a previous call',
  manual: 'You renamed this speaker'
}

/**
 * Resolves a speaker's display name. Three tiers, most specific wins:
 *
 * 1. A resolved identity (M19 Task 2) — a real name ("Sarah Chen") always
 *    wins when one exists for this (channel, speaker) pair.
 * 2. Recorded attribution (M21) — `role`, decided when the turn was recorded
 *    and never revised. WINS over the `repSpeaker` comparison below, which
 *    re-derives the answer at render time and so relabelled the whole call
 *    retroactively whenever that value moved. `role: 'unknown'` means we
 *    genuinely don't know who this was and says so rather than asserting a
 *    name — this is what stops a name/role being GUESSED when neither tier
 *    above has a real answer.
 * 3. The original You/Buyer/Speaker-N comparison — the fallback for anything
 *    saved before M19/M21 (no identity, no role), so every existing call
 *    site keeps working unchanged if it passes neither.
 *
 * @param channel  Present for a multichannel segment — REQUIRED to look up
 *   an identity correctly (identity keys are (channel, speaker), never
 *   speaker alone — see calls-fs.ts's speakerIdentityKey()). Omit only for
 *   mono/diarized segments, which have no channel.
 * @param speakerCount  Distinct speakers in the call, when known. With more
 *   than 2, every non-rep speaker collapsing to "Buyer" would make separate
 *   participants indistinguishable, so this falls back to "Speaker N" for
 *   them instead (the rep is still always "You").
 */
export function speakerLabel(
  speaker: number,
  repSpeaker: number | null,
  speakerCount?: number,
  role?: SpeakerRole,
  identities?: SpeakerIdentities,
  channel?: number
): string {
  const identity = identities?.[speakerKey({ speaker, channel })]
  if (identity?.name) return identity.name
  if (role === 'rep') return 'You'
  if (role === 'other') {
    return speakerCount !== undefined && speakerCount > 2 ? `Speaker ${speaker + 1}` : 'Buyer'
  }
  // Only pre-M21/M19 segments (no role, no identity) fall through to the old
  // comparison below.
  if (role === 'unknown') return `Speaker ${speaker + 1}`
  if (repSpeaker === null) return `Speaker ${speaker + 1}`
  if (speaker === repSpeaker) return 'You'
  if (speakerCount !== undefined && speakerCount > 2) return `Speaker ${speaker + 1}`
  return 'Buyer'
}

/** The resolved identity backing a speaker's label, if any — for rendering
 *  the confidence dot. Returns null when the label came from the You/Buyer/
 *  Speaker-N fallback (nothing to show a confidence source for). */
export function speakerIdentityFor(
  speaker: number,
  identities: SpeakerIdentities | undefined,
  channel?: number
): SpeakerIdentity | null {
  return identities?.[speakerKey({ speaker, channel })] ?? null
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
