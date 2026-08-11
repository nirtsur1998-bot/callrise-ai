import {
  ShieldAlert,
  Target,
  Compass,
  ArrowUp,
  ArrowDown,
  Minus,
  type LucideIcon
} from 'lucide-react'
import type { HealthFactors, HealthTrajectory, NudgeType } from './types'

export interface NudgeTone {
  icon: LucideIcon
  /** Human-readable channel label — "Risk", not the raw union value. */
  label: string
  /** Icon + accent text color token. */
  text: string
  /** Tinted background for the icon badge. */
  badgeBg: string
  /** Ring tint used for the newest card's emphasis border. */
  ring: string
  /** Left-edge accent border on the always-visible evidence block. */
  border: string
  /** Solid fill for the confidence meter's filled segments. */
  fill: string
}

// Deliberately NOT AlertTriangle/TrendingUp — those are CueCard's icons for
// "objection" and "buying-signal" one panel over. Deal Intelligence is meant
// to supersede that system, not read as a reskin of it wearing a glass
// surface; ShieldAlert/Target/Compass buys a free, immediate "this is a
// different, more premium system" signal for zero extra design cost.
// Record (not Partial) on purpose: the Nudge Engine's contract is exactly
// these three types, and a typo here should be a compile error, not a nudge
// that silently renders with `undefined` styling on a live call.
export const NUDGE_META: Record<NudgeType, NudgeTone> = {
  risk: {
    icon: ShieldAlert,
    label: 'Risk',
    text: 'text-danger',
    badgeBg: 'bg-danger-soft',
    ring: 'ring-danger/40',
    border: 'border-danger/40',
    fill: 'bg-danger'
  },
  opportunity: {
    icon: Target,
    label: 'Opportunity',
    text: 'text-positive',
    badgeBg: 'bg-positive-soft',
    ring: 'ring-positive/40',
    border: 'border-positive/40',
    fill: 'bg-positive'
  },
  tactical: {
    icon: Compass,
    label: 'Tactical',
    text: 'text-accent',
    badgeBg: 'bg-accent-soft',
    ring: 'ring-accent/40',
    border: 'border-accent/40',
    fill: 'bg-accent'
  }
}

/** "price-objection" -> "Price Objection". `subtype` is explicitly free-form
 *  per the data contract (the engine's classifier output, not a fixed enum
 *  this UI controls), so this has to survive hyphens, underscores, extra
 *  whitespace, or already-title-cased input without special-casing a source
 *  it doesn't own — a slug it can't parse just degrades to itself. */
export function formatSubtype(subtype: string): string {
  const words = subtype
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
  if (words.length === 0) return subtype
  return words.map((word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase()).join(' ')
}

// --- Deal Health Score (Tier 2) -------------------------------------------

export type HealthScoreTone = 'positive' | 'warning' | 'danger'

/** Same 65/50 thresholds `ScoreGauge` (the app's other 0-100 dial, used for
 *  coaching reports) already applies — a "70" should read as equally good
 *  news whether it's this panel's health score or a coaching score. Kept as
 *  a local copy rather than an import: this folder mirrors shapes across its
 *  own boundary on purpose (see types.ts), and a tone threshold is exactly
 *  the kind of small, stable rule worth duplicating instead of coupling to. */
export function healthScoreTone(value: number): HealthScoreTone {
  if (value >= 65) return 'positive'
  if (value >= 50) return 'warning'
  return 'danger'
}

export const HEALTH_SCORE_TONE_META: Record<HealthScoreTone, { text: string; fill: string }> = {
  positive: { text: 'text-positive', fill: 'bg-positive' },
  warning: { text: 'text-warning', fill: 'bg-warning' },
  danger: { text: 'text-danger', fill: 'bg-danger' }
}

interface TrajectoryTone {
  icon: LucideIcon
  label: string
  text: string
}

// ArrowUp/ArrowDown, not TrendingUp/TrendingDown — the latter is CueCard's
// icon for "buying-signal" one panel over (see NUDGE_META above); a trend
// arrow living inside Deal Intelligence borrowing that exact glyph would
// blur a distinction this folder has otherwise been careful to keep.
export const HEALTH_TRAJECTORY_META: Record<HealthTrajectory, TrajectoryTone> = {
  up: { icon: ArrowUp, label: 'Trending up since the last read', text: 'text-positive' },
  flat: { icon: Minus, label: 'Holding steady since the last read', text: 'text-faint' },
  down: { icon: ArrowDown, label: 'Trending down since the last read', text: 'text-danger' }
}

/** Fixed display order for the factor breakdown — matches the field order in
 *  the engine's own `HealthFactors` shape, so the on-screen order never
 *  drifts from the type declaration a future edit would actually change. */
export const HEALTH_FACTOR_ORDER: (keyof HealthFactors)[] = [
  'engagement',
  'sentiment',
  'objectionStatus',
  'momentum',
  'agendaCoverage'
]

export const HEALTH_FACTOR_LABEL: Record<keyof HealthFactors, string> = {
  engagement: 'Engagement',
  sentiment: 'Sentiment',
  objectionStatus: 'Objections',
  momentum: 'Momentum',
  agendaCoverage: 'Agenda'
}

/** Compact "how long ago", tuned for a live call — seconds and minutes are
 *  the only ranges that matter here; a nudge still on screen after an hour
 *  would mean the engine's own cap/expiry already failed upstream. */
export function formatRelativeTime(createdAtMs: number, nowMs: number): string {
  const deltaS = Math.max(0, Math.round((nowMs - createdAtMs) / 1000))
  if (deltaS < 5) return 'just now'
  if (deltaS < 60) return `${deltaS}s ago`
  const deltaM = Math.round(deltaS / 60)
  if (deltaM < 60) return `${deltaM}m ago`
  const deltaH = Math.round(deltaM / 60)
  return `${deltaH}h ago`
}
