import { isToday } from 'date-fns'
import type { CallSummary } from '@renderer/features/calls/types'
import type { Task } from '@renderer/features/tasks/types'

export interface HomeStats {
  callsToday: number
  talkTimeTodayMs: number
  tasksDue: number
}

/** Deterministic Home stat-row numbers from data already on disk — no new
 *  storage, no aggregation dependency on the coaching-only analytics module. */
export function computeHomeStats(calls: CallSummary[], tasks: Task[]): HomeStats {
  const todaysCalls = calls.filter((c) => isToday(new Date(c.createdAt)))
  return {
    callsToday: todaysCalls.length,
    talkTimeTodayMs: todaysCalls.reduce((sum, c) => sum + c.durationMs, 0),
    tasksDue: tasks.filter((t) => t.status === 'open').length
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
