import { useCallback, useEffect, useRef, useState } from 'react'
import type { Job, JobState } from '../../../../preload/index.d'

const DEFAULT_ADOPT_STATES: JobState[] = ['running', 'queued']

/**
 * Tracks the single most relevant job of `jobType` scoped to `targetRef`
 * (e.g. a call id) — adopts an already-there job matching `adoptStates` on
 * mount (the rep clicked the button, navigated away, and came back), stays
 * live via window.api.jobs.onChanged, and calls onSucceeded/onFailed
 * exactly once per job that reaches a terminal state (whether it was
 * already terminal at adoption time, or finished while being watched
 * live). Re-adopts from scratch whenever `targetRef` changes, so a job
 * tracked for a previous call/contact/deal never leaks onto the next one
 * shown in the same screen.
 *
 * `adoptStates` defaults to running/queued — the common "track an
 * in-flight operation" case. Pass `['running', 'queued', 'succeeded']` for
 * a job type whose successful result is a not-yet-consumed payload the
 * screen should show without re-running the job (see Job.resultData's own
 * doc, and GenerateTasksDialog — closing it before Save must not lose
 * already-paid-for AI output, so reopening needs to find the same
 * finished job instead of starting a new one).
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
  opts: {
    onSucceeded?: (job: Job) => void
    onFailed?: (job: Job) => void
    adoptStates?: JobState[]
  } = {}
): [Job | null, (job: Job) => void] {
  const [job, setJob] = useState<Job | null>(null)
  const notifiedRef = useRef<string | null>(null)
  const optsRef = useRef(opts)
  // Updated post-render (not during it) so the async work below always
  // calls the latest onSucceeded/onFailed/adoptStates without needing to
  // re-subscribe every render.
  useEffect(() => {
    optsRef.current = opts
  })

  // Adopts a job into tracked state, firing onSucceeded/onFailed exactly
  // once if it's ALREADY terminal — covers both "found one already done on
  // mount" and "start() was handed one that finished before this ran" the
  // same way a job finishing while being watched live does.
  const adopt = useCallback((candidate: Job): void => {
    setJob(candidate)
    if (notifiedRef.current === candidate.id) return
    if (candidate.state === 'succeeded') {
      notifiedRef.current = candidate.id
      optsRef.current.onSucceeded?.(candidate)
    } else if (candidate.state === 'failed') {
      notifiedRef.current = candidate.id
      optsRef.current.onFailed?.(candidate)
    }
  }, [])

  useEffect(() => {
    let mounted = true
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset tracked job when jobType/targetRef changes, then adopt
    setJob(null)
    notifiedRef.current = null
    const adoptStates = optsRef.current.adoptStates ?? DEFAULT_ADOPT_STATES
    void window.api.jobs.list().then((jobs) => {
      if (!mounted) return
      // BUG-114 — scan BACKWARDS. jobs.list() preserves main's push order, so
      // a plain .find() adopts the OLDEST match: after a Regenerate that is the
      // draft the rep just rejected, and saving it duplicates work they already
      // saved. Mirrors JobManager.findLatest on the main side — see its doc
      // comment for why the ordering is easy to read past.
      let active: (typeof jobs)[number] | undefined
      for (let i = jobs.length - 1; i >= 0; i--) {
        const j = jobs[i]
        if (j.type === jobType && j.targetRef === targetRef && adoptStates.includes(j.state)) {
          active = j
          break
        }
      }
      if (active) adopt(active)
    })
    return () => {
      mounted = false
    }
  }, [jobType, targetRef, adopt])

  useEffect(() => {
    return window.api.jobs.onChanged((jobs) => {
      setJob((current) => {
        if (!current) return current
        const next = jobs.find((j) => j.id === current.id)
        if (!next) return current
        if (notifiedRef.current !== next.id) {
          if (next.state === 'succeeded') {
            notifiedRef.current = next.id
            optsRef.current.onSucceeded?.(next)
          } else if (next.state === 'failed') {
            notifiedRef.current = next.id
            optsRef.current.onFailed?.(next)
          }
        }
        return next
      })
    })
  }, [])

  const start = useCallback(
    (startedJob: Job): void => {
      notifiedRef.current = null
      adopt(startedJob)
    },
    [adopt]
  )

  return [job, start]
}
