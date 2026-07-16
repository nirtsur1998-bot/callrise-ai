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
import { EmptyState } from '@renderer/components/EmptyState'
import { Badge } from '@renderer/components/Badge'
import { Button } from '@renderer/components/Button'
import { IconButton } from '@renderer/components/IconButton'
import { PageHeader } from '@renderer/components/PageHeader'
import { SegmentedControl } from '@renderer/components/SegmentedControl'
import { SkeletonRows } from '@renderer/components/Skeleton'
import { useToast } from '@renderer/features/notifications/useToast'
import { useTasks } from './useTasks'
import { TaskFormDialog, type TaskFormValues } from './TaskFormDialog'
import { formatDueLabel, dueBucket, type DueBucket } from './format'
import { TASK_TYPE_META, PRIORITY_META } from './meta'
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

const BUCKET_ORDER: DueBucket[] = ['overdue', 'today', 'soon', 'later', 'none']
const BUCKET_LABEL: Record<DueBucket, string> = {
  overdue: 'Overdue',
  today: 'Today',
  soon: 'This week',
  later: 'Later',
  none: 'No due date'
}

/** Groups already-sorted open tasks into due-date buckets, in a fixed order,
 *  dropping empty buckets. */
function bucketOpenTasks(open: Task[]): { bucket: DueBucket; tasks: Task[] }[] {
  const groups = new Map<DueBucket, Task[]>()
  for (const task of open) {
    const b = dueBucket(task.dueAt)
    const list = groups.get(b)
    if (list) list.push(task)
    else groups.set(b, [task])
  }
  return BUCKET_ORDER.filter((b) => groups.has(b)).map((b) => ({
    bucket: b,
    tasks: groups.get(b)!
  }))
}

export function TasksView(): React.JSX.Element {
  const { tasks, loading, create, update, remove, undoDelete } = useTasks()
  const toast = useToast()
  const [filter, setFilter] = useState<Filter>('open')
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Task | null>(null)

  const deleteTask = (task: Task): void => {
    remove(task.id)
    toast.error('Task deleted', { label: 'Undo', onClick: () => undoDelete(task.id) })
  }

  const { open, done } = useMemo(() => {
    return {
      open: tasks.filter((t) => t.status === 'open').sort(compareOpen),
      done: tasks.filter((t) => t.status === 'done').sort(compareDone)
    }
  }, [tasks])

  const visible = filter === 'open' ? open : filter === 'done' ? done : [...open, ...done]

  const toggle = (task: Task): Promise<void> =>
    update(task.id, { status: task.status === 'done' ? 'open' : 'done' })

  const filterOptions = FILTERS.map((f) => ({
    id: f.id,
    label: `${f.label} ${f.id === 'open' ? open.length : f.id === 'done' ? done.length : tasks.length}`
  }))

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Tasks"
        count={`${tasks.length} total`}
        subtitle="Reminders only — completing a task won't send emails or schedule anything."
        actions={
          <Button onClick={() => setAdding(true)} icon={Plus}>
            Add task
          </Button>
        }
      />

      {/* Filter tabs */}
      <div className="mb-4">
        <SegmentedControl options={filterOptions} value={filter} onChange={setFilter} />
      </div>

      {/* Body */}
      {loading ? (
        <SkeletonRows rows={4} />
      ) : tasks.length === 0 ? (
        <EmptyAll onAdd={() => setAdding(true)} />
      ) : visible.length === 0 ? (
        <EmptyState
          compact
          icon={CheckCircle2}
          title="All caught up"
          description={filter === 'open' ? 'No open tasks right now.' : 'No completed tasks yet.'}
        />
      ) : filter === 'open' ? (
        <ul className="space-y-2.5">
          {bucketOpenTasks(visible).map(({ bucket, tasks: bucketTasks }) => (
            <li key={bucket}>
              <div className="mb-1.5 flex items-center gap-2 px-1 text-[11px] font-medium tracking-wide text-faint uppercase">
                {BUCKET_LABEL[bucket]}
                <span className="text-faint/70">{bucketTasks.length}</span>
              </div>
              <ul className="space-y-2.5">
                {bucketTasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    onToggle={() => void toggle(task)}
                    onEdit={() => setEditing(task)}
                    onDelete={() => deleteTask(task)}
                  />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="space-y-2.5">
          {visible.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              onToggle={() => void toggle(task)}
              onEdit={() => setEditing(task)}
              onDelete={() => deleteTask(task)}
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
  const done = task.status === 'done'
  const typeMeta = TASK_TYPE_META[task.type]
  const TypeIcon = typeMeta.icon
  const prio = PRIORITY_META[task.priority]
  const due = formatDueLabel(task.dueAt)

  const dueTone = due
    ? due.tone === 'overdue'
      ? 'danger'
      : due.tone === 'today'
        ? 'warning'
        : 'neutral'
    : 'neutral'

  return (
    <li>
      <div
        className={cn(
          'group flex items-start gap-3 rounded-xl border border-line-soft bg-surface px-4 py-3.5 transition hover:border-line hover:bg-elevated',
          done && 'opacity-60'
        )}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-label={done ? 'Mark as open' : 'Mark as done'}
          aria-pressed={done}
          className="press -m-1 mt-0.5 shrink-0 rounded-lg p-1 text-faint transition hover:bg-elevated hover:text-accent"
        >
          {done ? <CheckCircle2 className="h-5 w-5 text-accent" /> : <Circle className="h-5 w-5" />}
        </button>

        <div className="min-w-0 flex-1">
          <p
            className={cn('line-clamp-2 text-sm font-medium', done && 'text-faint line-through')}
            title={task.title}
          >
            {task.title}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-faint">
            <Badge tone={prio.tone}>{prio.label}</Badge>
            {due && (
              <Badge tone={dueTone} icon={CalendarClock}>
                {due.text}
              </Badge>
            )}
            <span className="flex items-center gap-1">
              <TypeIcon className="h-3 w-3" /> {typeMeta.label}
            </span>
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
          <IconButton
            icon={Pencil}
            label="Edit task"
            onClick={onEdit}
            className="press opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent/40"
          />
          <IconButton
            icon={Trash2}
            label="Delete task"
            variant="danger"
            onClick={onDelete}
            className="press opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent/40"
          />
        </div>
      </div>
    </li>
  )
}

function EmptyAll({ onAdd }: { onAdd: () => void }): React.JSX.Element {
  return (
    <EmptyState
      icon={ListChecks}
      title="No tasks yet"
      description="Open a saved call and choose “Generate tasks”, or add one yourself."
      action={{ label: 'Add task', onClick: onAdd, icon: Plus }}
    />
  )
}
