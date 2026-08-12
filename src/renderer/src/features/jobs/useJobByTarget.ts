import { useCallback, useEffect, useRef, useState } from 'react'
import type { Job } from '../../../../preload/index.d'

/**
 * Tracks the single most relevant job of `jobType` scoped to `targetRef`
 * (e.g. a call id) — adopts an already-running/queued one on mount (the rep
 * clicked the button, navigated away, and came back), stays live via
 * window.api.jobs.onChanged, and calls onSucceeded/onFailed exactly once
 * per job that reaches a terminal state. Re-adopts from scratch whenever
 * `targetRef` changes, so a job tracked for a previous call/contact/deal
 * never leaks onto the next one shown in the same screen.
 *
 * This is the shared shape behind every "click a button, track one job
 * against a specific record" adapter — the objection-scan and Sales Brain
 * backfill adapters hand-rolled the same adopt/subscribe/notify-once
 * effects before this got pulled out for CallDetail's summarize/coach/
 * find-commitments buttons (M26 Phase 3).
 */
export function useJobByTarget(
  jobType: string,
  targetRef: string,
  handlers: { onSucceeded?: (job: Job) => void; onFailed?: (job: Job) => void } = {}
): [Job | null, (job: Job) => void] {
  const [job, setJob] = useState<Job | null>(null)
  const notifiedRef = useRef<string | null>(null)
  const handlersRef = useRef(handlers)
  // Updated post-render (not during it) so the async onChanged subscription
  // below always calls the latest onSucceeded/onFailed without needing to
  // re-subscribe every render.
  useEffect(() => {
    handlersRef.current = handlers
  })

  useEffect(() => {
    let mounted = true
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset tracked job when jobType/targetRef changes, then adopt
    setJob(null)
    notifiedRef.current = null
    void window.api.jobs.list().then((jobs) => {
      if (!mounted) return
      const active = jobs.find(
        (j) =>
          j.type === jobType &&
          j.targetRef === targetRef &&
          (j.state === 'running' || j.state === 'queued')
      )
      if (active) setJob(active)
    })
    return () => {
      mounted = false
    }
  }, [jobType, targetRef])

  useEffect(() => {
    return window.api.jobs.onChanged((jobs) => {
      setJob((current) => {
        if (!current) return current
        const next = jobs.find((j) => j.id === current.id)
        if (!next) return current
        if (notifiedRef.current !== next.id) {
          if (next.state === 'succeeded') {
            notifiedRef.current = next.id
            handlersRef.current.onSucceeded?.(next)
          } else if (next.state === 'failed') {
            notifiedRef.current = next.id
            handlersRef.current.onFailed?.(next)
          }
        }
        return next
      })
    })
  }, [])

  const start = useCallback((startedJob: Job): void => {
    notifiedRef.current = null
    setJob(startedJob)
  }, [])

  return [job, start]
}
