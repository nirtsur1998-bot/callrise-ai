import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export type TaskType = 'follow-up' | 'email' | 'meeting' | 'research' | 'general'
export type TaskPriority = 'low' | 'medium' | 'high'
export type TaskStatus = 'open' | 'done'
export type TaskSource = 'ai' | 'manual'

/** A saved task (what's stored on disk: one JSON file per task). */
export interface Task {
  id: string
  title: string
  type: TaskType
  priority: TaskPriority
  status: TaskStatus
  /** Absolute due date as an ISO timestamp. Omitted when there's no deadline. */
  dueAt?: string
  /** Free-text client / company / person this relates to (no CRM yet). */
  clientName?: string
  /** One short line of extra context. */
  note?: string
  /** The call this task was generated from, if any. */
  callId?: string
  /** Denormalized call title, so the Tasks list needn't load every call. */
  callTitle?: string
  /** Where the task came from. */
  source: TaskSource
  createdAt: string // ISO timestamp
  /** Last modification (create or any edit), ISO timestamp — the ordering key a
   *  future cloud backup uses for "newest wins". Backfilled from createdAt for
   *  tasks saved before this field existed. */
  updatedAt: string
  /** Set when status flips to 'done'; cleared when reopened. */
  completedAt?: string
}

/** Fields the renderer may send when creating a task (AI-accepted or manual). */
export interface TaskCreateInput {
  title?: unknown
  type?: unknown
  priority?: unknown
  status?: unknown
  dueAt?: unknown
  clientName?: unknown
  note?: unknown
  callId?: unknown
  callTitle?: unknown
  source?: unknown
}

/**
 * Fields the renderer may change. A key present with `null` clears that
 * optional field; a key that's absent leaves the existing value untouched.
 */
export interface TaskUpdateInput {
  title?: unknown
  type?: unknown
  priority?: unknown
  status?: unknown
  dueAt?: unknown
  clientName?: unknown
  note?: unknown
}

// Ids are used to build file paths, so they must be tightly constrained
// (no "../", no slashes) to prevent path traversal.
const ID_RE = /^[A-Za-z0-9-]{1,64}$/
const MAX_TITLE = 300
const MAX_NOTE = 1000
const MAX_CLIENT = 200
const MAX_CALL_TITLE = 200

const TASK_TYPES = new Set<TaskType>(['follow-up', 'email', 'meeting', 'research', 'general'])
const PRIORITIES = new Set<TaskPriority>(['low', 'medium', 'high'])
const STATUSES = new Set<TaskStatus>(['open', 'done'])

export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id)
}

function sanitizeType(value: unknown): TaskType {
  return typeof value === 'string' && TASK_TYPES.has(value as TaskType)
    ? (value as TaskType)
    : 'general'
}

function sanitizePriority(value: unknown): TaskPriority {
  return typeof value === 'string' && PRIORITIES.has(value as TaskPriority)
    ? (value as TaskPriority)
    : 'medium'
}

function sanitizeStatus(value: unknown): TaskStatus {
  return typeof value === 'string' && STATUSES.has(value as TaskStatus)
    ? (value as TaskStatus)
    : 'open'
}

/** Trim, collapse newlines, and bound a free-text string. Empty -> undefined. */
function sanitizeOptionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, max)
  return clean ? clean : undefined
}

/** Accept an ISO-ish date string; anything unparseable becomes undefined. */
function sanitizeDueAt(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const t = Date.parse(value)
  return Number.isNaN(t) ? undefined : new Date(t).toISOString()
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

async function writeTask(dir: string, task: Task): Promise<void> {
  await fs.writeFile(join(dir, `${task.id}.json`), JSON.stringify(task, null, 2), 'utf8')
}

/** Coerce an untrusted parsed object into a clean Task, or null if unusable. */
function sanitizeTaskRecord(value: unknown): Task | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (!isSafeId(v.id)) return null
  const title = sanitizeOptionalText(v.title, MAX_TITLE)
  if (!title) return null
  const status = sanitizeStatus(v.status)
  const createdAt =
    typeof v.createdAt === 'string' && !Number.isNaN(Date.parse(v.createdAt))
      ? v.createdAt
      : new Date().toISOString()
  // Preserve updatedAt across the read/write round-trip; backfill from createdAt
  // for tasks written before this field existed (so it's never dropped/missing).
  const updatedAt =
    typeof v.updatedAt === 'string' && !Number.isNaN(Date.parse(v.updatedAt))
      ? v.updatedAt
      : createdAt
  return {
    id: v.id,
    title,
    type: sanitizeType(v.type),
    priority: sanitizePriority(v.priority),
    status,
    dueAt: sanitizeDueAt(v.dueAt),
    clientName: sanitizeOptionalText(v.clientName, MAX_CLIENT),
    note: sanitizeOptionalText(v.note, MAX_NOTE),
    callId: isSafeId(v.callId) ? v.callId : undefined,
    callTitle: sanitizeOptionalText(v.callTitle, MAX_CALL_TITLE),
    source: v.source === 'ai' ? 'ai' : 'manual',
    createdAt,
    updatedAt,
    completedAt:
      status === 'done' ? (sanitizeDueAt(v.completedAt) ?? new Date().toISOString()) : undefined
  }
}

