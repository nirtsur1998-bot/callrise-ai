import { useCallback, useEffect, useRef, useState } from 'react'
import { Sparkles, Loader2, XCircle } from 'lucide-react'
import { Button } from '@renderer/components/Button'
import type { Job } from '../../../../preload/index.d'

/**
 * BUG-232 — the offer to name the calls that never got a title.
 *
 * AN OFFER, NOT A BACKGROUND JOB. The founder's decision, in their words:
 * "128 untitled calls at roughly one cheap call each is a decision I want to
 * make deliberately, not a background job's." So the shape is fixed: the count
 * is shown first, ONE action starts it, and it can be stopped partway.
 *
 * WHY THERE IS ANYTHING TO BACK-FILL. The auto-title preference lived in
 * renderer localStorage, which is per-origin, so it silently read false for
 * five weeks while the user believed it was on (BUG-227). 137 of 191 calls
 * came out of that with the date-based placeholder. Fixing the preference does
 * not retitle them, and nothing else in the app would ever revisit them.
 *
 * AND IT SHOWS ITS FAILURES INDIVIDUALLY. "If 20 of 128 fail, I want to see
 * which and why rather than ending with 108 titles and no explanation." That
 * is not a nicety here — an aggregate count is exactly the reporting shape
 * that hid the original bug, so the clean-up must not repeat it. Each failure
 * carries the call and the provider's own words.
 */
const JOB_TYPE = 'calls:backfillTitles'

interface TitleBackfillSummary {
  attempted: number
  titled: number
  failures: Array<{
    callId: string
    callTitle: string
    reason: 'no-transcript' | 'no-title-returned' | 'ai-failed' | 'save-failed'
    detail?: string
  }>
  stoppedEarly: boolean
}

/** Plain English for each machine reason. The `detail` beside it is the
 *  provider's own sentence, which is usually the actionable half. */
const REASON_TEXT: Record<TitleBackfillSummary['failures'][number]['reason'], string> = {
  'no-transcript': 'no transcript to read',
  'no-title-returned': 'the AI returned no usable title',
  'ai-failed': 'the AI call failed',
  'save-failed': 'the title was written but the call would not save'
}

