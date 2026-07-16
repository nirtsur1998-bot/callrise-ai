import type { LucideIcon } from 'lucide-react'
import { PhoneCall, Mail, CalendarClock, Search, Circle } from 'lucide-react'
import type { BadgeTone } from '@renderer/components/Badge'
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

export const PRIORITY_META: Record<TaskPriority, { label: string; tone: BadgeTone; rank: number }> =
  {
    high: { label: 'High', tone: 'danger', rank: 0 },
    medium: { label: 'Medium', tone: 'warning', rank: 1 },
    low: { label: 'Low', tone: 'neutral', rank: 2 }
  }

/** Stable order for priority <select> options (most urgent first). */
export const PRIORITY_ORDER: TaskPriority[] = ['high', 'medium', 'low']

export const DUE_TONE_CLASS: Record<'overdue' | 'today' | 'soon' | 'later', string> = {
  overdue: 'text-danger',
  today: 'text-warning',
  soon: 'text-ink',
  later: 'text-muted'
}
