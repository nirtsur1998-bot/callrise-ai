import { ListChecks, ShieldAlert } from 'lucide-react'
import { formatDate, formatDuration } from '@renderer/features/calls/format'
import type { Call } from '@renderer/features/calls/types'
import type { Task } from '@renderer/features/tasks/types'
import type { LinkedCall } from './useContactCallHistory'

interface CallHistoryListProps {
  loading: boolean
  linked: LinkedCall[]
  emptyMessage: string
}

/** The shared "calls with this person" list — used by both the Contact
 *  detail view and a Deal's linked-contact history, so they show identical
 *  context (summary, objections from coaching, generated tasks) per call. */
export function CallHistoryList({
  loading,
  linked,
  emptyMessage
}: CallHistoryListProps): React.JSX.Element {
  if (loading) return <HistorySkeleton />
  if (linked.length === 0) {
    return (
      <p className="rounded-xl border border-line-soft bg-surface px-4 py-8 text-center text-sm text-muted">
        {emptyMessage}
      </p>
    )
  }
  return (
    <ul className="space-y-3">
      {linked.map(({ call, tasks }) => (
        <LinkedCallCard key={call.id} call={call} tasks={tasks} />
      ))}
    </ul>
  )
}

export function HistorySkeleton(): React.JSX.Element {
  return (
    <ul className="space-y-3">
      {[0, 1].map((i) => (
        <li key={i} className="rounded-xl border border-line-soft bg-surface p-5">
          <div className="flex items-center justify-between">
            <div className="h-4 w-40 animate-pulse rounded bg-elevated" />
            <div className="h-3 w-24 animate-pulse rounded bg-elevated" />
          </div>
          <div className="mt-3 h-3 w-full animate-pulse rounded bg-elevated" />
          <div className="mt-2 h-3 w-2/3 animate-pulse rounded bg-elevated" />
        </li>
      ))}
    </ul>
  )
}

function LinkedCallCard({ call, tasks }: { call: Call; tasks: Task[] }): React.JSX.Element {
  const objection = call.coaching?.dimensions.find((d) => d.key === 'objection')

  return (
    <li className="rounded-xl border border-line-soft bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">{call.title}</p>
        <div className="flex items-center gap-3 text-[11px] text-faint">
          <span>{formatDate(call.createdAt)}</span>
          <span>{formatDuration(call.durationMs)}</span>
        </div>
      </div>

      {call.summary ? (
        <p className="mt-2 text-[13px] text-muted">{call.summary.executive}</p>
      ) : (
        <p className="mt-2 text-[13px] text-faint">No AI summary generated for this call.</p>
      )}

      {objection?.comment && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-line-soft bg-canvas px-3 py-2.5">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-wide text-faint">Objections</p>
            <p className="mt-0.5 text-[13px] text-muted">{objection.comment}</p>
            {objection.evidence?.verified && (
              <p className="mt-1 text-[12px] italic text-faint">“{objection.evidence.quote}”</p>
            )}
          </div>
        </div>
      )}

      {tasks.length > 0 && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-line-soft bg-canvas px-3 py-2.5">
          <ListChecks className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium uppercase tracking-wide text-faint">
              Tasks ({tasks.length})
            </p>
            <ul className="mt-1 space-y-0.5">
              {tasks.map((t) => (
                <li key={t.id} className="truncate text-[13px] text-muted">
                  {t.status === 'done' ? '✓ ' : '• '}
                  {t.title}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </li>
  )
}
