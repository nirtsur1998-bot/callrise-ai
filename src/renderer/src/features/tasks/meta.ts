import type { LucideIcon } from 'lucide-react'
import { PhoneCall, Mail, CalendarClock, Search, Circle } from 'lucide-react'
import type { TaskType, TaskPriority } from './types'

export const TASK_TYPE_META: Record<TaskType, { label: string; icon: LucideIcon }> = {
  'follow-up': { label: 'Follow-up', icon: PhoneCall },
  email: { label: 'Email', icon: Mail },
  meeting: { label: 'Meeting', icon: CalendarClock },
  research: { label: 'Research', icon: Search },
  general: { label: 'General', icon: Circle }
}

/** Stable order for type <select> options. */
export const TASK_TYPE_ORDER: TaskType[] = ['follow-up', 'email', 'meeting', 'research', 'general']

export const PRIORITY_META: Record<
  TaskPriority,
  { label: string; badge: string; dot: string; rank: number }
> = {
  high: {
    label: 'High',
    badge: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
    dot: 'bg-rose-400',
    rank: 0
  },
  medium: {
    label: 'Medium',
    badge: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
    dot: 'bg-amber-400',
    rank: 1
  },
  low: {
    label: 'Low',
    badge: 'border-line bg-elevated text-muted',
    dot: 'bg-slate-500',
    rank: 2
  }
}

/** Stable order for priority <select> options (most urgent first). */
export const PRIORITY_ORDER: TaskPriority[] = ['high', 'medium', 'low']

export const DUE_TONE_CLASS: Record<'overdue' | 'today' | 'soon' | 'later', string> = {
  overdue: 'text-rose-300',
  today: 'text-amber-200',
  soon: 'text-ink',
  later: 'text-muted'
}