export async function createTask(dir: string, input: TaskCreateInput): Promise<Task> {
  await ensureDir(dir)
  const now = new Date().toISOString()
  const status = sanitizeStatus(input?.status)
  const task: Task = {
    id: randomUUID(),
    title: sanitizeOptionalText(input?.title, MAX_TITLE) ?? 'Untitled task',
    type: sanitizeType(input?.type),
    priority: sanitizePriority(input?.priority),
    status,
    dueAt: sanitizeDueAt(input?.dueAt),
    clientName: sanitizeOptionalText(input?.clientName, MAX_CLIENT),
    note: sanitizeOptionalText(input?.note, MAX_NOTE),
    callId: isSafeId(input?.callId) ? input.callId : undefined,
    callTitle: sanitizeOptionalText(input?.callTitle, MAX_CALL_TITLE),
    source: input?.source === 'ai' ? 'ai' : 'manual',
    createdAt: now,
    updatedAt: now,
    completedAt: status === 'done' ? now : undefined
  }
  await writeTask(dir, task)
  return task
}

export async function listTasks(dir: string): Promise<Task[]> {
  await ensureDir(dir)
  let files: string[]
  try {
    files = await fs.readdir(dir)
  } catch {
    return []
  }
  const tasks: Task[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const raw = await fs.readFile(join(dir, file), 'utf8')
      const task = sanitizeTaskRecord(JSON.parse(raw))
      if (task) tasks.push(task)
    } catch {
      /* skip unreadable / corrupt file */
    }
  }
  // Newest first as a stable default; the renderer applies its own ordering.
  tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return tasks
}

export async function getTask(dir: string, id: string): Promise<Task | null> {
  if (!isSafeId(id)) return null
  try {
    const raw = await fs.readFile(join(dir, `${id}.json`), 'utf8')
    return sanitizeTaskRecord(JSON.parse(raw))
  } catch {
    return null
  }
}

export async function updateTask(
  dir: string,
  id: string,
  patch: TaskUpdateInput
): Promise<Task | null> {
  const task = await getTask(dir, id)
  if (!task) return null
  if (!patch || typeof patch !== 'object') return task

  if ('title' in patch) {
    const next = sanitizeOptionalText(patch.title, MAX_TITLE)
    if (next) task.title = next // never blank out the title
  }
  if ('type' in patch) task.type = sanitizeType(patch.type)
  if ('priority' in patch) task.priority = sanitizePriority(patch.priority)
  if ('status' in patch) {
    const next = sanitizeStatus(patch.status)
    if (next !== task.status) {
      task.status = next
      task.completedAt = next === 'done' ? new Date().toISOString() : undefined
    }
  }
  if ('dueAt' in patch) task.dueAt = sanitizeDueAt(patch.dueAt)
  if ('clientName' in patch) task.clientName = sanitizeOptionalText(patch.clientName, MAX_CLIENT)
  if ('note' in patch) task.note = sanitizeOptionalText(patch.note, MAX_NOTE)

  task.updatedAt = new Date().toISOString() // mark modified (backup ordering key)

  try {
    await writeTask(dir, task)
  } catch {
    return null
  }
  return task
}

export async function deleteTask(dir: string, id: string): Promise<{ ok: boolean }> {
  if (!isSafeId(id)) return { ok: false }
  try {
    await fs.unlink(join(dir, `${id}.json`))
  } catch {
    return { ok: false }
  }
  return { ok: true }
}
