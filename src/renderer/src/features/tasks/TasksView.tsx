import { useMemo, useState } from 'react'
import {
  Plus,
  ListChecks,
  Circle,
  CheckCircle2,
  CalendarClock,
  Building2,
  PhoneCall,
  Pencil,
  Trash2
} from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { useTasks } from './useTasks'
import { TaskFormDialog, type TaskFormValues } from './TaskFormDialog'
import { formatDueLabel } from './format'
import { TASK_TYPE_META, PRIORITY_META, DUE_TONE_CLASS } from './meta'
import type { Task } from './types'

type Filter = 'open' | 'done' | 'all'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'done', label: 'Done' },
  { id: 'all', label: 'All' }
]

/** Open tasks: soonest due first, then by priority, then newest. */
function compareOpen(a: Task, b: Task): number {
  const da = a.dueAt ? new Date(a.dueAt).getTime() : Infinity
  const db = b.dueAt ? new Date(b.dueAt).getTime() : Infinity
  if (da !== db) return da - db
  const pr = PRIORITY_META[a.priority].rank - PRIORITY_META[b.priority].rank
  if (pr !== 0) return pr
  return b.createdAt.localeCompare(a.createdAt)
}

/** Done tasks: most recently completed first. */
function compareDone(a: Task, b: Task): number {
  return (b.completedAt ?? b.createdAt).localeCompare(a.completedAt ?? a.createdAt)
}

