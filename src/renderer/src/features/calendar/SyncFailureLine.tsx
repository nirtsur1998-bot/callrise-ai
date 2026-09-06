import { useState } from 'react'
import { AlertTriangle, RefreshCw, Check } from 'lucide-react'
import { Button } from '@renderer/components/Button'
import type { SyncFailure } from './syncFailure'

/**
 * BUG-169 — the line on the event that says it is not on the calendar, and
 * the one manual Retry. Inline in the dialog, never a modal; the rest of the
 * dialog stays usable. After a retry it says what happened — pushed, or the
 * new reason — rather than going quiet.
 */
export function SyncFailureLine({
  failure,
  onRetry
}: {
  failure: SyncFailure
  onRetry: () => Promise<{ ok: boolean; reason?: string }>
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<{ ok: boolean; reason?: string } | null>(null)

  const retry = async (): Promise<void> => {
    setBusy(true)
    try {
      setOutcome(await onRetry())
    } catch {
      setOutcome({ ok: false, reason: 'The retry could not be started.' })
    } finally {
      setBusy(false)
    }
  }

  if (outcome?.ok) {
    return (
      <p
        className="flex items-center gap-1.5 rounded-lg bg-positive-soft px-3 py-2 text-[12px] text-positive"
        data-testid="sync-failure-line"
      >
        <Check className="h-3.5 w-3.5 shrink-0" />
        Now on your calendar.
      </p>
    )
  }

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-warning-soft px-3 py-2"
      data-testid="sync-failure-line"
    >
      <p className="flex min-w-0 items-start gap-1.5 text-[12px] text-warning">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{outcome && !outcome.ok && outcome.reason ? outcome.reason : failure.reason}</span>
      </p>
      <Button variant="secondary" size="sm" icon={RefreshCw} onClick={() => void retry()} disabled={busy}>
        {busy ? 'Retrying…' : 'Retry'}
      </Button>
    </div>
  )
}
