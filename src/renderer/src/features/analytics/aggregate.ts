// Pure, deterministic aggregation for the Analytics screen. No React, no IPC,
// no LLM — just counting and averaging over data already on disk, so it runs
// instantly and offline and can be reasoned about (and tested) in isolation.

import {
  parseISO,
  isValid,
  startOfWeek,
  startOfMonth,
  eachWeekOfInterval,
  eachMonthOfInterval,
  differenceInCalendarDays,
  addMonths,
  format
} from 'date-fns'
import type { CallSummary } from '@renderer/features/calls/types'
import type { Task } from '@renderer/features/tasks/types'
import type { CoachDimensionKey } from '@renderer/features/coaching/types'
import { DIMENSION_ORDER } from '@renderer/features/coaching/meta'
import type { Deal, DealStage } from '@renderer/features/deals/types'

// Weeks start Monday; ≤ ~12 weeks of history charts weekly, longer goes monthly.
const WEEK_OPTS = { weekStartsOn: 1 } as const
const WEEKLY_SPAN_DAYS = 84

/** Below this many points, a series isn't a "trend" worth charting. */
export const MIN_TREND_POINTS = 2
/** How many of the most recent coached calls feed "top areas to improve". */
const RECENT_WINDOW = 5
/** How many months ahead the pipeline forecast charts individually before
 *  collapsing the rest into a single "Later" bucket. */
const FORECAST_HORIZON_MONTHS = 6

export type Granularity = 'week' | 'month'

/** One bar in the activity chart. */
export interface PeriodBucket {
  key: string // ISO of the period start — a stable React key
  label: string // short axis label
  count: number
}

/** One point in a time series (a talk ratio or a dimension score). */
export interface TrendPoint {
  date: string // ISO of the call
  label: string // short axis label
  value: number
}

export interface DimensionTrend {
  key: CoachDimensionKey
  points: TrendPoint[]
  average: number | null // 1–5, over calls that scored this dimension
}

export interface ImproveArea {
  key: CoachDimensionKey
  average: number // 1–5
  sampleSize: number
}

export interface TaskWeek {
  key: string
  label: string
  created: number
  completed: number
}

export interface TaskStats {
  total: number
  completed: number
  open: number
  completionRate: number | null // 0–1
  generatedByAi: number
  manual: number
  weekly: TaskWeek[]
}

/** A coached call reduced to just what analytics needs. */
export interface CoachedCall {
  id: string
  createdAt: string
  overallScore: number
  talkRatio: number | null
  scores: Partial<Record<CoachDimensionKey, number>>
}

export interface AnalyticsInput {
  calls: Pick<CallSummary, 'createdAt'>[]
  coached: CoachedCall[]
  tasks: Task[]
}

/** One bucket in the pipeline forecast — a month, or one of the two special
 *  buckets ("Later" for anything past the horizon, "No date" for deals with
 *  no `expectedCloseDate`). */
export interface PipelineForecastBucket {
  monthKey: string // 'yyyy-MM', or 'later' / 'no-date' — a stable React key
  monthLabel: string // short axis label, e.g. "Jul 2026", "Later", "No date"
  totalValue: number
  dealCount: number
}

export interface Analytics {
  totalCalls: number
  coachedCount: number
  granularity: Granularity
  activity: PeriodBucket[]
  talkRatio: { points: TrendPoint[]; average: number | null }
  dimensions: DimensionTrend[] // in DIMENSION_ORDER
  improve: ImproveArea[] // the lowest 1–2 dimensions
  tasks: TaskStats
}

// --- helpers ----------------------------------------------------------------

/** Parse the valid ISO dates out of a dated list, dropping anything unparseable. */
function validDates(items: { createdAt: string }[]): Date[] {
  const out: Date[] = []
  for (const it of items) {
    const d = parseISO(it.createdAt)
    if (isValid(d)) out.push(d)
  }
  return out
}

function minDate(dates: Date[]): Date {
  return dates.reduce((a, b) => (a < b ? a : b))
}

function maxDate(dates: Date[]): Date {
  return dates.reduce((a, b) => (a > b ? a : b))
}

