// M26 Phase 4.2 — "we found an interrupted call, do you want it?"
//
// This is the visible half of journaled recovery. Main sweeps the journals at
// launch and reports any call that was never saved; this asks the rep what to
// do with each one, and does nothing until they answer.
//
// WHY IT ASKS INSTEAD OF DECIDING. Both silent options are unacceptable, and
// they fail in opposite directions: auto-saving manufactures call records for
// sessions that were abandoned on purpose (a mic test, a call that never
// connected), while auto-discarding throws away a real customer conversation
// with nobody ever knowing it existed. There is no signal on disk that
// reliably separates the two — only the rep knows. So the rep is asked.
//
// CLOSING IS A THIRD ANSWER, NOT A CANCEL. Dismissing keeps the journal, and
// the prompt returns next launch. That makes "not now" completely safe, which
// matters because this appears at startup — the single worst moment to force
// someone into an irreversible choice about something they have not thought
// about yet.
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Save, Trash2 } from 'lucide-react'
import { Modal } from '@renderer/components/Modal'
import { Button } from '@renderer/components/Button'
import type { RecoverableCall } from '../../../../preload/index.d'

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return min > 0 ? `${min} min ${sec}s` : `${sec}s`
}

function formatStarted(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'an earlier session'
  return d.toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    day: 'numeric',
    month: 'short'
  })
}

export function InterruptedCallPrompt(): React.JSX.Element | null {
  const [pending, setPending] = useState<RecoverableCall[]>([])
  const [busy, setBusy] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let cancelled = false
    // A failure here means no prompt, never a broken app — the journals stay
    // on disk untouched and the sweep runs again next launch.
    void window.api.live
      .listRecoverable()
      .then((found) => {
        if (!cancelled) setPending(found)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const current = pending[0]

  const advance = useCallback(() => {
    setPending((rest) => rest.slice(1))
    setBusy(false)
  }, [])

  const handleRecover = useCallback(async () => {
    if (!current || busy) return
    setBusy(true)
    try {
      await window.api.live.recoverCall(current.id)
    } catch {
      /* Leave the journal in place — better to ask again than to lose it. */
    }
    advance()
  }, [current, busy, advance])

  const handleDiscard = useCallback(async () => {
    if (!current || busy) return
    setBusy(true)
    try {
      await window.api.live.discardRecoverable(current.id)
    } catch {
      /* Same: a failed discard just means it gets offered again. */
    }
    advance()
  }, [current, busy, advance])

  if (!current || dismissed) return null

  return (
    <Modal onClose={() => setDismissed(true)} title="Interrupted call found" size="lg">
      <div className="p-5">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-warn-soft">
            <AlertTriangle className="h-4.5 w-4.5 text-warn" strokeWidth={2.25} />
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-ink">
              We found a call that was never saved
            </h3>
            <p className="mt-1 text-sm text-muted">
              CallRise was closed or interrupted during this call, so it never made it into your
              call list. The transcript was recovered from disk.
            </p>
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-line bg-elevated p-3.5">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted">
            <span className="font-medium text-ink">{formatStarted(current.startedAt)}</span>
            <span>{formatDuration(current.durationMs)}</span>
            <span>
              {current.segmentCount} {current.segmentCount === 1 ? 'turn' : 'turns'}
            </span>
          </div>
          {current.preview && (
            <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-ink/80">
              {current.preview}…
            </p>
          )}
          {/* Named rather than hidden: a transcript that stops mid-sentence
              needs a visible reason, or it reads as a bug in the recovery. */}
          {current.truncated && (
            <p className="mt-2 text-xs text-warn">
              The very end of this call may be missing — it was cut off mid-write.
            </p>
          )}
        </div>

        <div className="mt-5 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="text-xs font-medium text-muted transition-colors hover:text-ink"
          >
            Decide later
          </button>
          <div className="flex items-center gap-2">
            <Button
              variant="danger"
              size="sm"
              icon={Trash2}
              disabled={busy}
              onClick={() => void handleDiscard()}
            >
              Discard
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={Save}
              disabled={busy}
              onClick={() => void handleRecover()}
            >
              Save this call
            </Button>
          </div>
        </div>

        {pending.length > 1 && (
          <p className="mt-3 text-center text-xs text-muted">
            {pending.length - 1} more interrupted {pending.length - 1 === 1 ? 'call' : 'calls'} after
            this one
          </p>
        )}
      </div>
    </Modal>
  )
}
