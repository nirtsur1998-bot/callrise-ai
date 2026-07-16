import {
  BarChart3,
  Sparkles,
  Target,
  Compass,
  Activity,
  Scale,
  ListChecks,
  CheckCircle2,
  type LucideIcon
} from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { PageHeader } from '@renderer/components/PageHeader'
import { Skeleton } from '@renderer/components/Skeleton'
import { EmptyState } from '@renderer/components/EmptyState'
import { cn } from '@renderer/lib/cn'
import { DIMENSION_LABEL, TONE_TEXT, type Tone } from '@renderer/features/coaching/meta'
import { useAnalyticsData } from './useAnalyticsData'
import type { DimensionTrend } from './aggregate'
import {
  pickHeadline,
  talkRatioTone,
  talkRatioVerdict,
  skillTone,
  completionTone,
  completionVerdict,
  activitySummary,
  strongestWeakest,
  focusAreas,
  skillAction,
  THIN_DATA,
  type Headline
} from './verdicts'
import { MeterBar, ProgressBar, ActivityBars } from './charts'

function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

// Tints each card's icon tile by tone, so the color itself hints at health
// before the reader even parses the number.
const TONE_ICON_BG: Record<Tone, string> = {
  good: 'bg-positive-soft',
  mid: 'bg-warning-soft',
  low: 'bg-danger-soft',
  neutral: 'bg-accent-soft'
}

function EarlyNote({ count, noun }: { count: number; noun: string }): React.JSX.Element {
  return (
    <p className="mt-2 text-[11px] text-faint">
      Early days — based on {count} {noun}
      {count === 1 ? '' : 's'}.
    </p>
  )
}

/** De-duplicates the repeated "icon tile + title + hint line" header pattern
 *  used at the top of every card below. */
function CardHeading({
  icon: Icon,
  title,
  hint,
  tone = 'neutral'
}: {
  icon: LucideIcon
  title: string
  hint: string
  tone?: Tone
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <div
        className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg', TONE_ICON_BG[tone])}
        aria-hidden="true"
      >
        <Icon className={cn('h-4 w-4', TONE_TEXT[tone])} strokeWidth={2} />
      </div>
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-[13px] text-faint">{hint}</p>
      </div>
    </div>
  )
}

function HeadlineBanner({
  headline,
  caveat
}: {
  headline: Headline
  caveat?: string
}): React.JSX.Element {
  const Icon = headline.tone === 'good' ? Sparkles : headline.source === 'none' ? Compass : Target
  return (
    <Card className="mb-4 flex items-start gap-3 bg-elevated">
      <div
        className={cn(
          'mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl',
          TONE_ICON_BG[headline.tone]
        )}
      >
        <Icon className={cn('h-[18px] w-[18px]', TONE_TEXT[headline.tone])} strokeWidth={2} />
      </div>
      <div>
        <p className="text-[11px] uppercase tracking-wide text-faint">Takeaway</p>
        <p className="mt-0.5 text-[15px] font-medium leading-snug text-ink">{headline.text}</p>
        {caveat && <p className="mt-1 text-[11px] text-faint">{caveat}</p>}
      </div>
    </Card>
  )
}

/** Mirrors the real layout's shape so the loading state doesn't jump when
 *  the data arrives — a banner-height block + five card-shaped blocks. */
function AnalyticsSkeleton(): React.JSX.Element {
  return (
    <div aria-busy="true" aria-label="Loading analytics">
      <Skeleton className="mb-5 h-7 w-40" />
      <Skeleton className="mb-4 h-20 w-full rounded-2xl" />
      <div className="space-y-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full rounded-2xl" />
        ))}
      </div>
    </div>
  )
}