function periodStart(d: Date, granularity: Granularity): Date {
  return granularity === 'week' ? startOfWeek(d, WEEK_OPTS) : startOfMonth(d)
}

function shortLabel(d: Date, granularity: Granularity): string {
  return granularity === 'week' ? format(d, 'MMM d') : format(d, 'MMM')
}

function average(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, n) => sum + n, 0) / values.length
}

function chooseGranularity(dates: Date[]): Granularity {
  if (dates.length === 0) return 'week'
  return differenceInCalendarDays(maxDate(dates), minDate(dates)) > WEEKLY_SPAN_DAYS
    ? 'month'
    : 'week'
}

/** Bucket dated items into contiguous week/month periods (empty periods = 0). */
function bucketByPeriod(dates: Date[], granularity: Granularity): PeriodBucket[] {
  if (dates.length === 0) return []
  const start = periodStart(minDate(dates), granularity)
  const end = periodStart(maxDate(dates), granularity)
  const starts =
    granularity === 'week'
      ? eachWeekOfInterval({ start, end }, WEEK_OPTS)
      : eachMonthOfInterval({ start, end })

  const counts = new Map<string, number>()
  for (const d of dates) {
    const key = periodStart(d, granularity).toISOString()
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return starts.map((s) => {
    const key = s.toISOString()
    return { key, label: shortLabel(s, granularity), count: counts.get(key) ?? 0 }
  })
}

function toPoint(createdAt: string, value: number): TrendPoint {
  const d = parseISO(createdAt)
  return { date: createdAt, label: isValid(d) ? format(d, 'MMM d') : '', value }
}

function byCreatedAtAsc(a: CoachedCall, b: CoachedCall): number {
  return a.createdAt.localeCompare(b.createdAt)
}

function buildTalkRatio(coached: CoachedCall[]): { points: TrendPoint[]; average: number | null } {
  const points: TrendPoint[] = []
  for (const c of [...coached].sort(byCreatedAtAsc)) {
    if (c.talkRatio !== null) points.push(toPoint(c.createdAt, c.talkRatio))
  }
  return { points, average: average(points.map((p) => p.value)) }
}

function buildDimensionTrends(coached: CoachedCall[]): DimensionTrend[] {
  const sorted = [...coached].sort(byCreatedAtAsc)
  return DIMENSION_ORDER.map((key) => {
    const points: TrendPoint[] = []
    for (const c of sorted) {
      const score = c.scores[key]
      if (typeof score === 'number') points.push(toPoint(c.createdAt, score))
    }
    return { key, points, average: average(points.map((p) => p.value)) }
  })
}

/** The lowest-scoring 1–2 dimensions across the most recent coached calls. */
function buildImproveAreas(coached: CoachedCall[]): ImproveArea[] {
  const recent = [...coached]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, RECENT_WINDOW)
  if (recent.length === 0) return []

  const areas: ImproveArea[] = []
  for (const key of DIMENSION_ORDER) {
    const scores: number[] = []
    for (const c of recent) {
      const s = c.scores[key]
      if (typeof s === 'number') scores.push(s)
    }
    const avg = average(scores)
    if (avg !== null) areas.push({ key, average: avg, sampleSize: scores.length })
  }
  areas.sort((a, b) => a.average - b.average) // lowest first
  return areas.slice(0, 2)
}

function countByWeek(dates: Date[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const d of dates) {
    const key = startOfWeek(d, WEEK_OPTS).toISOString()
    m.set(key, (m.get(key) ?? 0) + 1)
  }
  return m
}

