// "Your Trend" — a personal performance-over-time view. A genuine multi-rep
// leaderboard isn't feasible yet (local data isn't tied to accounts, and the
// Supabase backup schema scopes every row per-user with no cross-user read
// path), so this is deliberately framed as a personal trend, not a team
// comparison: no invented peers, no fake rankings. Purely deterministic
// aggregation over calls already on disk — no new IPC, no AI.

import {
  parseISO,
  isValid,
  startOfWeek,
  startOfMonth,
  subWeeks,
  differenceInCalendarDays,
  format
} from 'date-fns'
import { Trophy, Flame, TrendingUp, Sparkles } from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { PageHeader } from '@renderer/components/PageHeader'
import { ScoreGauge } from '@renderer/components/ScoreGauge'
import { EmptyState } from '@renderer/components/EmptyState'
import { Skeleton } from '@renderer/components/Skeleton'
import { cn } from '@renderer/lib/cn'
import { useCalls } from '@renderer/features/calls/useCalls'
import { formatDate } from '@renderer/features/calls/format'
import type { CallSummary } from '@renderer/features/calls/types'
import { overallTier, TONE_TO_GAUGE, TONE_TEXT, TONE_BAR } from '@renderer/features/coaching/meta'

/** Below this many coached calls, trends/streaks are too thin to mean much —
 *  same "early days" threshold Analytics uses. */
const THIN_DATA = 3

// Weeks start Monday, matching the Analytics screen's convention.
const WEEK_OPTS = { weekStartsOn: 1 } as const
const WEEKLY_SPAN_DAYS = 84

type Granularity = 'week' | 'month'

interface ScoreBucket {
  key: string
  label: string
  average: number
  count: number
}

type CoachedCall = CallSummary & { coachScore: number }

function isCoached(c: CallSummary): c is CoachedCall {
  return c.hasCoaching && typeof c.coachScore === 'number'
}

/** The single highest-scoring coached call ever, or null if none yet. */
function findPersonalBest(coached: CoachedCall[]): CoachedCall | null {
  if (coached.length === 0) return null
  return coached.reduce((best, c) => (c.coachScore > best.coachScore ? c : best), coached[0])
}

/** Buckets coach scores into contiguous week (or month, once history spans
 *  more than ~12 weeks) periods and averages them — the same granularity
 *  rule Analytics uses for its activity chart, applied to scores instead of
 *  call counts. Only periods that actually have a coached call are returned
 *  (a trend list, not a zero-filled bar chart). */
function buildScoreTrend(coached: CoachedCall[]): {
  granularity: Granularity
  buckets: ScoreBucket[]
} {
  const dated = coached
    .map((c) => ({ date: parseISO(c.createdAt), score: c.coachScore }))
    .filter((c): c is { date: Date; score: number } => isValid(c.date))
    .sort((a, b) => a.date.getTime() - b.date.getTime())

  if (dated.length === 0) return { granularity: 'week', buckets: [] }

  const span = differenceInCalendarDays(dated[dated.length - 1].date, dated[0].date)
  const granularity: Granularity = span > WEEKLY_SPAN_DAYS ? 'month' : 'week'
  const periodStart = (d: Date): Date =>
    granularity === 'week' ? startOfWeek(d, WEEK_OPTS) : startOfMonth(d)

  const scoresByPeriod = new Map<string, number[]>()
  for (const { date, score } of dated) {
    const key = periodStart(date).toISOString()
    const arr = scoresByPeriod.get(key)
    if (arr) arr.push(score)
    else scoresByPeriod.set(key, [score])
  }

  const buckets = [...scoresByPeriod.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, scores]) => ({
      key,
      label: format(parseISO(key), granularity === 'week' ? 'MMM d' : 'MMM'),
      average: scores.reduce((sum, n) => sum + n, 0) / scores.length,
      count: scores.length
    }))

  return { granularity, buckets }
}

/** Consecutive weeks (ending at this week or last — an in-progress week
 *  doesn't break it) with at least one coached call. A real, computable
 *  measure of the rep's own consistency — not a competition with anyone. */
function computeStreakWeeks(coached: CoachedCall[]): number {
  const weekStarts = new Set<string>()
  for (const c of coached) {
    const d = parseISO(c.createdAt)
    if (isValid(d)) weekStarts.add(startOfWeek(d, WEEK_OPTS).toISOString())
  }
  if (weekStarts.size === 0) return 0

  let cursor = startOfWeek(new Date(), WEEK_OPTS)
  if (!weekStarts.has(cursor.toISOString())) {
    cursor = subWeeks(cursor, 1)
    if (!weekStarts.has(cursor.toISOString())) return 0
  }

  let streak = 0
  while (weekStarts.has(cursor.toISOString())) {
    streak++
    cursor = subWeeks(cursor, 1)
  }
  return streak
}

function CardHeading({
  icon: Icon,
  title,
  hint
}: {
  icon: typeof Trophy
  title: string
  hint: string
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <div
        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-soft"
        aria-hidden="true"
      >
        <Icon className="h-4 w-4 text-accent" strokeWidth={2} />
      </div>
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-[13px] text-faint">{hint}</p>
      </div>
    </div>
  )
}

/** Small hand-rolled bars for the score trend — no chart dependency, same
 *  convention as Analytics' charts.tsx. Colored by the same tier tone as the
 *  rest of coaching, so a strong week visibly reads green. */
