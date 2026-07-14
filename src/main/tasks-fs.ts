import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeJsonAtomic } from './atomic-write'

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
  /** The contact this task is tied to, if any — set automatically when a
   *  follow-up task is created, or backfilled from callId's contact when an
   *  AI-generated task is accepted. Powers the follow-up dashboard. */
  contactId?: string
  /** The specific deal this task is tied to, if any (a contact may have more
   *  than one open deal; this pins it to one). */
  dealId?: string
  /** Where the task came from. */
  source: TaskSource
  createdAt: string // ISO timestamp
  /** Last modification (create or any edit), ISO timestamp — the ordering key a
   *  future cloud backup uses for "newest wins". Backfilled from createdAt for
   *  tasks saved before this field existed. */
  updatedAt: string
  /** Set when status flips to 'done'; cleared when reopened. */
  completedAt?: string
  /** Tombstone: a deleted task is kept (not erased) so the deletion can
   *  propagate to a future cloud backup. Hidden from every normal listing. */
  deleted?: boolean
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
  contactId?: unknown
  dealId?: unknown
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
  await writeJsonAtomic(join(dir, `${task.id}.json`), task)
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
    contactId: isSafeId(v.contactId) ? v.contactId : undefined,
    dealId: isSafeId(v.dealId) ? v.dealId : undefined,
    source: v.source === 'ai' ? 'ai' : 'manual',
    createdAt,
    updatedAt,
    completedAt:
      status === 'done' ? (sanitizeDueAt(v.completedAt) ?? new Date().toISOString()) : undefined,
    deleted: v.deleted === true ? true : undefined // preserve the tombstone flag
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
    contactId: isSafeId(input?.contactId) ? input.contactId : undefined,
    dealId: isSafeId(input?.dealId) ? input.dealId : undefined,
    source: input?.source === 'ai' ? 'ai' : 'manual',
    createdAt: now,
    updatedAt: now,
    completedAt: status === 'done' ? now : undefined
  }
  await writeTask(dir, task)
  return task
}

export async function listTasks(dir: string, opts?: { includeDeleted?: boolean }): Promise<Task[]> {
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
      // Tombstones stay hidden from the app; the backup reads them via includeDeleted.
      if (task && (opts?.includeDeleted || !task.deleted)) tasks.push(task)
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
    const task = sanitizeTaskRecord(JSON.parse(raw))
    return task && !task.deleted ? task : null // a tombstone reads as "gone"
  } catch {
    return null
  }
}

// ── Per-task write lock ───────────────────────────────────────────────────────
// updateTask/deleteTask are read-then-write (getTask → mutate → writeTask), so
// two concurrent IPC calls for the SAME task id could each read the old record
// and the second write would silently drop the first's changes. This chains all
// mutations for a given id so each one runs after the previous settles.
// (Deliberately duplicated from events.ts to keep this file self-contained.)
const taskLocks = new Map<string, Promise<unknown>>()

function withTaskLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = taskLocks.get(id) ?? Promise.resolve()
  const result = prev.then(fn, fn) // run after prev settles, regardless of its outcome
  const gate = result.then(
    () => {},
    () => {}
  )
  taskLocks.set(id, gate)
  void gate.finally(() => {
    if (taskLocks.get(id) === gate) taskLocks.delete(id) // drop only if we're still the tail
  })
  return result
}

export function updateTask(dir: string, id: string, patch: TaskUpdateInput): Promise<Task | null> {
  if (!isSafeId(id)) return Promise.resolve(null)
  return withTaskLock(id, () => updateTaskUnlocked(dir, id, patch))
}

async function updateTaskUnlocked(
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

export function deleteTask(dir: string, id: string): Promise<{ ok: boolean }> {
  if (!isSafeId(id)) return Promise.resolve({ ok: false })
  return withTaskLock(id, () => deleteTaskUnlocked(dir, id))
}

async function deleteTaskUnlocked(dir: string, id: string): Promise<{ ok: boolean }> {
  const task = await getTask(dir, id)
  if (!task) return { ok: false } // missing or already a tombstone
  // Tombstone instead of erase, so the deletion can propagate to a future backup.
  task.deleted = true
  task.updatedAt = new Date().toISOString()
  try {
    await writeTask(dir, task)
  } catch {
    return { ok: false }
  }
  return { ok: true }
}

/**
 * ID-PRESERVING importer for restore. Writes a cloud payload as a local task,
 * keeping its original id (so re-pulls are idempotent and can't duplicate) and
 * re-running the full sanitizer (so a tampered cloud payload can't plant an
 * unsafe id/path or malformed fields). NEVER used by normal create/update.
 *
 * `onlyIfNewer` re-reads the CURRENT on-disk record at write time and skips
 * unless the incoming version is strictly newer — so a user edit or delete that
 * lands while a restore is running (after its snapshot) can never be clobbered
 * by stale cloud data.
 */
export async function importTask(
  dir: string,
  payload: unknown,
  opts?: { onlyIfNewer?: boolean }
): Promise<Task | null> {
  const task = sanitizeTaskRecord(payload)
  if (!task) return null
  if (opts?.onlyIfNewer) {
    try {
      const raw = await fs.readFile(join(dir, `${task.id}.json`), 'utf8')
      const current = sanitizeTaskRecord(JSON.parse(raw)) // raw: tombstones included
      if (current && Date.parse(current.updatedAt) >= Date.parse(task.updatedAt)) return null
    } catch {
      /* no current record (or unreadable) — proceed with the import */
    }
  }
  await ensureDir(dir)
  try {
    await writeTask(dir, task)
  } catch {
    return null
  }
  return task
}