export function AnalyticsView(): React.JSX.Element {
  const { analytics, loading } = useAnalyticsData()

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl">
        <AnalyticsSkeleton />
      </div>
    )
  }

  if (!analytics || analytics.totalCalls === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          icon={BarChart3}
          title="Not enough data yet"
          description="Save a few calls — and coach some of them — and your trends will show up here."
          titleAs="h2"
        />
      </div>
    )
  }

  const { activity, talkRatio, dimensions, tasks, coachedCount, granularity, totalCalls } =
    analytics
  const headline = pickHeadline(analytics)
  const thinCalls = coachedCount > 0 && coachedCount < THIN_DATA
  const thinTasks = tasks.total > 0 && tasks.total < THIN_DATA

  const scoredDims = dimensions.filter(
    (d): d is DimensionTrend & { average: number } => d.average !== null
  )
  const { strongest, weakest } = strongestWeakest(dimensions)
  const focus = focusAreas(analytics.improve)

  // Caveat the headline when it leans on thin data.
  const headlineCaveat =
    (headline.source === 'skill' || headline.source === 'talk' || headline.source === 'positive') &&
    thinCalls
      ? `Early days — based on ${coachedCount} call${coachedCount === 1 ? '' : 's'}.`
      : headline.source === 'completion' && thinTasks
        ? `Early days — based on ${tasks.total} task${tasks.total === 1 ? '' : 's'}.`
        : undefined

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Analytics"
        count={`${totalCalls} call${totalCalls === 1 ? '' : 's'} · ${coachedCount} coached`}
      />

      <HeadlineBanner headline={headline} caveat={headlineCaveat} />

      <div className="space-y-4">
        {/* 1 — Activity over time (informational, not graded) */}
        <Card>
          <CardHeading
            icon={Activity}
            title="Activity over time"
            hint={`Calls per ${granularity}`}
          />
          <div className="mt-3">
            <ActivityBars buckets={activity} />
            {activity.length > 1 && (
              <div className="mt-1.5 flex justify-between text-[11px] text-faint">
                <span>{activity[0].label}</span>
                <span>{activity[activity.length - 1].label}</span>
              </div>
            )}
          </div>
          <p className="mt-3 text-sm text-muted">
            {activitySummary(activity, granularity, totalCalls)}
          </p>
        </Card>

        {/* 2 — Talk-to-listen ratio */}
        <Card>
          <CardHeading
            icon={Scale}
            title="Talk-to-listen ratio"
            hint="Your share of words · healthy 40–55%"
            tone={talkRatio.average === null ? 'neutral' : talkRatioTone(talkRatio.average)}
          />
          {talkRatio.average === null ? (
            <p className="mt-3 text-sm text-muted">
              Coach a call with two speakers to see your balance.
            </p>
          ) : (
            <>
              <div className="mt-3 flex items-baseline justify-between gap-3">
                <span
                  className={cn(
                    'text-2xl font-semibold tabular-nums',
                    TONE_TEXT[talkRatioTone(talkRatio.average)]
                  )}
                >
                  {pct(talkRatio.average)}
                </span>
                <span className="text-[11px] text-faint">you talk</span>
              </div>
              <div className="mt-2">
                <MeterBar
                  value={talkRatio.average}
                  min={0}
                  max={1}
                  healthyFrom={0.4}
                  healthyTo={0.55}
                  tone={talkRatioTone(talkRatio.average)}
                  showEndpointLabels
                />
              </div>
              <p className="mt-3 text-sm text-muted">{talkRatioVerdict(talkRatio.average)}</p>
              {thinCalls && <EarlyNote count={coachedCount} noun="call" />}
            </>
          )}
        </Card>

        {/* 3 — Coaching skills */}
        <Card>
          <CardHeading
            icon={ListChecks}
            title="Coaching skills"
            hint="Average per skill (1–5) · healthy ≥ 4"
            tone={
              weakest
                ? skillTone(scoredDims.find((d) => d.key === weakest)?.average ?? 5)
                : 'neutral'
            }
          />
          {scoredDims.length === 0 ? (
            <p className="mt-3 text-sm text-muted">Coach a call to score your skills.</p>
          ) : (
            <>
              <div className="mt-3 space-y-3">
                {scoredDims.map((d) => {
                  const tone = skillTone(d.average)
                  return (
                    <div key={d.key} className="space-y-1.5">
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="text-muted">{DIMENSION_LABEL[d.key]}</span>
                        <span className={cn('font-medium tabular-nums', TONE_TEXT[tone])}>
                          {d.average.toFixed(1)}
                        </span>
                      </div>
                      <MeterBar
                        value={d.average}
                        min={1}
                        max={5}
                        healthyFrom={4}
                        healthyTo={5}
                        tone={tone}
                        showEndpointLabels
                      />
                    </div>
                  )
                })}
              </div>
              {strongest && weakest && strongest !== weakest && (
                <p className="mt-3 text-[13px] text-faint">
                  Strongest: {DIMENSION_LABEL[strongest]} · Weakest: {DIMENSION_LABEL[weakest]}
                </p>
              )}
              {thinCalls && <EarlyNote count={coachedCount} noun="call" />}
            </>
          )}
        </Card>

        {/* 4 — Where to focus */}
        <Card>
          <CardHeading
            icon={Target}
            title="Where to focus"
            hint="Your lowest skills right now"
            tone={
              focus.length === 0 && scoredDims.length > 0
                ? 'good'
                : focus.length > 0
                  ? 'mid'
                  : 'neutral'
            }
          />
          {scoredDims.length === 0 ? (
            <p className="mt-3 text-sm text-muted">Coach a call to see where to focus.</p>
          ) : focus.length === 0 ? (
            <p className="mt-3 text-sm text-positive">
              Strong across the board — your skills are in great shape.
            </p>
          ) : (
            <>
              <ul className="mt-3 space-y-3">
                {focus.map((a) => (
                  <li key={a.key}>
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="font-medium text-ink">{DIMENSION_LABEL[a.key]}</span>
                      <span
                        className={cn('font-medium tabular-nums', TONE_TEXT[skillTone(a.average)])}
                      >
                        {a.average.toFixed(1)}/5
                      </span>
                    </div>
                    <p className="mt-1 text-[13px] text-muted">{skillAction(a.key)}</p>
                  </li>
                ))}
              </ul>
              {thinCalls && <EarlyNote count={coachedCount} noun="call" />}
            </>
          )}
        </Card>

        {/* 5 — Task follow-through */}
        <Card>
          <CardHeading
            icon={CheckCircle2}
            title="Task follow-through"
            hint="Generated vs. completed"
            tone={tasks.completionRate !== null ? completionTone(tasks.completionRate) : 'neutral'}
          />
          {tasks.total === 0 ? (
            <p className="mt-3 text-sm text-muted">
              No tasks yet — they&rsquo;ll appear as you add or generate them.
            </p>
          ) : (
            <>
              <div className="mt-3 grid grid-cols-3 gap-3 text-center">
                <div>
                  <p className="text-2xl font-semibold tabular-nums">{tasks.total}</p>
                  <p className="text-[13px] text-faint">generated</p>
                </div>
                <div>
                  <p className="text-2xl font-semibold tabular-nums">{tasks.completed}</p>
                  <p className="text-[13px] text-faint">completed</p>
                </div>
                <div>
                  <p
                    className={cn(
                      'text-2xl font-semibold tabular-nums',
                      tasks.completionRate !== null
                        ? TONE_TEXT[completionTone(tasks.completionRate)]
                        : 'text-muted'
                    )}
                  >
                    {tasks.completionRate !== null ? pct(tasks.completionRate) : '—'}
                  </p>
                  <p className="text-[13px] text-faint">completion</p>
                </div>
              </div>
              {tasks.completionRate !== null && (
                <>
                  <div className="mt-3">
                    <ProgressBar
                      value={tasks.completionRate}
                      tone={completionTone(tasks.completionRate)}
                    />
                  </div>
                  <p className="mt-3 text-sm text-muted">
                    {completionVerdict(tasks.completionRate)}
                  </p>
                </>
              )}
              {thinTasks && <EarlyNote count={tasks.total} noun="task" />}
            </>
          )}
        </Card>
      </div>
    </div>
  )
}
