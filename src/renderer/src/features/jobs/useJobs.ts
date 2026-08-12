import { useEffect, useState } from 'react'
import type { Job } from '../../../../preload/index.d'

/** Live snapshot of the whole job queue — subscribes once, no polling. */
export function useJobs(): Job[] {
  const [jobs, setJobs] = useState<Job[]>([])
  useEffect(() => {
    void window.api.jobs.list().then((initial) => setJobs(initial as Job[]))
    return window.api.jobs.onChanged((next) => setJobs(next as Job[]))
  }, [])
  return jobs
}
