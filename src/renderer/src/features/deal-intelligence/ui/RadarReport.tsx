import { useMemo, useState } from 'react'
import { Quote, ThumbsDown, ThumbsUp } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { Badge } from '@renderer/components/Badge'
import type { DealIntelligenceRecord, DealNudgeRecord } from '../../../../../preload/index.d'
import { formatSubtype, healthScoreTone, HEALTH_SCORE_TONE_META, NUDGE_META } from './meta'
import type { NudgeType } from './types'

const ROLE_LABEL: Record<DealNudgeRecord['evidenceRole'], string> = {
  rep: 'You said',
  other: 'They said'
}

/** mm:ss from a call-relative millisecond offset — a local copy of
 *  CallDetail.tsx's own formatMmSs (that file can't export a bare helper
 *  without becoming a second entry point for Fast Refresh). */
function formatMmSs(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

interface RadarReportProps {
  record: DealIntelligenceRecord
}

/**
 * M24 §8 — the post-call review of everything Live Deal Intelligence caught
 * during this call: the health score's trajectory across the whole call as
 * one curve, and every nudge it surfaced as a scannable, evidence-backed
 * timeline the rep can hit/miss-review after the fact. Reuses the exact same
 * type tones (`NUDGE_META`) and health-tone thresholds
 * (`healthScoreTone`/`HEALTH_SCORE_TONE_META`) the live HUD uses, so a
 * "risk" or a "72" reads identically whether it's mid-call or in review —
 * but never the `glass-hud` frosted-overlay treatment itself, which exists
 * to sit legibly over a video call and would just look like an unstyled box
 * on this page's plain card background.
 */
export function RadarReport({ record }: RadarReportProps): React.JSX.Element {
  const { nudges, healthScoreHistory } = record
  const rated = nudges.filter((n) => n.feedback)
  const helpfulCount = rated.filter((n) => n.feedback === 'helpful').length
  const typeCounts: Record<NudgeType, number> = { risk: 0, opportunity: 0, tactical: 0 }
  for (const n of nudges) typeCounts[n.type]++

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {(['risk', 'opportunity', 'tactical'] as const).map((type) =>
          typeCounts[type] > 0 ? (
            <Badge key={type} icon={NUDGE_META[type].icon} tone="neutral">
              {typeCounts[type]} {NUDGE_META[type].label}
              {typeCounts[type] === 1 ? '' : 's'}
            </Badge>
          ) : null
        )}
        {rated.length > 0 && (
          <Badge
            icon={ThumbsUp}
            tone={helpfulCount / rated.length >= 0.5 ? 'positive' : 'warning'}
            title="Of the nudges you rated"
          >
            {helpfulCount}/{rated.length} rated helpful
          </Badge>
        )}
        {nudges.length === 0 && (
          <p className="text-sm text-muted">Nothing was surfaced this call.</p>
        )}
      </div>

      {healthScoreHistory.length > 1 && <HealthScoreCurve points={healthScoreHistory} />}

      {nudges.length > 0 && (
        <div className="flex flex-col gap-2">
          {nudges
            .slice()
            .sort((a, b) => a.atMs - b.atMs)
            .map((nudge) => (
              <RadarNudgeRow key={nudge.id} nudge={nudge} />
            ))}
        </div>
      )}
    </div>
  )
}

