import { useEffect, useRef, useState } from 'react'
import { isToday, isYesterday, isThisWeek } from 'date-fns'
import { Trash2, Clock, Users, PhoneCall, Sparkles, Paperclip } from 'lucide-react'
import { EmptyState } from '@renderer/components/EmptyState'
import { PageHeader } from '@renderer/components/PageHeader'
import { IconButton } from '@renderer/components/IconButton'
import { SkeletonRows } from '@renderer/components/Skeleton'
import { Badge } from '@renderer/components/Badge'
import { overallTier, TONE_TO_BADGE } from '@renderer/features/coaching/meta'
import { useToast } from '@renderer/features/notifications/useToast'
import { useCalls } from './useCalls'
import { CallDetail } from './CallDetail'
import { formatDate, formatDuration } from './format'

interface PastCallsViewProps {
  /** AI Note Taker's "auto-open meeting page" — preselects this call on mount. */
  initialSelectedId?: string | null
  /** Called once the initial selection above has been applied, so the parent
   *  can clear it (otherwise a later plain visit would reopen the same call). */
  onInitialSelectionConsumed?: () => void
}

export function PastCallsView({
  initialSelectedId = null,
  onInitialSelectionConsumed
}: PastCallsViewProps = {}): React.JSX.Element {
  const { calls, loading, remove, undoDelete, refresh } = useCalls()
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId)
  const toast = useToast()

  const consumedRef = useRef(false)
  useEffect(() => {
    if (initialSelectedId && !consumedRef.current) {
      consumedRef.current = true
      onInitialSelectionConsumed?.()
    }
  }, [initialSelectedId, onInitialSelectionConsumed])

  // --- Detail view ---------------------------------------------------------
  if (selectedId) {
    return (
      <CallDetail
        callId={selectedId}
        onBack={() => setSelectedId(null)}
        onDeleted={() => setSelectedId(null)}
        onChanged={refresh}
      />
    )
  }

  // --- List view -----------------------------------------------------------
  if (loading) {
    return (
      <div className="mx-auto max-w-3xl">
        <SkeletonRows rows={5} />
      </div>
    )
  }

  if (calls.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          icon={PhoneCall}
          title="No saved calls yet"
          titleAs="h2"
          description="Start a live call and stop it — it’ll be saved here automatically, with a transcript and summary."
        />
      </div>
    )
  }

  // Bucket into Today / Yesterday / This week / Earlier, in that order, each
  // preserving the calls' existing (already-sorted) order within it.
  const buckets: { label: string; calls: typeof calls }[] = [
    { label: 'Today', calls: [] },
    { label: 'Yesterday', calls: [] },
    { label: 'This week', calls: [] },
    { label: 'Earlier', calls: [] }
  ]
  for (const call of calls) {
    const created = new Date(call.createdAt)
    if (isToday(created)) buckets[0].calls.push(call)
    else if (isYesterday(created)) buckets[1].calls.push(call)
    else if (isThisWeek(created)) buckets[2].calls.push(call)
    else buckets[3].calls.push(call)
  }

  let rowIndex = 0

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Past Calls"
        count={`${calls.length} call${calls.length === 1 ? '' : 's'}`}
      />
      <ul className="space-y-2.5">
        {buckets.flatMap((bucket) => {
          if (bucket.calls.length === 0) return []
          const rows = bucket.calls.map((call) => {
            const delayIndex = Math.min(rowIndex, 8)
            rowIndex += 1
            return (
              <li
                key={call.id}
                className="stagger-item"
                style={{ animationDelay: `${delayIndex * 35}ms` }}
              >
                <div className="group flex items-center gap-4 rounded-xl border border-line-soft bg-surface px-4 py-3.5 transition hover:border-line hover:bg-elevated">
                  <button
                    type="button"
                    onClick={() => setSelectedId(call.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex items-center gap-2">
                      <p className="truncate font-medium">{call.title}</p>
                      {call.hasCoaching && call.coachScore !== undefined && (
                        <Badge tone={TONE_TO_BADGE[overallTier(call.coachScore).tone]}>
                          <span className="tabular-nums">{call.coachScore}</span>
                        </Badge>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-[13px] text-muted">
                      {call.preview || <span className="italic text-faint">No transcript</span>}
                    </p>
                    <div className="mt-1.5 flex items-center gap-3 text-[11px] text-faint">
                      <span>{formatDate(call.createdAt)}</span>
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />{' '}
                        <span className="tabular-nums">{formatDuration(call.durationMs)}</span>
                      </span>
                      <span className="flex items-center gap-1">
                        <Users className="h-3 w-3" />{' '}
                        <span className="tabular-nums">{call.speakerCount}</span>
                      </span>
                      {call.hasSummary && (
                        <span className="flex items-center gap-1 text-accent">
                          <Sparkles className="h-3 w-3" /> Summary
                        </span>
                      )}
                      {call.attachmentCount > 0 && (
                        <span className="flex items-center gap-1">
                          <Paperclip className="h-3 w-3" />{' '}
                          <span className="tabular-nums">{call.attachmentCount}</span>
                        </span>
                      )}
                    </div>
                  </button>
                  <IconButton
                    icon={Trash2}
                    label="Delete call"
                    variant="danger"
                    onClick={async () => {
                      await remove(call.id)
                      toast.error('Call deleted', {
                        label: 'Undo',
                        onClick: () => undoDelete(call.id)
                      })
                    }}
                    className="opacity-60 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
                  />
                </div>
              </li>
            )
          })
          return [
            <li key={`${bucket.label}-label`}>
              <span className="text-[11px] font-medium uppercase tracking-wide text-faint">
                {bucket.label}
              </span>
            </li>,
            ...rows
          ]
        })}
      </ul>
    </div>
  )
}
