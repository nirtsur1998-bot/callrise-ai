import { useCallback, useEffect, useRef, useState } from 'react'
import type { Job, JobState } from '../../../../preload/index.d'

const DEFAULT_ADOPT_STATES: JobState[] = ['running', 'queued']

/**
 * Tracks the current job of `jobType` when there is only ever ONE of it at a
 * time app-wide, with no per-record target — cloud sync being the case this
 * was built for (you don't sync a particular call, you sync everything).
 *
 * The sibling of useJobByTarget: same adopt-on-mount / stay-live /
 * notify-once contract, minus the targetRef scoping. Kept separate rather
 * than making targetRef optional there, because "match any job of this
 * type" and "match this record's job" are genuinely different questions —
 * conflating them would make it easy to write a per-record screen that
 * silently latches onto some other record's job.
 */
export function useSingletonJob(
  jobType: string,
  opts: {
    onSucceeded?: (job: Job) => void
    onFailed?: (job: Job) => void
    adoptStates?: JobState[]
  } = {}
): [Job | null, (job: Job) => void] {
  const [job, setJob] = useState<Job | null>(null)
  const notifiedRef = useRef<string | null>(null)
  const optsRef = useRef(opts)
  useEffect(() => {
    optsRef.current = opts
  })

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
    const adoptStates = optsRef.current.adoptStates ?? DEFAULT_ADOPT_STATES
    void window.api.jobs.list().then((jobs) => {
      if (!mounted) return
      // Newest first — if several of this type are somehow present, the
      // most recent is the one the screen means.
      const active = [...jobs]
        .reverse()
        .find((j) => j.type === jobType && adoptStates.includes(j.state))
      if (active) adopt(active)
    })
    return () => {
      mounted = false
    }
  }, [jobType, adopt])

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
