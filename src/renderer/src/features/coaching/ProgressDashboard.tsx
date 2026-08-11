import { ArrowLeft, Flame, Minus, Target, TrendingDown, TrendingUp } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { Card } from '@renderer/components/Card'
import { EmptyState } from '@renderer/components/EmptyState'
import { SkeletonRows } from '@renderer/components/Skeleton'
import { PageHeader } from '@renderer/components/PageHeader'
import { useSkillProgress } from './useSkillProgress'
import { SKILL_KEYS, SKILL_LABEL, type SkillProgress } from './types'

function levelLabel(score: number | null): string {
  if (score === null) return 'Not enough data yet'
  if (score >= 85) return 'Advanced'
  if (score >= 70) return 'Proficient'
  if (score >= 50) return 'Developing'
  return 'Early'
}

function levelTone(score: number | null): string {
  if (score === null) return 'text-faint'
  if (score >= 85) return 'text-positive'
  if (score >= 70) return 'text-accent'
  if (score >= 50) return 'text-warning'
  return 'text-muted'
}

function TrendIcon({ trend }: { trend: SkillProgress['trend'] }): React.JSX.Element {
  if (trend === 'up') return <TrendingUp className="h-3.5 w-3.5 text-positive" />
  if (trend === 'down') return <TrendingDown className="h-3.5 w-3.5 text-danger" />
  return <Minus className="h-3.5 w-3.5 text-faint" />
}

/** A minimal inline sparkline — plain SVG, no charting dependency, matching
 *  the app's existing "no new libraries" pattern for small visualizations. */
function Sparkline({ points }: { points: number[] }): React.JSX.Element | null {
  if (points.length < 2) return null
  const w = 120
  const h = 28
  const step = w / (points.length - 1)
  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${(i * step).toFixed(1)} ${(h - (p / 100) * h).toFixed(1)}`)
    .join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-7 w-[120px] shrink-0" aria-hidden="true">
      <path d={path} fill="none" stroke="currentColor" strokeWidth={1.75} className="text-accent" />
    </svg>
  )
}

function SkillCard({ progress }: { progress: SkillProgress }): React.JSX.Element {
  const recent = progress.history.slice(-12).map((h) => h.score)
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{SKILL_LABEL[progress.key]}</p>
          <p className={cn('mt-0.5 text-[12px] font-medium', levelTone(progress.current))}>
            {levelLabel(progress.current)}
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-right">
          <span className="text-lg font-semibold tabular-nums">
            {progress.current !== null ? progress.current : '–'}
          </span>
          <TrendIcon trend={progress.trend} />
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <Sparkline points={recent} />
        {progress.streakAboveTarget >= 2 && (
          <span className="flex items-center gap-1 text-[11px] font-medium text-warning">
            <Flame className="h-3.5 w-3.5" /> {progress.streakAboveTarget}-call streak
          </span>
        )}
      </div>
    </Card>
  )
}

export function ProgressDashboard({ onBack }: { onBack: () => void }): React.JSX.Element {
  const { progress, focusSkill, loading } = useSkillProgress()

  return (
    <div className="mx-auto max-w-3xl">
      <button
        type="button"
        onClick={onBack}
        className="mb-4 flex items-center gap-2 text-sm text-muted transition hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" /> Coaching
      </button>

      <PageHeader title="Progress" count="Skill trends across your coached calls" />

      {loading ? (
        <SkeletonRows rows={4} />
      ) : progress.every((p) => p.current === null) ? (
        <EmptyState
          icon={Target}
          title="No skill data yet"
          titleAs="h2"
          description="Coach a call with Coach 2.0 turned on (Settings → Coach 2.0) to start building your skill graph."
        />
      ) : (
        <>
          {focusSkill && (
            <Card className="mb-5 border-accent/30 bg-accent-soft">
              <div className="flex items-center gap-2 text-accent">
                <Target className="h-4 w-4" />
                <h4 className="text-xs font-semibold uppercase tracking-wide">
                  Current focus: {SKILL_LABEL[focusSkill.skill]}
                </h4>
              </div>
              <p className="mt-2 text-sm text-ink">{focusSkill.microBehavior}</p>
              <p className="mt-1.5 text-[11px] text-faint">
                Focused since {new Date(focusSkill.since).toLocaleDateString()}
              </p>
            </Card>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {SKILL_KEYS.map((key) => {
              const p = progress.find((x) => x.key === key)
              return p ? <SkillCard key={key} progress={p} /> : null
            })}
          </div>
        </>
      )}
    </div>
  )
}
