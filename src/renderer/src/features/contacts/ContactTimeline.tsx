import { useMemo, useState } from 'react'
import { PhoneCall, TrendingUp, TrendingDown, ListChecks, CheckCircle2 } from 'lucide-react'
import { formatDuration } from '@renderer/features/calls/format'
import { formatRelative } from './contactStats'
import { useTasks } from '@renderer/features/tasks/useTasks'
import type { LinkedCall } from './useContactCallHistory'
import type { Deal, DealStage } from '@renderer/features/deals/types'

interface ContactTimelineProps {
  contactId: string
  linked: LinkedCall[]
  deals: Deal[]
  stages: DealStage[]
}

type TimelineEntry =
  | { type: 'call'; at: string; key: string; title: string; durationMs: number }
  | {
      type: 'stage-change'
      at: string
      key: string
      dealTitle: string
      fromLabel: string
      toLabel: string
      forward: boolean
    }
  | { type: 'task'; at: string; key: string; title: string; done: boolean }

const INITIAL_LIMIT = 15

/** One merged, chronological feed of everything that happened with this
 *  contact — calls, deal stage moves, and their linked tasks — so the story
 *  of the relationship reads as one timeline instead of three separate
 *  lists. Read-only: purely a view over data the app already has. */
export function ContactTimeline({
  contactId,
  linked,
  deals,
  stages
}: ContactTimelineProps): React.JSX.Element {
  const { tasks, loading: tasksLoading } = useTasks()
  const [expanded, setExpanded] = useState(false)

  const stageLabel = useMemo(() => {
    const byId = new Map(stages.map((s) => [s.id, s.label]))
    return (id: string): string => byId.get(id) ?? 'Unknown stage'
  }, [stages])

  const entries = useMemo<TimelineEntry[]>(() => {
    const out: TimelineEntry[] = []

    for (const { call } of linked) {
      out.push({
        type: 'call',
        at: call.createdAt,
        key: `call:${call.id}`,
        title: call.title,
        durationMs: call.durationMs
      })
    }

    const contactDeals = deals.filter((d) => d.contactId === contactId)
    for (const deal of contactDeals) {
      const history = deal.stageHistory ?? []
      history.forEach((change, i) => {
        // The stage this change moved INTO is whatever comes next: the
        // following history entry's stage, or — if this was the last
        // recorded transition — the deal's current stage.
        const toStageId = history[i + 1]?.stageId ?? deal.stageId
        const fromIdx = stages.findIndex((s) => s.id === change.stageId)
        const toIdx = stages.findIndex((s) => s.id === toStageId)
        out.push({
          type: 'stage-change',
          at: change.changedAt,
          key: `stage:${deal.id}:${i}`,
          dealTitle: deal.title,
          fromLabel: stageLabel(change.stageId),
          toLabel: stageLabel(toStageId),
          forward: fromIdx === -1 || toIdx === -1 ? true : toIdx > fromIdx
        })
      })
    }

    const contactTasks = tasks.filter((t) => t.contactId === contactId)
    for (const task of contactTasks) {
      out.push({
        type: 'task',
        at: task.completedAt ?? task.createdAt,
        key: `task:${task.id}`,
        title: task.title,
        done: task.status === 'done'
      })
    }

    out.sort((a, b) => b.at.localeCompare(a.at))
    return out
  }, [linked, deals, stages, stageLabel, tasks, contactId])

  const visible = expanded ? entries : entries.slice(0, INITIAL_LIMIT)

  if (!tasksLoading && entries.length === 0) {
    return <p className="text-[13px] text-faint">No activity yet.</p>
  }

  return (
    <div>
      <ul className="border-l-2 border-line-soft space-y-4 pl-4">
        {visible.map((entry) => (
          <TimelineRow key={entry.key} entry={entry} />
        ))}
      </ul>

      {!expanded && entries.length > INITIAL_LIMIT && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="press mt-3 text-[13px] font-medium text-accent hover:underline"
        >
          Show {entries.length - INITIAL_LIMIT} more
        </button>
      )}
    </div>
  )
}

function TimelineRow({ entry }: { entry: TimelineEntry }): React.JSX.Element {
  const dot = dotClass(entry)

  return (
    <li className="relative">
      <span
        className={`absolute -ml-[21px] mt-0.5 grid h-3.5 w-3.5 place-items-center rounded-full ${dot}`}
      >
        <TimelineIcon entry={entry} />
      </span>
      <p className="text-[13px] text-ink">{describe(entry)}</p>
      <p className="text-[11px] text-faint tabular-nums">{formatRelative(entry.at)}</p>
    </li>
  )
}

function dotClass(entry: TimelineEntry): string {
  switch (entry.type) {
    case 'call':
      return 'bg-accent'
    case 'stage-change':
      return entry.forward ? 'bg-positive' : 'bg-warning'
    case 'task':
      return entry.done ? 'bg-positive' : 'bg-warning'
  }
}

function TimelineIcon({ entry }: { entry: TimelineEntry }): React.JSX.Element {
  const cls = 'h-2 w-2 text-white'
  switch (entry.type) {
    case 'call':
      return <PhoneCall className={cls} strokeWidth={3} />
    case 'stage-change':
      return entry.forward ? (
        <TrendingUp className={cls} strokeWidth={3} />
      ) : (
        <TrendingDown className={cls} strokeWidth={3} />
      )
    case 'task':
      return entry.done ? (
        <CheckCircle2 className={cls} strokeWidth={3} />
      ) : (
        <ListChecks className={cls} strokeWidth={3} />
      )
  }
}

function describe(entry: TimelineEntry): string {
  switch (entry.type) {
    case 'call':
      return `Called — ${entry.title} (${formatDuration(entry.durationMs)})`
    case 'stage-change':
      return `${entry.dealTitle}: moved from ${entry.fromLabel} → ${entry.toLabel}`
    case 'task':
      return `Task: ${entry.title} — ${entry.done ? 'done' : 'open'}`
  }
}
