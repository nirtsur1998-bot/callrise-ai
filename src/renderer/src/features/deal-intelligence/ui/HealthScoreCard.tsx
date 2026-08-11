import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { CollapseTransition } from './CollapseTransition'
import {
  HEALTH_FACTOR_LABEL,
  HEALTH_FACTOR_ORDER,
  HEALTH_SCORE_TONE_META,
  HEALTH_TRAJECTORY_META,
  healthScoreTone
} from './meta'
import type { DealHealthScore } from './types'

interface HealthScoreCardProps {
  healthScore: DealHealthScore
}

/**
 * Tier 2's compact headline: a 0-100 score, its trajectory since the last
 * pass, and the one strategic move that pass produced — all readable without
 * a click. The 5-factor breakdown is genuinely secondary (it's the "why"
 * behind a number the rep already has in front of them), so it lives behind
 * the same `CollapseTransition` primitive `NudgeCard` already uses for its
 * own expand-on-demand evidence disclosure, not a second collapse mechanism.
 *
 * Its own small card, not a graft onto `PresenceHeader` — see that file's
 * doc comment on why its header was deliberately collapsed from a wider
 * masthead down to a slim, always-present pill. A Tier 2 score doesn't share
 * the property that decision was protecting: it doesn't exist until the
 * first pass lands (~2-3 minutes into a call) and only updates on its own
 * slow cadence after that, so folding it into the one element that's on
 * screen for the *entire* call would undo that specific restraint for a
 * feature that was never meant to be permanent in the same way.
 */
export function HealthScoreCard({ healthScore }: HealthScoreCardProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const scoreTone = HEALTH_SCORE_TONE_META[healthScoreTone(healthScore.score)]
  const trend = HEALTH_TRAJECTORY_META[healthScore.trajectory]
  const TrendIcon = trend.icon

  return (
    <div className="glass-hud pointer-events-auto relative overflow-hidden rounded-2xl p-3">
      <span className="glass-sheen rounded-2xl" aria-hidden="true" />

      <div className="flex items-center gap-2">
        <span className="sr-only">
          Deal health score {healthScore.score} out of 100, {trend.label}.
        </span>
        <div aria-hidden="true" className="flex items-baseline gap-1">
          <span className={cn('text-2xl leading-none font-semibold tabular-nums', scoreTone.text)}>
            {healthScore.score}
          </span>
          <span className="text-[10px] text-faint">/100</span>
        </div>
        <TrendIcon aria-hidden="true" className={cn('h-3.5 w-3.5 shrink-0', trend.text)} />
        <span
          aria-hidden="true"
          className="ml-auto text-[10px] font-semibold tracking-wide text-faint uppercase"
        >
          Deal Health
        </span>
      </div>

      {/* The one strategic thing the rep should know from this pass — real
          visual weight (a tinted, bordered block), not a footnote line.
          Reuses the accent "suggested action" idiom RiskAssessmentCard
          already established elsewhere in the app for the same job: a
          single recommended move surfaced by an AI pass. */}
      <div className="mt-2 rounded-lg border border-accent/25 bg-accent-soft/40 px-3 py-2">
        <p className="text-[9px] font-semibold tracking-wide text-faint uppercase">Top move</p>
        <p className="mt-0.5 text-[12.5px] leading-snug font-medium text-ink">
          {healthScore.topRecommendation}
        </p>
      </div>

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls="di-health-factors"
        className="mt-2 flex w-full items-center gap-1.5 rounded-lg px-0.5 py-0.5 text-left transition hover:text-ink"
      >
        <span className="min-w-0 flex-1 text-[10.5px] font-medium text-faint">
          Factor breakdown
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'h-3 w-3 shrink-0 text-faint transition-transform duration-200',
            expanded && 'rotate-180'
          )}
        />
      </button>

      <CollapseTransition open={expanded}>
        <div id="di-health-factors" className="flex flex-col gap-1.5 pt-2">
          {HEALTH_FACTOR_ORDER.map((key) => (
            <FactorRow
              key={key}
              label={HEALTH_FACTOR_LABEL[key]}
              value={healthScore.factors[key]}
            />
          ))}
        </div>
      </CollapseTransition>
    </div>
  )
}

/** One factor: a label, a slim fill bar (tone-matched to that factor's own
 *  value, same 65/50 thresholds as the headline score), and the exact
 *  number — same dual-encoding rationale as `ConfidenceMeter` (a glance
 *  reads the bar, a decision reads the number), packaged as a single
 *  `role="img"` element so a screen reader gets one clean announcement per
 *  factor instead of three fragments. */
function FactorRow({ label, value }: { label: string; value: number }): React.JSX.Element {
  const fill = HEALTH_SCORE_TONE_META[healthScoreTone(value)].fill
  return (
    <div className="flex items-center gap-2" role="img" aria-label={`${label} ${value} out of 100`}>
      <span aria-hidden="true" className="w-[72px] shrink-0 text-[11px] text-muted">
        {label}
      </span>
      <div aria-hidden="true" className="h-1 flex-1 overflow-hidden rounded-full bg-line">
        <div
          className={cn('h-full rounded-full transition-[width] duration-300', fill)}
          style={{ width: `${value}%` }}
        />
      </div>
      <span
        aria-hidden="true"
        className="w-6 shrink-0 text-right text-[10px] text-faint tabular-nums"
      >
        {value}
      </span>
    </div>
  )
}