function RadarNudgeRow({ nudge }: { nudge: DealNudgeRecord }): React.JSX.Element {
  const meta = NUDGE_META[nudge.type]
  const Icon = meta.icon
  const [evidenceOpen, setEvidenceOpen] = useState(false)

  return (
    <div
      className={cn('rounded-xl border border-line-soft px-3 py-2.5', evidenceOpen && meta.border)}
    >
      <button
        type="button"
        onClick={() => setEvidenceOpen((v) => !v)}
        aria-expanded={evidenceOpen}
        className="flex w-full items-start gap-2.5 text-left"
      >
        <div className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-lg', meta.badgeBg)}>
          <Icon className={cn('h-3.5 w-3.5', meta.text)} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className={cn('text-[10px] font-semibold tracking-wide uppercase', meta.text)}>
              {meta.label}
            </span>
            <span className="truncate text-[11px] font-medium text-muted">
              {formatSubtype(nudge.subtype)}
            </span>
            <span className="ml-auto shrink-0 text-[10.5px] tabular-nums text-faint">
              {formatMmSs(nudge.atMs)}
            </span>
          </div>
          <p className="mt-0.5 text-[13px] leading-snug font-medium text-ink">
            {nudge.suggestedCue}
          </p>
        </div>
        {nudge.feedback && (
          <span
            className={cn(
              'mt-0.5 shrink-0',
              nudge.feedback === 'helpful' ? 'text-positive' : 'text-faint'
            )}
            title={
              nudge.feedback === 'helpful'
                ? 'You marked this helpful'
                : 'You marked this not helpful'
            }
          >
            {nudge.feedback === 'helpful' ? (
              <ThumbsUp className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <ThumbsDown className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </span>
        )}
      </button>

      {evidenceOpen && (
        <div
          className={cn(
            'mt-2 flex gap-2 rounded-lg border-l-2 bg-canvas/60 py-1.5 pr-2 pl-2.5',
            meta.border
          )}
        >
          <Quote className="mt-0.5 h-3 w-3 shrink-0 text-faint" aria-hidden="true" />
          <div className="min-w-0">
            <span className="text-[9px] font-semibold tracking-wide text-faint uppercase">
              {ROLE_LABEL[nudge.evidenceRole]}
            </span>
            <p className="text-[12.5px] leading-snug text-muted italic">
              &ldquo;{nudge.evidenceQuote}&rdquo;
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

const CHART_WIDTH = 600
const CHART_HEIGHT = 72
const CHART_PAD_Y = 8

/** The whole-call health score curve as a single SVG polyline — score (not
 *  trajectory) drives the Y axis directly, since trajectory is just the
 *  slope between two adjacent points here and would be redundant to also
 *  encode separately. Point spacing on the X axis is by TIME (`atMs`), not
 *  by index — Tier 2 passes are not evenly spaced (routine cadence vs.
 *  stage-change triggers), and an evenly-spaced line would visually lie
 *  about how much of the call separates two reads. */
function HealthScoreCurve({
  points
}: {
  points: DealIntelligenceRecord['healthScoreHistory']
}): React.JSX.Element {
  const { path, dots, first, last } = useMemo(() => {
    const maxMs = Math.max(1, ...points.map((p) => p.atMs))
    const usableH = CHART_HEIGHT - CHART_PAD_Y * 2
    const xy = points.map((p) => ({
      x: (p.atMs / maxMs) * CHART_WIDTH,
      y: CHART_PAD_Y + usableH * (1 - p.score / 100),
      score: p.score
    }))
    const path = xy
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      .join(' ')
    return { path, dots: xy, first: points[0], last: points[points.length - 1] }
  }, [points])

  const lastTone = HEALTH_SCORE_TONE_META[healthScoreTone(last.score)]

  return (
    <div className="rounded-xl border border-line-soft px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <p className="text-[10px] font-semibold tracking-wide text-faint uppercase">
          Deal health over the call
        </p>
        <p className={cn('text-[11px] font-semibold tabular-nums', lastTone.text)}>
          {first.score} → {last.score}
        </p>
      </div>
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        preserveAspectRatio="none"
        className="h-14 w-full"
        role="img"
        aria-label={`Deal health score from ${first.score} to ${last.score} across the call, ${points.length} reads`}
      >
        <line
          x1={0}
          y1={CHART_PAD_Y + (CHART_HEIGHT - CHART_PAD_Y * 2) * 0.5}
          x2={CHART_WIDTH}
          y2={CHART_PAD_Y + (CHART_HEIGHT - CHART_PAD_Y * 2) * 0.5}
          className="stroke-line"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
        <path
          d={path}
          fill="none"
          className={lastTone.text}
          stroke="currentColor"
          strokeWidth={2}
        />
        {dots.map((d, i) => (
          <circle
            key={i}
            cx={d.x}
            cy={d.y}
            r={i === dots.length - 1 ? 3 : 2}
            className={i === dots.length - 1 ? lastTone.text : 'text-faint'}
            fill="currentColor"
          />
        ))}
      </svg>
    </div>
  )
}
