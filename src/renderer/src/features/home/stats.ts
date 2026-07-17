import { isToday, startOfWeek, subWeeks } from 'date-fns'
import type { CallSummary } from '@renderer/features/calls/types'
import type { Task } from '@renderer/features/tasks/types'
import { dueBucket } from '@renderer/features/tasks/format'
import { overallTier } from '@renderer/features/coaching/meta'

export interface HomeStats {
  callsToday: number
  talkTimeTodayMs: number
  tasksDue: number
  /** True when at least one open task is past its due date — drives the
   *  "Tasks due" stat's urgency coloring on Home. */
  hasOverdueTasks: boolean
  /** True when at least one open task is due today (and none are overdue) —
   *  a lighter urgency signal than hasOverdueTasks. */
  hasTasksDueToday: boolean
}

/** Deterministic Home stat-row numbers from data already on disk — no new
 *  storage, no aggregation dependency on the coaching-only analytics module. */
export function computeHomeStats(calls: CallSummary[], tasks: Task[]): HomeStats {
  const todaysCalls = calls.filter((c) => isToday(new Date(c.createdAt)))
  const openTasks = tasks.filter((t) => t.status === 'open')
  const openBuckets = openTasks.map((t) => dueBucket(t.dueAt))
  return {
    callsToday: todaysCalls.length,
    talkTimeTodayMs: todaysCalls.reduce((sum, c) => sum + c.durationMs, 0),
    tasksDue: openTasks.length,
    hasOverdueTasks: openBuckets.some((b) => b === 'overdue'),
    hasTasksDueToday: openBuckets.some((b) => b === 'today')
  }
}

/** "1h 12m" / "45m" — compact enough for a stat card. */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '0m'
  const totalMinutes = Math.round(ms / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes}m`
  if (minutes === 0) return `${hours}h`
  return `${hours}h ${minutes}m`
}

// Whole ISO calendar weeks (Monday start), matching analytics/aggregate.ts's
// convention — so "last week" here means the same thing it means there.
const WEEK_OPTS = { weekStartsOn: 1 } as const

export interface WeekRecap {
  callsLastWeek: number
  coachedCountLastWeek: number
  /** Rounded 0–100, or null when no call last week was coached. */
  avgCoachScoreLastWeek: number | null
  /** Open tasks due today or within the next 7 days. */
  tasksDueThisWeek: number
}

/** Deterministic "This week" recap — last calendar week's call activity
 *  (reusing CallSummary fields already on Home, no full coaching fetch
 *  needed) plus what's due in the next 7 days (reusing tasks/format.ts's
 *  due-bucketing so "due soon" means the same thing here as on the Tasks
 *  screen). Analytics' `computeAnalytics` isn't a fit: it needs full
 *  `CoachedCall` scores-per-dimension and returns whole trend series, not a
 *  single "last week" figure — so this is a small, purpose-built helper. */
export function computeWeekRecap(calls: CallSummary[], tasks: Task[]): WeekRecap {
  const thisWeekStart = startOfWeek(new Date(), WEEK_OPTS)
  const lastWeekStart = subWeeks(thisWeekStart, 1)

  const lastWeekCalls = calls.filter((c) => {
    const d = new Date(c.createdAt)
    return !Number.isNaN(d.getTime()) && d >= lastWeekStart && d < thisWeekStart
  })

  const scores = lastWeekCalls
    .filter((c) => c.hasCoaching && typeof c.coachScore === 'number')
    .map((c) => c.coachScore as number)

  const tasksDueThisWeek = tasks.filter((t) => {
    if (t.status !== 'open' || !t.dueAt) return false
    const bucket = dueBucket(t.dueAt)
    return bucket === 'today' || bucket === 'soon'
  }).length

  return {
    callsLastWeek: lastWeekCalls.length,
    coachedCountLastWeek: scores.length,
    avgCoachScoreLastWeek:
      scores.length > 0 ? Math.round(scores.reduce((sum, n) => sum + n, 0) / scores.length) : null,
    tasksDueThisWeek
  }
}

/** One plain-English "so what" sentence synthesizing the recap — every data
 *  card in this app answers this, so the This-week card does too. */
export function weekRecapHeadline(recap: WeekRecap): string {
  const { callsLastWeek, avgCoachScoreLastWeek, tasksDueThisWeek } = recap

  if (callsLastWeek === 0 && tasksDueThisWeek === 0) {
    return 'A quiet week so far — no calls last week and nothing due. Good time to plan ahead.'
  }

  const callWord = callsLastWeek === 1 ? 'call' : 'calls'
  const callsPart =
    callsLastWeek === 0
      ? 'No calls last week'
      : avgCoachScoreLastWeek === null
        ? `${callsLastWeek} ${callWord} last week, none coached yet`
        : `${callsLastWeek} ${callWord} last week, averaging ${avgCoachScoreLastWeek} — ${overallTier(avgCoachScoreLastWeek).label.toLowerCase()}`

  const tasksPart =
    tasksDueThisWeek === 0
      ? 'nothing due this week'
      : `${tasksDueThisWeek} task${tasksDueThisWeek === 1 ? '' : 's'} due this week`

  return `${callsPart}; ${tasksPart}.`
}