function buildTaskStats(tasks: Task[]): TaskStats {
  const total = tasks.length
  const completed = tasks.filter((t) => t.status === 'done').length
  const generatedByAi = tasks.filter((t) => t.source === 'ai').length

  const createdDates = validDates(tasks)
  const completedDates = validDates(
    tasks
      .filter((t): t is Task & { completedAt: string } => typeof t.completedAt === 'string')
      .map((t) => ({ createdAt: t.completedAt }))
  )

  let weekly: TaskWeek[] = []
  const all = [...createdDates, ...completedDates]
  if (all.length > 0) {
    const start = startOfWeek(minDate(all), WEEK_OPTS)
    const end = startOfWeek(maxDate(all), WEEK_OPTS)
    const createdByWeek = countByWeek(createdDates)
    const completedByWeek = countByWeek(completedDates)
    weekly = eachWeekOfInterval({ start, end }, WEEK_OPTS).map((s) => {
      const key = s.toISOString()
      return {
        key,
        label: format(s, 'MMM d'),
        created: createdByWeek.get(key) ?? 0,
        completed: completedByWeek.get(key) ?? 0
      }
    })
  }

  return {
    total,
    completed,
    open: total - completed,
    completionRate: total > 0 ? completed / total : null,
    generatedByAi,
    manual: total - generatedByAi,
    weekly
  }
}

/**
 * Projected deal value over time: OPEN-kind deals bucketed by the month of
 * their `expectedCloseDate`. Charts the current month through
 * `FORECAST_HORIZON_MONTHS - 1` months out; anything closing later collapses
 * into a "Later" bucket (rather than being dropped), and anything overdue
 * (a close date already in the past) is folded into the current month's
 * bucket since it's effectively due now. Deals with no `expectedCloseDate`
 * land in a distinct "No date" bucket, always last.
 */
export function buildPipelineForecast(
  deals: Deal[],
  stages: DealStage[]
): PipelineForecastBucket[] {
  const stageById = new Map(stages.map((s) => [s.id, s]))
  const openDeals = deals.filter((d) => stageById.get(d.stageId)?.kind === 'open')

  const now = new Date()
  const currentMonth = startOfMonth(now)
  const horizonMonths = eachMonthOfInterval({
    start: currentMonth,
    end: addMonths(currentMonth, FORECAST_HORIZON_MONTHS - 1)
  })
  const horizonEnd = horizonMonths[horizonMonths.length - 1]

  const monthBuckets = new Map<string, PipelineForecastBucket>()
  for (const m of horizonMonths) {
    const monthKey = format(m, 'yyyy-MM')
    monthBuckets.set(monthKey, {
      monthKey,
      monthLabel: format(m, 'MMM yyyy'),
      totalValue: 0,
      dealCount: 0
    })
  }

  let laterValue = 0
  let laterCount = 0
  let noDateValue = 0
  let noDateCount = 0

  for (const deal of openDeals) {
    const value = deal.value ?? 0
    const parsed = deal.expectedCloseDate ? parseISO(deal.expectedCloseDate) : null

    if (!parsed || !isValid(parsed)) {
      noDateValue += value
      noDateCount += 1
      continue
    }

    // Overdue close dates are folded into the current month — they're due
    // now, not "later".
    const dealMonth = startOfMonth(parsed) < currentMonth ? currentMonth : startOfMonth(parsed)

    if (dealMonth > horizonEnd) {
      laterValue += value
      laterCount += 1
      continue
    }

    const monthKey = format(dealMonth, 'yyyy-MM')
    const bucket = monthBuckets.get(monthKey)
    if (bucket) {
      bucket.totalValue += value
      bucket.dealCount += 1
    }
  }

  const result = Array.from(monthBuckets.values())
  if (laterCount > 0) {
    result.push({
      monthKey: 'later',
      monthLabel: 'Later',
      totalValue: laterValue,
      dealCount: laterCount
    })
  }
  if (noDateCount > 0) {
    result.push({
      monthKey: 'no-date',
      monthLabel: 'No date',
      totalValue: noDateValue,
      dealCount: noDateCount
    })
  }
  return result
}

// --- entry point ------------------------------------------------------------

export function computeAnalytics(input: AnalyticsInput): Analytics {
  const callDates = validDates(input.calls)
  const granularity = chooseGranularity(callDates)
  return {
    totalCalls: input.calls.length,
    coachedCount: input.coached.length,
    granularity,
    activity: bucketByPeriod(callDates, granularity),
    talkRatio: buildTalkRatio(input.coached),
    dimensions: buildDimensionTrends(input.coached),
    improve: buildImproveAreas(input.coached),
    tasks: buildTaskStats(input.tasks)
  }
}
