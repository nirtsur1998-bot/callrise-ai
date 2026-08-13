import { useCallback, useEffect, useRef, useState } from 'react'
import { ScanSearch } from 'lucide-react'
import { Button } from '@renderer/components/Button'
import type { Job } from '../../../../preload/index.d'

// Rough, honest per-call estimate. Not a guarantee, just enough for the user
// to judge before confirming a batch run.
const SECONDS_PER_CALL = 10
const LOW_COST_PER_CALL_USD = 0.01
const HIGH_COST_PER_CALL_USD = 0.05

const JOB_TYPE = 'objections:scanPastCalls'

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

/**
 * Step 4's manual, explicit batch trigger. NEVER runs on its own — the user
 * must see the estimate and click Start. Only calls with a transcript that
 * haven't been mined yet are included (new calls mined automatically, when
 * the toggle is on, are skipped here since they're already done).
 *
 * M26 Phase 3 — this used to block on one long ipcRenderer.invoke() for the
 * whole scan, with the button just disabled and nothing else visible if the
 * rep navigated away and back. Now it enqueues a real job and TRACKS it via
 * window.api.jobs, so reopening this screen mid-scan shows real progress
 * again instead of a blank "Scan N past calls" button as if nothing were
 * happening (the scan itself was always safe in the main process either
 * way — only the visible feedback was the part that used to disappear).
 */
export function ScanPastCallsCard({
  enabled,
  onQueueChanged
}: {
  enabled: boolean
  /** Called after a scan finishes, so the review queue below can refresh. */
  onQueueChanged?: () => void
}): React.JSX.Element {
  const [eligibleCount, setEligibleCount] = useState<number | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const notifiedDoneRef = useRef<string | null>(null)

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

  // Adopt an already-running/queued scan on mount (the rep started it, left
  // this screen, and came back), and keep tracking whichever scan job is
  // current from then on — this IS the fix for "navigating away loses the
  // work"; the job itself never needed rescuing, only this screen's view of it.
  useEffect(() => {
    void window.api.jobs.list().then((jobs) => {
      if (!mountedRef.current) return
      const active = (jobs as Job[]).find(
        (j) => j.type === JOB_TYPE && (j.state === 'running' || j.state === 'queued')
      )
      if (active) setJob(active)
    })
    return window.api.jobs.onChanged((jobs) => {
      setJob((current) => {
        if (!current) return current
        return (jobs as Job[]).find((j) => j.id === current.id) ?? current
      })
    })
  }, [])

  useEffect(() => {
    if (!job) return
    if (job.state === 'succeeded' && notifiedDoneRef.current !== job.id) {
      notifiedDoneRef.current = job.id
      onQueueChanged?.()
      void loadEstimate()
    }
  }, [job, onQueueChanged, loadEstimate])

  const startScan = useCallback(async () => {
    setError(null)
    try {
      const res = await window.api.calls.scanPastCallsForObjections()
      if (!mountedRef.current) return
      if (res.ok && res.jobId) {
        const fresh = await window.api.jobs.get(res.jobId)
        if (mountedRef.current && fresh) setJob(fresh as Job)
      } else {
        setError('Could not start the scan. Please try again.')
      }
    } catch {
      if (mountedRef.current) setError('Could not start the scan. Please try again.')
    }
  }, [])

  if (!enabled) {
    return (
      <p className="text-[13px] text-faint">
        Turn on the toggle above to scan your past calls for objections.
      </p>
    )
  }

  const scanning = job?.state === 'running' || job?.state === 'queued'

  if (eligibleCount === null && !job) {
    return <p className="text-sm text-faint">Checking your past calls…</p>
  }

  if (eligibleCount === 0 && !scanning) {
    return (
      <p className="text-[13px] text-muted">
        Every past call with a transcript has already been mined. New calls are mined automatically
        going forward.
      </p>
    )
  }

  return (
    <div className="flex flex-col items-start gap-3">
      {eligibleCount !== null && eligibleCount > 0 && (
        <p className="text-sm text-muted">
          <span className="font-medium text-ink tabular-nums">{eligibleCount}</span> past call
          {eligibleCount === 1 ? '' : 's'} with a transcript {eligibleCount === 1 ? 'has' : 'have'}{' '}
          not been mined yet. Scanning one call at a time — expect{' '}
          <span className="tabular-nums">{formatMinutes(eligibleCount * SECONDS_PER_CALL)}</span>{' '}
          and <span className="tabular-nums">{formatCost(eligibleCount)}</span> in AI cost (a rough
          estimate, not a guarantee).
        </p>
      )}

      {error && <p className="text-[13px] text-danger">{error}</p>}

      {scanning && job?.progress.mode === 'determinate' && (
        <p className="text-[13px] text-accent">
          Scanning… {job.progress.itemsDone} / {job.progress.itemsTotal}
          {' — safe to leave this screen, tracked in Activity too.'}
        </p>
      )}

      {job?.state === 'succeeded' && job.resultRef && (
        <p
          className={
            job.resultRef.includes('stopped') || job.resultRef.includes('failed')
              ? 'text-[13px] text-warning'
              : 'text-[13px] text-positive'
          }
        >
          {job.resultRef} — check the review queue below.
        </p>
      )}

      {job?.state === 'failed' && (
        <p className="text-[13px] text-danger">
          {job.error?.message ?? 'The scan failed.'} Try again below.
        </p>
      )}

      {/* Keep the button unless a scan is genuinely in flight right now. */}
      {!scanning && eligibleCount !== null && eligibleCount > 0 && (
        <Button icon={ScanSearch} onClick={() => void startScan()}>
          {`Scan ${eligibleCount} past call${eligibleCount === 1 ? '' : 's'}`}
        </Button>
      )}
    </div>
  )
}