export function TasksView(): React.JSX.Element {
  const { tasks, loading, create, update, remove } = useTasks()
  const [filter, setFilter] = useState<Filter>('open')
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Task | null>(null)

  const { open, done } = useMemo(() => {
    return {
      open: tasks.filter((t) => t.status === 'open').sort(compareOpen),
      done: tasks.filter((t) => t.status === 'done').sort(compareDone)
    }
  }, [tasks])

  const visible = filter === 'open' ? open : filter === 'done' ? done : [...open, ...done]

  const toggle = (task: Task): Promise<void> =>
    update(task.id, { status: task.status === 'done' ? 'open' : 'done' })

  return (
    <div className="mx-auto max-w-3xl">
      {/* Header */}
      <div className="mb-1 flex items-center justify-between">
        <div className="flex items-baseline gap-2.5">
          <h2 className="text-lg font-semibold tracking-tight">Tasks</h2>
          <span className="text-[13px] text-faint">{tasks.length} total</span>
        </div>
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition hover:brightness-110"
        >
          <Plus className="h-4 w-4" /> Add task
        </button>
      </div>
      <p className="mb-5 text-[13px] text-faint">
        Reminders only — completing a task won&apos;t send emails or schedule anything.
      </p>

      {/* Filter tabs */}
      <div className="mb-4 flex items-center gap-1">
        {FILTERS.map((f) => {
          const count = f.id === 'open' ? open.length : f.id === 'done' ? done.length : tasks.length
          const isActive = filter === f.id
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={cn(
                'rounded-lg px-3 py-1.5 text-[13px] font-medium transition',
                isActive ? 'bg-accent-soft text-ink' : 'text-muted hover:bg-elevated hover:text-ink'
              )}
            >
              {f.label}{' '}
              <span className={cn('ml-0.5', isActive ? 'text-accent' : 'text-faint')}>{count}</span>
            </button>
          )
        })}
      </div>

      {/* Body */}
      {loading ? (
        <div className="flex h-40 items-center justify-center text-sm text-faint">Loading…</div>
      ) : tasks.length === 0 ? (
        <EmptyAll onAdd={() => setAdding(true)} />
      ) : visible.length === 0 ? (
        <p className="rounded-xl border border-line-soft bg-surface px-4 py-8 text-center text-sm text-muted">
          {filter === 'open' ? "No open tasks — you're all caught up." : 'No completed tasks yet.'}
        </p>
      ) : (
        <ul className="space-y-2.5">
          {visible.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              onToggle={() => void toggle(task)}
              onEdit={() => setEditing(task)}
              onDelete={() => void remove(task.id)}
            />
          ))}
        </ul>
      )}

      {adding && (
        <TaskFormDialog
          onClose={() => setAdding(false)}
          onSubmit={async (values: TaskFormValues) => {
            await create({ ...values, source: 'manual' })
            setAdding(false)
          }}
        />
      )}
      {editing && (
        <TaskFormDialog
          task={editing}
          onClose={() => setEditing(null)}
          onSubmit={async (values: TaskFormValues) => {
            await update(editing.id, values)
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

interface TaskRowProps {
  task: Task
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
}

function TaskRow({ task, onToggle, onEdit, onDelete }: TaskRowProps): React.JSX.Element {
  const [confirm, setConfirm] = useState(false)
  const done = task.status === 'done'
  const typeMeta = TASK_TYPE_META[task.type]
  const TypeIcon = typeMeta.icon
  const prio = PRIORITY_META[task.priority]
  const due = formatDueLabel(task.dueAt)

  return (
    <li>
      <div className="group flex items-start gap-3 rounded-xl border border-line-soft bg-surface px-4 py-3.5 transition hover:border-line hover:bg-elevated">
        <button
          type="button"
          onClick={onToggle}
          title={done ? 'Mark as open' : 'Mark as done'}
          className="mt-0.5 shrink-0 text-faint transition hover:text-accent"
        >
          {done ? <CheckCircle2 className="h-5 w-5 text-accent" /> : <Circle className="h-5 w-5" />}
        </button>

        <div className="min-w-0 flex-1">
          <p className={cn('truncate text-sm font-medium', done && 'text-faint line-through')}>
            {task.title}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-faint">
            <span className="flex items-center gap-1">
              <TypeIcon className="h-3 w-3" /> {typeMeta.label}
            </span>
            <span className={cn('rounded-full border px-1.5 py-0.5 font-medium', prio.badge)}>
              {prio.label}
            </span>
            {due && (
              <span
                className={cn(
                  'flex items-center gap-1',
                  done ? 'text-faint' : DUE_TONE_CLASS[due.tone]
                )}
              >
                <CalendarClock className="h-3 w-3" /> {due.text}
              </span>
            )}
            {task.clientName && (
              <span className="flex items-center gap-1">
                <Building2 className="h-3 w-3" /> {task.clientName}
              </span>
            )}
            {task.callTitle && (
              <span className="flex items-center gap-1">
                <PhoneCall className="h-3 w-3" /> {task.callTitle}
              </span>
            )}
          </div>
          {task.note && (
            <p className={cn('mt-1.5 text-[12px]', done ? 'text-faint' : 'text-muted')}>
              {task.note}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {confirm ? (
            <>
              <button
                type="button"
                onClick={onDelete}
                className="rounded-lg bg-rose-500/20 px-2.5 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-500/30"
              >
                Delete
              </button>
              <button
                type="button"
                onClick={() => setConfirm(false)}
                className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted hover:text-ink"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onEdit}
                title="Edit task"
                className="grid h-8 w-8 place-items-center rounded-lg text-faint opacity-0 transition hover:bg-canvas hover:text-ink group-hover:opacity-100"
              >
                <Pencil className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setConfirm(true)}
                title="Delete task"
                className="grid h-8 w-8 place-items-center rounded-lg text-faint opacity-0 transition hover:bg-canvas hover:text-rose-300 group-hover:opacity-100"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </>
          )}
        </div>
      </div>
    </li>
  )
}

function EmptyAll({ onAdd }: { onAdd: () => void }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-line-soft bg-surface">
        <ListChecks className="h-6 w-6 text-faint" strokeWidth={1.75} />
      </div>
      <h3 className="text-lg font-semibold">No tasks yet</h3>
      <p className="mt-1.5 max-w-xs text-sm text-muted">
        Open a saved call and choose “Generate tasks”, or add one yourself.
      </p>
      <button
        type="button"
        onClick={onAdd}
        className="mt-4 flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition hover:brightness-110"
      >
        <Plus className="h-4 w-4" /> Add task
      </button>
    </div>
  )
}
