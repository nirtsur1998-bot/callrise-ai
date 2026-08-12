import { useEffect, useState } from 'react'
import { ListTodo, Play, Ban, RotateCcw, PlayCircle, X } from 'lucide-react'
import { Card } from '@renderer/components/Card'
import { Button } from '@renderer/components/Button'
import { Badge, type BadgeTone } from '@renderer/components/Badge'
import { EmptyState } from '@renderer/components/EmptyState'
import type { Job, JobState } from '../../../../preload/index.d'

const STATE_TONE: Record<JobState, BadgeTone> = {
  queued: 'neutral',
  running: 'accent',
  succeeded: 'positive',
  failed: 'danger',
  cancelled: 'neutral',
  interrupted: 'warning'
}

function formatProgress(progress: Job['progress']): string {
  if (progress.mode === 'determinate') return `${progress.itemsDone} / ${progress.itemsTotal}`
  if (progress.mode === 'stages') return progress.stageLabel
  return 'working…'
}

function formatWhen(ms: number | undefined): string {
  if (!ms) return '—'
  const deltaSec = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (deltaSec < 5) return 'just now'
  if (deltaSec < 60) return `${deltaSec}s ago`
  const min = Math.round(deltaSec / 60)
  return `${min}m ago`
}

/** M26 Phase 1 — dev builds only (see settings-nav.ts's import.meta.env.DEV
 *  guard, mirrored on main's side in main/index.ts's is.dev check on the
 *  fake-job IPC handler itself, so this page fails safely even if it were
 *  somehow reached). Exercises the whole job queue — lanes, concurrency,
 *  cancellation, checkpoint/resume — with fake jobs, without touching any
 *  real feature (nothing is migrated to the queue yet; that's Phase 3). */
export function JobInspectorSection(): React.JSX.Element {
  const [jobs, setJobs] = useState<Job[]>([])
  const [starting, setStarting] = useState<string | null>(null)

  useEffect(() => {
    void window.api.jobs.list().then(setJobs)
    return window.api.jobs.onChanged((next) => setJobs(next as Job[]))
  }, [])

  const startFake = async (
    req: Parameters<typeof window.api.jobs.dev.startFake>[0],
    key: string
  ): Promise<void> => {
    setStarting(key)
    try {
      await window.api.jobs.dev.startFake(req)
    } finally {
      setStarting(null)
    }
  }

  const act = (fn: () => Promise<unknown>): void => {
    void fn()
  }

  const sorted = [...jobs].sort((a, b) => b.createdAt - a.createdAt)

  return (
    <>
      <Card className="mb-5">
        <h3 className="mb-1 text-sm font-semibold">Start a fake job</h3>
        <p className="mb-4 text-[12px] text-faint">
          Controllable duration, progress pattern, and failure mode — for exercising the queue
          itself, not any real feature. INTERACTIVE allows 2 at once; BATCH and MAINTENANCE allow 1
          — start a few of the same kind at once to see the rest queue and then pick up
          automatically.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon={Play}
            disabled={starting === 'batch'}
            onClick={() =>
              act(() =>
                startFake(
                  {
                    kind: 'batch',
                    input: { title: 'Fake batch scan', itemsTotal: 8, msPerItem: 400 }
                  },
                  'batch'
                )
              )
            }
          >
            BATCH — 8 items
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={Play}
            disabled={starting === 'batch-priority'}
            onClick={() =>
              act(() =>
                startFake(
                  {
                    kind: 'batch',
                    input: { title: 'Fake batch (high priority)', itemsTotal: 6, msPerItem: 400 }
                  },
                  'batch-priority'
                )
              )
            }
          >
            BATCH — high priority
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={Play}
            disabled={starting === 'batch-fail'}
            onClick={() =>
              act(() =>
                startFake(
                  {
                    kind: 'batch',
                    input: {
                      title: 'Fake batch (fails at item 4)',
                      itemsTotal: 8,
                      msPerItem: 300,
                      failAtItem: 4
                    }
                  },
                  'batch-fail'
                )
              )
            }
          >
            BATCH — fails partway
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={Play}
            disabled={starting === 'staged'}
            onClick={() =>
              act(() =>
                startFake(
                  {
                    kind: 'staged',
                    input: {
                      title: 'Fake AI operation',
                      stages: ['Reading transcript', 'Analyzing', 'Writing', 'Saving'],
                      msPerStage: 700
                    }
                  },
                  'staged'
                )
              )
            }
          >
            INTERACTIVE — staged
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={Play}
            disabled={starting === 'staged-fail'}
            onClick={() =>
              act(() =>
                startFake(
                  {
                    kind: 'staged',
                    input: {
                      title: 'Fake AI operation (fails)',
                      stages: ['Reading transcript', 'Analyzing', 'Writing', 'Saving'],
                      msPerStage: 500,
                      failAtStage: 1
                    }
                  },
                  'staged-fail'
                )
              )
            }
          >
            INTERACTIVE — fails partway
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={Play}
            disabled={starting === 'cpu'}
            onClick={() =>
              act(() =>
                startFake(
                  {
                    kind: 'cpu',
                    input: {
                      title: 'Fake CPU-heavy job (worker thread)',
                      itemsTotal: 6,
                      msBudget: 3000
                    }
                  },
                  'cpu'
                )
              )
            }
          >
            MAINTENANCE — CPU-heavy (worker)
          </Button>
        </div>
      </Card>

      <Card>
        <h3 className="mb-4 text-sm font-semibold">Queue ({jobs.length})</h3>
        {sorted.length === 0 ? (
          <EmptyState
            icon={ListTodo}
            title="No jobs yet"
            description="Start one of the fake jobs above to see it move through queued → running → done, right here, live."
            compact
          />
        ) : (
          <div className="flex flex-col gap-2">
            {sorted.map((job) => (
              <JobRow key={job.id} job={job} onAction={act} />
            ))}
          </div>
        )}
      </Card>
    </>
  )
}

