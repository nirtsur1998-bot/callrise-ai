import { useEffect, useRef, useState } from 'react'
import { Trash2, Clock, Users, PhoneCall, Sparkles, Paperclip } from 'lucide-react'
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
  const { calls, loading, remove, refresh } = useCalls()
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId)
  const [confirmId, setConfirmId] = useState<string | null>(null)

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
      <div className="flex h-full items-center justify-center text-sm text-faint">Loading…</div>
    )
  }

  if (calls.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center">
        <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-line-soft bg-surface">
          <PhoneCall className="h-6 w-6 text-faint" />
        </div>
        <h2 className="text-lg font-semibold">No saved calls yet</h2>
        <p className="mt-1.5 max-w-xs text-sm text-muted">
          Start a live call and stop it — it&rsquo;ll be saved here automatically.
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight">Past Calls</h2>
        <span className="text-[13px] text-faint">
          {calls.length} call{calls.length === 1 ? '' : 's'}
        </span>
      </div>
      <ul className="space-y-2.5">
        {calls.map((call) => (
          <li key={call.id}>
            <div className="group flex items-center gap-4 rounded-xl border border-line-soft bg-surface px-4 py-3.5 transition hover:border-line hover:bg-elevated">
              <button
                type="button"
                onClick={() => setSelectedId(call.id)}
                className="min-w-0 flex-1 text-left"
              >
                <p className="truncate font-medium">{call.title}</p>
                <p className="mt-0.5 truncate text-[13px] text-muted">
                  {call.preview || 'No transcript'}
                </p>
                <div className="mt-1.5 flex items-center gap-3 text-[11px] text-faint">
                  <span>{formatDate(call.createdAt)}</span>
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" /> {formatDuration(call.durationMs)}
                  </span>
                  <span className="flex items-center gap-1">
                    <Users className="h-3 w-3" /> {call.speakerCount}
                  </span>
                  {call.hasSummary && (
                    <span className="flex items-center gap-1 text-accent">
                      <Sparkles className="h-3 w-3" /> Summary
                    </span>
                  )}
                  {call.attachmentCount > 0 && (
                    <span className="flex items-center gap-1">
                      <Paperclip className="h-3 w-3" /> {call.attachmentCount}
                    </span>
                  )}
                </div>
              </button>
              {confirmId === call.id ? (
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={async () => {
                      setConfirmId(null)
                      await remove(call.id)
                    }}
                    className="rounded-lg bg-rose-500/20 px-2.5 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-500/30"
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmId(null)}
                    className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted hover:text-ink"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmId(call.id)}
                  title="Delete"
                  className="shrink-0 rounded-lg p-2 text-faint opacity-0 transition hover:bg-canvas hover:text-rose-300 group-hover:opacity-100"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
