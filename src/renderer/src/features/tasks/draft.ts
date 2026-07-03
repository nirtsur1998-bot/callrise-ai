import type { TaskType, TaskPriority } from './types'

/** The editable shape of a task, shared by AI review and manual add/edit. */
export interface TaskDraft {
  title: string
  type: TaskType
  priority: TaskPriority
  dueAt?: string
  clientName: string
  note: string
}

export function emptyDraft(): TaskDraft {
  return { title: '', type: 'general', priority: 'medium', clientName: '', note: '' }
}