function JobRow({
  job,
  onAction
}: {
  job: Job
  onAction: (fn: () => Promise<unknown>) => void
}): React.JSX.Element {
  const canCancel = (job.state === 'queued' || job.state === 'running') && job.cancellable
  const canRetry = job.state === 'failed' || job.state === 'cancelled'
  const canResume = job.state === 'interrupted'
  const canDismiss = job.state !== 'queued' && job.state !== 'running'

  return (
    <div className="flex items-center gap-3 rounded-xl border border-line-soft bg-canvas px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-ink">{job.title}</span>
          <Badge tone={STATE_TONE[job.state]}>{job.state}</Badge>
          <Badge tone="neutral">{job.lane}</Badge>
        </div>
        <p className="mt-0.5 text-[11px] text-faint">
          {job.state === 'running' || job.state === 'succeeded'
            ? formatProgress(job.progress)
            : null}
          {job.state === 'running' || job.state === 'succeeded' ? ' · ' : null}
          created {formatWhen(job.createdAt)}
          {job.startedAt ? ` · started ${formatWhen(job.startedAt)}` : ''}
          {job.endedAt ? ` · ended ${formatWhen(job.endedAt)}` : ''}
        </p>
        {job.error && <p className="mt-0.5 text-[11px] text-danger">{job.error.message}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {canCancel && (
          <Button
            variant="danger"
            size="sm"
            icon={Ban}
            onClick={() => onAction(() => window.api.jobs.cancel(job.id))}
          >
            Cancel
          </Button>
        )}
        {canRetry && (
          <Button
            variant="secondary"
            size="sm"
            icon={RotateCcw}
            onClick={() => onAction(() => window.api.jobs.retry(job.id))}
          >
            Retry
          </Button>
        )}
        {canResume && (
          <Button
            variant="secondary"
            size="sm"
            icon={PlayCircle}
            onClick={() => onAction(() => window.api.jobs.resume(job.id))}
          >
            Resume
          </Button>
        )}
        {canDismiss && (
          <Button
            variant="secondary"
            size="sm"
            icon={X}
            onClick={() => onAction(() => window.api.jobs.dismiss(job.id))}
          >
            Dismiss
          </Button>
        )}
      </div>
    </div>
  )
}