function ScoreTrendBars({ buckets }: { buckets: ScoreBucket[] }): React.JSX.Element {
  const max = 100
  return (
    <div
      className="flex h-16 items-end gap-1.5"
      role="img"
      aria-label="Average coach score per period"
    >
      {buckets.map((b) => {
        const tone = overallTier(b.average).tone
        return (
          <div key={b.key} className="relative flex-1 self-stretch" aria-hidden="true">
            <div className="absolute inset-0 rounded-t bg-line" />
            <div
              className={cn(
                'absolute inset-x-0 bottom-0 rounded-t transition-[height] duration-500',
                TONE_BAR[tone]
              )}
              style={{ height: `${Math.max((b.average / max) * 100, 4)}%` }}
              title={`${b.label}: ${Math.round(b.average)}`}
            />
          </div>
        )
      })}
    </div>
  )
}

function EarlyNote({ count }: { count: number }): React.JSX.Element {
  return (
    <p className="mt-2 text-[11px] text-faint">
      Early days — based on {count} coached call{count === 1 ? '' : 's'}.
    </p>
  )
}

function TeamViewSkeleton(): React.JSX.Element {
  return (
    <div aria-busy="true" aria-label="Loading your trend">
      <Skeleton className="mb-5 h-7 w-40" />
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full rounded-2xl" />
        ))}
      </div>
    </div>
  )
}

export function TeamView(): React.JSX.Element {
  const { calls, loading } = useCalls()

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl">
        <TeamViewSkeleton />
      </div>
    )
  }

  const coached = calls.filter(isCoached)

  if (coached.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          icon={TrendingUp}
          title="Start building your trend"
          titleAs="h2"
          description="Coach a few calls and your personal bests, score trend, and streak will show up here."
        />
      </div>
    )
  }

  const thin = coached.length < THIN_DATA
  const best = findPersonalBest(coached)
  const bestTier = best ? overallTier(best.coachScore) : null
  const { granularity, buckets } = buildScoreTrend(coached)
  const streak = computeStreakWeeks(coached)

  const first = buckets[0]
  const last = buckets[buckets.length - 1]
  const delta = buckets.length >= 2 ? Math.round(last.average - first.average) : null
  const trendVerdict =
    buckets.length < 2
      ? `Not enough ${granularity}s yet to show a trend.`
      : delta === 0
        ? `Holding steady around ${Math.round(last.average)} across your recent ${granularity}s.`
        : delta! > 0
          ? `Up ${delta} point${delta === 1 ? '' : 's'} from your first tracked ${granularity} to your latest.`
          : `Down ${Math.abs(delta!)} point${Math.abs(delta!) === 1 ? '' : 's'} from your first tracked ${granularity} to your latest.`

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Your Trend"
        count={`${coached.length} coached call${coached.length === 1 ? '' : 's'}`}
        subtitle="Multi-rep comparison isn't available yet — this shows your own trend over time."
      />

      <div className="space-y-4">
        {/* Personal best */}
        <Card className="stagger-item">
          <CardHeading icon={Trophy} title="Personal best" hint="Your highest coach score ever" />
          {best && bestTier && (
            <div className="mt-3 flex items-center gap-4">
              <ScoreGauge score={best.coachScore} size={56} tone={TONE_TO_GAUGE[bestTier.tone]} />
              <div className="min-w-0">
                <p className="truncate font-medium text-ink">{best.title}</p>
                <p className="mt-0.5 text-[13px] text-faint">{formatDate(best.createdAt)}</p>
                <p className={cn('mt-1 text-[13px] font-medium', TONE_TEXT[bestTier.tone])}>
                  {bestTier.label}
                </p>
              </div>
            </div>
          )}
          {thin && <EarlyNote count={coached.length} />}
        </Card>

        {/* Score trend */}
        <div className="stagger-item" style={{ animationDelay: '35ms' }}>
          <Card>
            <CardHeading
              icon={TrendingUp}
              title="Score trend"
              hint={`Average coach score per ${granularity}`}
            />
            {buckets.length > 0 && (
              <div className="mt-3">
                <ScoreTrendBars buckets={buckets} />
                <div className="mt-1.5 flex justify-between text-[11px] text-faint">
                  <span>{first.label}</span>
                  <span>{last.label}</span>
                </div>
              </div>
            )}
            <p className="mt-3 text-sm text-muted">{trendVerdict}</p>
            {thin && <EarlyNote count={coached.length} />}
          </Card>
        </div>

        {/* Streak */}
        <div className="stagger-item" style={{ animationDelay: '70ms' }}>
          <Card>
            <CardHeading
              icon={Flame}
              title="Coaching streak"
              hint="Consecutive weeks with at least one coached call"
            />
            <div className="mt-3 flex items-baseline gap-2">
              <span
                className={cn(
                  'text-2xl font-semibold tabular-nums',
                  streak > 0 ? 'text-accent' : 'text-muted'
                )}
              >
                {streak}
              </span>
              <span className="text-[13px] text-faint">week{streak === 1 ? '' : 's'}</span>
            </div>
            <p className="mt-2 text-sm text-muted">
              {streak === 0
                ? 'No active streak — coach a call this week to start one.'
                : streak === 1
                  ? 'You coached a call this week — keep it going next week.'
                  : `You've coached at least one call a week for ${streak} weeks running.`}
            </p>
          </Card>
        </div>

        {coached.length >= THIN_DATA && (
          <p className="flex items-center gap-1.5 text-[11px] text-faint">
            <Sparkles className="h-3 w-3" /> This is your own history — there&rsquo;s no other rep
            to compare against yet.
          </p>
        )}
      </div>
    </div>
  )
}