export function BackfillTitlesCard(): React.JSX.Element | null {
  const [eligibleCount, setEligibleCount] = useState<number | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showFailures, setShowFailures] = useState(false)
  const [stopping, setStopping] = useState(false)
  const mountedRef = useRef(true)
  const notifiedDoneRef = useRef<string | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const loadEstimate = useCallback(async () => {
    try {
      const res = await window.api.calls.titleBackfillEstimate()
      if (mountedRef.current) setEligibleCount(res.eligibleCount)
    } catch {
      if (mountedRef.current) setEligibleCount(null)
    }
  }, [])

  useEffect(() => {
    void loadEstimate()
    // Adopt a run already in flight, so leaving and returning to this screen
    // shows the same job rather than offering to start a second one.
    void window.api.jobs.list().then((jobs) => {
      const active = (jobs as Job[]).find(
        (j) => j.type === JOB_TYPE && (j.state === 'running' || j.state === 'queued')
      )
      if (active && mountedRef.current) setJob(active)
    })
    return window.api.jobs.onChanged((jobs) => {
      setJob((current) => {
        if (!current) return current
        return (jobs as Job[]).find((j) => j.id === current.id) ?? current
      })
    })
  }, [loadEstimate])

  useEffect(() => {
    if (!job) return
    if (job.state === 'succeeded' && notifiedDoneRef.current !== job.id) {
      notifiedDoneRef.current = job.id
      void loadEstimate() // the count shrinks by however many landed
    }
  }, [job, loadEstimate])

  const start = useCallback(async () => {
    setError(null)
    setShowFailures(false)
    setStopping(false)
    try {
      const res = await window.api.calls.backfillTitles()
      if (!mountedRef.current) return
      if (res.ok && res.jobId) {
        const fresh = await window.api.jobs.get(res.jobId)
        if (mountedRef.current && fresh) setJob(fresh as Job)
      } else {
        setError('Could not start naming your calls. Please try again.')
      }
    } catch {
      if (mountedRef.current) setError('Could not start naming your calls. Please try again.')
    }
  }, [])

  const stop = useCallback(async () => {
    if (!job) return
    // The other half of the founder's "Stop doesn't really stop it". The main
    // half was that the abort never reached the in-flight AI request; this is
    // the half a user actually SEES. Even now that cancel lands inside the
    // request, there is a real gap between the click and the job's state
    // changing, and leaving "Naming… 0 of 121" with a live Stop button on
    // screen through that gap is what makes a working button look broken.
    setStopping(true)
    try {
      await window.api.jobs.cancel(job.id)
    } catch {
      /* the job either stopped or it did not; the job state below is the truth */
    }
  }, [job])

  const running = job?.state === 'running' || job?.state === 'queued'
  const summary =
    job?.state === 'succeeded' ? (job.resultData as TitleBackfillSummary | undefined) : undefined

  // Nothing to offer and nothing to report — say nothing rather than occupy
  // the page with an empty state about a job that has no work.
  if (eligibleCount === 0 && !running && !summary) return null
  if (eligibleCount === null && !running && !summary) return null

  return (
    <div className="flex flex-col items-start gap-3">
      {!running && eligibleCount !== null && eligibleCount > 0 && (
        <p className="text-sm text-muted">
          <span className="font-medium text-ink tabular-nums">{eligibleCount}</span> saved call
          {eligibleCount === 1 ? '' : 's'} still {eligibleCount === 1 ? 'has' : 'have'} the default
          date title. Naming them takes one small AI call each, on your own key, one at a time — and
          you can stop partway.
        </p>
      )}

      {error && <p className="text-[13px] text-danger">{error}</p>}

      {!running && eligibleCount !== null && eligibleCount > 0 && (
        <Button icon={Sparkles} onClick={() => void start()}>
          Name {eligibleCount} call{eligibleCount === 1 ? '' : 's'}
        </Button>
      )}

      {running && (
        // Founder feedback, 2026-09-08: "the start/stop button seems too low."
        // It was stacked BELOW the progress line, which put a control on its
        // own row under a sentence and read as detached from the thing it
        // stops. Progress and its control belong on one line — Stop is the
        // partner of "Naming… 4 of 125", not a separate item on the page.
        // The reassurance drops to its own faint line, where a note belongs.
        <div className="flex flex-col items-start gap-1">
          <div className="flex items-center gap-3">
            <p className="flex items-center gap-2 text-[13px] text-accent">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {stopping
                ? 'Stopping — finishing the call in flight…'
                : job?.progress.mode === 'determinate'
                  ? `Naming… ${job.progress.itemsDone} of ${job.progress.itemsTotal}`
                  : 'Naming…'}
            </p>
            {/* Stopping is a first-class outcome, not an escape hatch:
                everything named so far stays named. */}
            <Button
              variant="secondary"
              size="sm"
              icon={XCircle}
              disabled={stopping}
              onClick={() => void stop()}
            >
              {stopping ? 'Stopping…' : 'Stop'}
            </Button>
          </div>
          <p className="text-[12px] text-faint">
            Safe to leave this screen — it keeps going, and Activity tracks it.
          </p>
        </div>
      )}

      {summary && (
        <div className="flex flex-col items-start gap-1.5">
          {/* "Named 0 of 0 before you stopped it" is what the general sentence
              produced when Stop landed inside the very first request — which is
              now the common case, because cancel reaches the AI call (BUG-235)
              and lands in under a second. Accurate, and it reads like a
              malfunction. */}
          <p className="text-[13px] text-positive">
            {summary.attempted === 0 && summary.stoppedEarly ? (
              'Stopped before any call was named.'
            ) : (
              <>
                Named <span className="tabular-nums">{summary.titled}</span> of{' '}
                <span className="tabular-nums">{summary.attempted}</span>
                {summary.stoppedEarly ? ' before you stopped it.' : '.'}
              </>
            )}
          </p>
          {summary.failures.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setShowFailures((v) => !v)}
                className="text-[13px] font-medium text-warning underline-offset-2 hover:underline"
              >
                {summary.failures.length} could not be named — {showFailures ? 'hide' : 'show'} why
              </button>
              {showFailures && (
                <ul className="mt-1 flex max-h-64 flex-col gap-1.5 overflow-y-auto text-[12px] text-muted">
                  {summary.failures.map((f) => (
                    <li key={f.callId} className="border-l-2 border-line-soft pl-2">
                      <span className="text-ink">{f.callTitle}</span> — {REASON_TEXT[f.reason]}
                      {f.detail && <span className="block text-faint">{f.detail}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
