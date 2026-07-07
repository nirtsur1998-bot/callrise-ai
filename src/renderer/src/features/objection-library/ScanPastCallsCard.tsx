import { useCallback, useEffect, useRef, useState } from 'react'
import { ScanSearch } from 'lucide-react'

// Rough, honest per-call estimate — same AI model as coaching. Not a
// guarantee, just enough for the user to judge before confirming a batch run.
const SECONDS_PER_CALL = 10
const LOW_COST_PER_CALL_USD = 0.01
const HIGH_COST_PER_CALL_USD = 0.05

function formatMinutes(totalSeconds: number): string {
  if (totalSeconds < 60) return `under a minute`
  const minutes = Math.round(totalSeconds / 60)
  return `about ${minutes} minute${minutes === 1 ? '' : 's'}`
}

function formatCost(count: number): string {
  const low = (count * LOW_COST_PER_CALL_USD).toFixed(2)
  const high = (count * HIGH_COST_PER_CALL_USD).toFixed(2)
  return `roughly $${low}–$${high}`
}

type ScanResult = {
  scanned: number
  candidatesAdded: number
  failed: number
  stopped?: 'disabled' | 'errors'
}

/**
 * Step 4's manual, explicit batch trigger. NEVER runs on its own — the user
 * must see the estimate and click Start. Only calls with a transcript that
 * haven't been mined yet are included (new calls mined automatically, when
 * the toggle is on, are skipped here since they're already done).
 */
export function ScanPastCallsCard({
  enabled,
  onQueueChanged
}: {
  enabled: boolean
  /** Called after a scan added suggestions, so the review queue below can refresh. */
  onQueueChanged?: () => void
}): React.JSX.Element {
  const [eligibleCount, setEligibleCount] = useState<number | null>(null)
  const [scanning, setScanning] = useState(false)
  const [result, setResult] = useState<ScanResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const loadEstimate = useCallback(async () => {
    if (!enabled) return
    try {
      const res = await window.api.calls.objectionScanEstimate()
      if (mountedRef.current) setEligibleCount(res.eligibleCount)
    } catch {
      /* leave as null — the button below stays disabled */
    }
  }, [enabled])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadEstimate()
  }, [loadEstimate])

  const startScan = useCallback(async () => {
    setScanning(true)
    setError(null)
    setResult(null)
    try {
      const res = await window.api.calls.scanPastCallsForObjections()
      if (!mountedRef.current) return
      if (res.ok) {
        setResult({
          scanned: res.scanned,
          candidatesAdded: res.candidatesAdded,
          failed: res.failed,
          stopped: res.stopped
        })
        if (res.candidatesAdded > 0) onQueueChanged?.()
        await loadEstimate()
      } else {
        setError('Could not run the scan. Please try again.')
      }
    } catch {
      if (mountedRef.current) setError('Could not run the scan. Please try again.')
    } finally {
      if (mountedRef.current) setScanning(false)
    }
  }, [loadEstimate, onQueueChanged])

  if (!enabled) {
    return (
      <p className="text-[13px] text-faint">
        Turn on the toggle above to scan your past calls for objections.
      </p>
    )
  }

  if (eligibleCount === null) {
    return <p className="text-sm text-faint">Checking your past calls…</p>
  }

  if (eligibleCount === 0) {
    return (
      <p className="text-[13px] text-muted">
        Every past call with a transcript has already been mined. New calls are mined automatically
        going forward.
      </p>
    )
  }

  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-sm text-muted">
        <span className="font-medium text-ink">{eligibleCount}</span> past call
        {eligibleCount === 1 ? '' : 's'} with a transcript {eligibleCount === 1 ? 'has' : 'have'}{' '}
        not been mined yet. Scanning calls Claude once per call — expect{' '}
        {formatMinutes(eligibleCount * SECONDS_PER_CALL)} and {formatCost(eligibleCount)} in AI cost
        (a rough estimate, not a guarantee).
      </p>

      {error && <p className="text-[13px] text-rose-300">{error}</p>}

      {result && (
        <p
          className={
            result.stopped || result.failed > 0
              ? 'text-[13px] text-amber-300'
              : 'text-[13px] text-emerald-400'
          }
        >
          Scanned {result.scanned} call{result.scanned === 1 ? '' : 's'} and found{' '}
          {result.candidatesAdded} suggestion{result.candidatesAdded === 1 ? '' : 's'}
          {result.candidatesAdded > 0 ? ' — check the review queue below.' : '.'}
          {result.stopped === 'errors' &&
            ` Stopped after repeated errors (${result.failed} call${result.failed === 1 ? '' : 's'} not scanned yet) — the AI service may be busy. Try again in a few minutes.`}
          {result.stopped === 'disabled' && ' Stopped because the toggle was turned off.'}
          {!result.stopped &&
            result.failed > 0 &&
            ` ${result.failed} call${result.failed === 1 ? '' : 's'} could not be scanned — try again to retry ${result.failed === 1 ? 'it' : 'them'}.`}
        </p>
      )}

      {/* Keep the button when the scan didn't finish cleanly, so the user can retry. */}
      {(!result || result.stopped || result.failed > 0) && (
        <button
          type="button"
          disabled={scanning}
          onClick={startScan}
          className="flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:cursor-default disabled:opacity-50"
        >
          <ScanSearch className="h-4 w-4" />
          {scanning
            ? 'Scanning…'
            : `Scan ${eligibleCount} past call${eligibleCount === 1 ? '' : 's'}`}
        </button>
      )}
    </div>
  )
}
