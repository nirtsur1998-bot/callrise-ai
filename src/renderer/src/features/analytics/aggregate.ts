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
  format
} from 'date-fns'
import type { CallSummary } from '@renderer/features/calls/types'
import type { Task } from '@renderer/features/tasks/types'
import type { CoachDimensionKey } from '@renderer/features/coaching/types'
import { DIMENSION_ORDER } from '@renderer/features/coaching/meta'

// Weeks start Monday; ≤ ~12 weeks of history charts weekly, longer goes monthly.
const WEEK_OPTS = { weekStartsOn: 1 } as const
const WEEKLY_SPAN_DAYS = 84

/** Below this many points, a series isn't a "trend" worth charting. */
export const MIN_TREND_POINTS = 2
/** How many of the most recent coached calls feed "top areas to improve". */
const RECENT_WINDOW = 5

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
