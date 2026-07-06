import { useState } from 'react'
import { Check, X, Pencil, Eye } from 'lucide-react'
import { useObjectionQueue } from './useObjectionQueue'
import { ViewCallModal } from './ViewCallModal'
import { TYPE_LABEL, type ObjectionQueueItem } from './types'

/**
 * Step 3 of the Objection Library milestone: the human-in-the-loop gate.
 * Every mined candidate lands here first — Approve, Edit then approve, or
 * Reject. Only Approve ever creates a real objection script (in the
 * Knowledge Base); nothing else in this feature writes there.
 */
export function ReviewQueueView(): React.JSX.Element {
  const { items, loading, approve, reject } = useObjectionQueue()
  const [viewingCall, setViewingCall] = useState<{ id: string; title: string } | null>(null)

  if (loading) {
    return <p className="text-sm text-faint">Loading…</p>
  }

  if (items.length === 0) {
    return (
      <p className="text-[13px] text-faint">
        Nothing to review yet. Suggestions you send from a call&apos;s &quot;Mine this call
        (test)&quot; panel will show up here.
      </p>
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
        <p className="text-[11px] font-semibold tracking-wide text-faint uppercase">
          {TYPE_LABEL[item.type]}
        </p>
        <button
          type="button"
          onClick={onViewCall}
          className="flex items-center gap-1 text-[12px] text-muted transition hover:text-ink"
        >
          <Eye className="h-3.5 w-3.5" /> {item.callTitle}
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
              className="w-full rounded-lg border border-line bg-elevated px-3 py-2 text-sm text-ink outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-faint">Your response</label>
            <textarea
              value={response}
              onChange={(e) => setResponse(e.target.value)}
              rows={3}
              className="w-full rounded-lg border border-line bg-elevated px-3 py-2 text-sm text-ink outline-none focus:border-accent"
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

      <p className="mt-2 text-[12px] text-muted">
        <span
          className={
            item.recoveredWell ? 'font-medium text-emerald-400' : 'font-medium text-amber-400'
          }
        >
          {item.recoveredWell ? 'AI thinks this recovered well' : 'AI is not sure this fully recovered'}
        </span>{' '}
        — a suggestion, not a fact. {item.judgmentNote}
      </p>

      {error && <p className="mt-2 text-[13px] text-rose-300">{error}</p>}

      <div className="mt-3 flex items-center gap-2">
        {editing ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={saveAndApprove}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition hover:brightness-110 disabled:opacity-50"
            >
              <Check className="h-3.5 w-3.5" /> Save &amp; approve
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setEditing(false)}
              className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-muted transition hover:bg-elevated hover:text-ink"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={approveAsIs}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition hover:brightness-110 disabled:opacity-50"
            >
              <Check className="h-3.5 w-3.5" /> Approve
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setEditing(true)}
              className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-muted transition hover:bg-elevated hover:text-ink"
            >
              <Pencil className="h-3.5 w-3.5" /> Edit
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={rejectRow}
              className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-muted transition hover:bg-elevated hover:text-rose-300"
            >
              <X className="h-3.5 w-3.5" /> Reject
            </button>
          </>
        )}
      </div>
    </div>
  )
}
