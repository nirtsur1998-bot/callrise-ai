// Renderer-side task types. These mirror the shapes exposed by the preload
// bridge (see src/preload/index.d.ts); kept local so the feature is
// self-contained, matching the calls feature's convention.

export type TaskType = 'follow-up' | 'email' | 'meeting' | 'research' | 'general'
export type TaskPriority = 'low' | 'medium' | 'high'
export type TaskStatus = 'open' | 'done'
export type TaskSource = 'ai' | 'manual'

export interface Task {
  id: string
  title: string
  type: TaskType
  priority: TaskPriority
  status: TaskStatus
  dueAt?: string
  clientName?: string
  note?: string
  callId?: string
  callTitle?: string
  source: TaskSource
  createdAt: string
  completedAt?: string
}

/** A task Claude proposes from a call (not yet saved). */
export interface ProposedTask {
  title: string
  type: TaskType
  priority: TaskPriority
  dueAt?: string
  clientName?: string
  note?: string
}

export type GenerateTasksResult =
  { ok: true; tasks: ProposedTask[] } | { ok: false; error: 'no-key' | 'failed'; message?: string }
