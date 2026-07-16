import { useEffect, useState } from 'react'
import { Check, X, Pencil, Eye, AlertTriangle, Inbox } from 'lucide-react'
import { useObjectionQueue } from './useObjectionQueue'
import { ViewCallModal } from './ViewCallModal'
import { SkeletonRows } from '@renderer/components/Skeleton'
import { Badge } from '@renderer/components/Badge'
import { Button } from '@renderer/components/Button'
import { EmptyState } from '@renderer/components/EmptyState'
import { fieldClass } from '@renderer/components/field'
import { cn } from '@renderer/lib/cn'
import { TYPE_LABEL, type ObjectionQueueItem } from './types'

/**
 * Step 3 of the Objection Library milestone: the human-in-the-loop gate.
 * Every mined candidate lands here first — Approve, Edit then approve, or
 * Reject. Only Approve ever creates a real objection script (in the
 * Knowledge Base); nothing else in this feature writes there.
 */
export function ReviewQueueView({
  refreshToken = 0
}: {
  /** Bump to reload the queue (e.g. after a scan on the same screen adds items). */
  refreshToken?: number
}): React.JSX.Element {
  const { items, loading, refresh, approve, reject } = useObjectionQueue()
  const [viewingCall, setViewingCall] = useState<{ id: string; title: string } | null>(null)

  useEffect(() => {
    if (refreshToken > 0) void refresh()
  }, [refreshToken, refresh])

  if (loading) {
    return <SkeletonRows rows={3} />
  }

  if (items.length === 0) {
    return (
      <EmptyState
        compact
        icon={Inbox}
        title="Nothing to review yet"
        description="Suggestions you send from a call's “Mine this call (test)” panel, or from scanning past calls, will show up here."
      />
    )
  }

  return (
    <div className="space-y-3">
      {items.map((item) => (
        <QueueRow
          key={item.id}
          item={item}
          onApprove={approve}
          onReject={reject}
          onViewCall={() => setViewingCall({ id: item.callId, title: item.callTitle })}
        />
      ))}
      {viewingCall && (
        <ViewCallModal
          callId={viewingCall.id}
          callTitle={viewingCall.title}
          onClose={() => setViewingCall(null)}
        />
      )}
    </div>
  )
}

interface QueueRowProps {
  item: ObjectionQueueItem
  onApprove: (id: string, edits?: { trigger?: string; response?: string }) => Promise<boolean>
  onReject: (id: string) => Promise<void>
  onViewCall: () => void
}

function QueueRow({ item, onApprove, onReject, onViewCall }: QueueRowProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [trigger, setTrigger] = useState(item.objectionQuote)
  const [response, setResponse] = useState(item.responseQuote)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const approveAsIs = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const ok = await onApprove(item.id)
    if (!ok) setError('Could not save this script. Please try again.')
    setBusy(false)
  }

  const saveAndApprove = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const ok = await onApprove(item.id, { trigger, response })
    if (!ok) setError('Could not save this script. Please try again.')
    setBusy(false)
  }

  const rejectRow = async (): Promise<void> => {
    setBusy(true)
    await onReject(item.id)
  }

  return (
    <div className="rounded-xl border border-line-soft bg-surface p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <Badge tone="neutral">{TYPE_LABEL[item.type]}</Badge>
        <button
          type="button"
          onClick={onViewCall}
          title={item.callTitle}
          className="press flex min-w-0 items-center gap-1 text-[12px] text-muted transition hover:text-ink"
        >
          <Eye className="h-3.5 w-3.5 shrink-0" />{' '}
          <span className="min-w-0 truncate">{item.callTitle}</span>
        </button>
      </div>

      {editing ? (
        <div className="space-y-2">
          <div>
            <label className="mb-1 block text-[11px] font-medium text-faint">
              Buyer&apos;s objection
            </label>
            <textarea
              value={trigger}
              onChange={(e) => setTrigger(e.target.value)}
              rows={2}
              className={cn(fieldClass, 'resize-y')}
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-faint">Your response</label>
            <textarea
              value={response}
              onChange={(e) => setResponse(e.target.value)}
              rows={3}
              className={cn(fieldClass, 'resize-y')}
            />
          </div>
        </div>
      ) : (
        <>
          <p className="text-sm">
            <span className="text-faint">Buyer said: </span>
            &ldquo;{item.objectionQuote}&rdquo;
          </p>
          <p className="mt-1 text-sm">
            <span className="text-faint">You responded: </span>
            &ldquo;{item.responseQuote}&rdquo;
          </p>
        </>
      )}

      <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
        {item.recoveredWell ? (
          <Badge tone="positive" icon={Check}>
            Recovered well
          </Badge>
        ) : (
          <Badge tone="warning" icon={AlertTriangle}>
            Not sure it recovered
          </Badge>
        )}
        <span>— a suggestion, not a fact. {item.judgmentNote}</span>
      </p>

      {error && <p className="mt-2 text-[13px] text-danger">{error}</p>}

      <div className="mt-3 flex items-center gap-2">
        {editing ? (
          <>
            <Button
              size="sm"
              icon={Check}
              disabled={busy || !trigger.trim() || !response.trim()}
              onClick={saveAndApprove}
            >
              Save &amp; approve
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" icon={Check} disabled={busy} onClick={approveAsIs}>
              Approve
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={Pencil}
              disabled={busy}
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
            <Button variant="secondary" size="sm" icon={X} disabled={busy} onClick={rejectRow}>
              Reject
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
