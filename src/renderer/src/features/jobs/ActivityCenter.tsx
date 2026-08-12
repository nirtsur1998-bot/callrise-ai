import { useEffect, useRef, useState } from 'react'
import { Activity, Ban, Check, RotateCcw, PlayCircle, X, Trash2, AlertTriangle } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { Badge, type BadgeTone } from '@renderer/components/Badge'
import { EmptyState } from '@renderer/components/EmptyState'
import { useToast } from '@renderer/features/notifications/useToast'
import { useJobs } from './useJobs'
import { holdsUnreviewedOutput } from './holdsUnreviewedOutput'
import type { Job, JobActivityEvent, JobState } from '../../../../preload/index.d'

const LAST_VIEWED_KEY = 'salesos.activityCenter.lastViewedAt'

function getLastViewed(): number {
  const raw = localStorage.getItem(LAST_VIEWED_KEY)
  const n = raw ? Number(raw) : 0
  return Number.isFinite(n) ? n : 0
}

const STATE_TONE: Record<JobState, BadgeTone> = {
  queued: 'neutral',
  running: 'accent',
  succeeded: 'positive',
  failed: 'danger',
  cancelled: 'neutral',
  interrupted: 'warning'
}

function formatProgress(progress: Job['progress']): string | null {
  if (progress.mode === 'determinate') {
    // A download has no item count worth showing — "47185920 / 98304000"
    // is not something to put in front of a human.
    if (progress.unit === 'percent') return `${progress.itemsDone}%`
    return `${progress.itemsDone} / ${progress.itemsTotal}`
  }
  if (progress.mode === 'stages') return progress.stageLabel
  return null
}

/**
 * "A persistent indicator in the app chrome" (CLAUDE.md) — deliberately
 * rendered as a fixed-position overlay from App.tsx, a sibling to MainApp,
 * rather than something MainApp itself owns: MainApp swaps to a completely
 * different tree for Settings (see MainApp.tsx's `active === 'settings'`
 * early return, documented in the M26 Phase 0 navigation map), so anything
 * placed INSIDE either branch would disappear exactly when the rep opens
 * Settings — the single most common way this milestone's whole "work dies
 * on navigation" bug got triggered in the first place. Living here instead
 * means it survives every screen, Settings included, by construction.
 */
export function ActivityCenter(): React.JSX.Element {
  const jobs = useJobs()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [lastViewedAt, setLastViewedAt] = useState(getLastViewed)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  // Toasts for start/completion — already call-aware-DND-filtered by main
  // (never fires while a live call is active; a digest arrives instead
  // once it ends), so this is a straight pass-through, no DND logic here.
  useEffect(() => {
    return window.api.jobs.onNotify((payload) => {
      const event = payload as JobActivityEvent
      if (event.kind === 'started') toast.info(event.message)
      else if (event.kind === 'succeeded')
        toast.success(event.message, { label: 'View', onClick: () => setOpen(true) })
      else if (event.kind === 'failed')
        toast.error(event.message, { label: 'View', onClick: () => setOpen(true) })
      else toast.info(event.message, { label: 'View', onClick: () => setOpen(true) })
    })
  }, [toast])

  // Clicked an OS-native notification while the app was unfocused.
  useEffect(() => {
    return window.api.jobs.onOpenRequested(() => setOpen(true))
  }, [])

  const running = jobs.filter((j) => j.state === 'running')
  const queued = jobs.filter((j) => j.state === 'queued')
  const recent = jobs
    .filter((j) => j.state === 'succeeded' || j.state === 'failed' || j.state === 'interrupted')
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  const unread = recent.filter((j) => (j.endedAt ?? 0) > lastViewedAt).length
  const active = running.length + queued.length

  const openPanel = (): void => {
    setOpen((v) => !v)
    if (!open) {
      const now = Date.now()
      setLastViewedAt(now)
      localStorage.setItem(LAST_VIEWED_KEY, String(now))
    }
  }

  const act = (fn: () => Promise<unknown>): void => {
    void fn()
  }

  // BUG-052 — this used to sweep EVERYTHING in Recent, including a finished
  // Generate tasks / Generate CRM note job whose result is the only copy of
  // AI output the rep hasn't looked at yet. One click, no confirmation, and
  // it was gone — plus a silent re-run and re-bill next time they opened it,
  // since both adapters treat a succeeded job as "already generated". Main
  // refuses those outright now; skipping them here too means the button
  // clears what it legitimately can instead of half-failing invisibly.
  const clearHistory = (): void => {
    for (const job of recent) {
      if (holdsUnreviewedOutput(job)) continue
      act(() => window.api.jobs.dismiss(job.id))
    }
  }
  const clearableCount = recent.filter((j) => !holdsUnreviewedOutput(j)).length

  return (
    // Bottom-right, same corner as the toast stack (ToastProvider.tsx —
    // `right-6 bottom-6`, growing upward as toasts stack) but parked well
    // above it rather than sharing the exact spot, so a toast never
    // physically covers this persistent button. Bottom-LEFT was tried
    // first and rejected — it collided with the sidebar's own Settings +
    // account block, which (like the copilot panel's own header icons)
    // isn't visible from Settings' completely separate tree anyway, so it
    // couldn't have anchored against it even on purpose.
    <div ref={rootRef} className="fixed right-6 bottom-24 z-50">
      <button
        type="button"
        onClick={openPanel}
        aria-label={
          active > 0 ? `${active} background job${active === 1 ? '' : 's'} active` : 'Activity'
        }
        className={cn(
          'press relative flex h-10 w-10 items-center justify-center rounded-full border shadow-pop transition',
          active > 0
            ? 'border-accent/30 bg-accent-soft text-accent'
            : 'border-line-soft bg-surface text-faint hover:text-ink'
        )}
      >
        <Activity className={cn('h-4.5 w-4.5', active > 0 && 'animate-pulse')} strokeWidth={2.25} />
        {active > 0 && (
          <span className="absolute -top-1 -right-1 grid h-4.5 min-w-4.5 place-items-center rounded-full bg-accent px-1 text-[10px] font-semibold text-white">
            {active}
          </span>
        )}
        {active === 0 && unread > 0 && (
          <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-danger ring-2 ring-canvas" />
        )}
      </button>

      {open && (
        <div className="absolute right-0 bottom-12 flex max-h-[70vh] w-80 flex-col overflow-hidden rounded-2xl border border-line-soft bg-surface shadow-pop">
          <div className="flex items-center justify-between border-b border-line-soft px-3.5 py-2.5">
            <h3 className="text-[13px] font-semibold">Activity</h3>
            {clearableCount > 0 && (
              <button
                type="button"
                onClick={clearHistory}
                className="press flex items-center gap-1 text-[11px] font-medium text-faint hover:text-ink"
              >
                <Trash2 className="h-3 w-3" /> Clear history
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {running.length === 0 && queued.length === 0 && recent.length === 0 ? (
              <EmptyState
                icon={Activity}
                title="Nothing here yet"
                description="Background work — imports, AI summaries, scans — will show up here as it runs."
                compact
              />
            ) : (
              <>
                <Group title="Running" jobs={running} act={act} />
                <Group title="Queued" jobs={queued} act={act} />
                <Group title="Recent" jobs={recent} act={act} />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Group({
  title,
  jobs,
  act
}: {
  title: string
  jobs: Job[]
  act: (fn: () => Promise<unknown>) => void
}): React.JSX.Element | null {
  if (jobs.length === 0) return null
  return (
    <div className="mb-2 last:mb-0">
      <p className="px-1.5 py-1 text-[11px] font-semibold tracking-wide text-faint uppercase">
        {title}
      </p>
      <div className="flex flex-col gap-1">
        {jobs.map((job) => (
          <Row key={job.id} job={job} act={act} />
        ))}
      </div>
    </div>
  )
}

function Row({
  job,
  act
}: {
  job: Job
  act: (fn: () => Promise<unknown>) => void
}): React.JSX.Element {
  const progress = formatProgress(job.progress)
  const canCancel = (job.state === 'queued' || job.state === 'running') && job.cancellable
  const canRetry = job.state === 'failed'
  const canResume = job.state === 'interrupted'
  // BUG-052 — never offer Dismiss on a job still holding unreviewed AI
  // output; main refuses it, so the button would silently do nothing. The
  // rep clears it by actually dealing with the draft (save, or discard it
  // in the screen that owns it).
  const canDismiss =
    (job.state === 'succeeded' || job.state === 'failed' || job.state === 'interrupted') &&
    !holdsUnreviewedOutput(job)

  return (
    <div className="flex items-start gap-2 rounded-xl px-1.5 py-1.5 hover:bg-elevated">
      <div className="mt-0.5 shrink-0">
        {job.state === 'succeeded' ? (
          <Check className="h-3.5 w-3.5 text-positive" />
        ) : job.state === 'failed' ? (
          <AlertTriangle className="h-3.5 w-3.5 text-danger" />
        ) : (
          <Badge tone={STATE_TONE[job.state]} className="px-1.5 py-0 text-[9px]">
            {job.state}
          </Badge>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12.5px] font-medium text-ink">{job.title}</p>
        {progress && <p className="text-[11px] text-faint">{progress}</p>}
        {job.error && <p className="text-[11px] text-danger">{job.error.message}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {canCancel && (
          <button
            type="button"
            title="Cancel"
            onClick={() => act(() => window.api.jobs.cancel(job.id))}
            className="press grid h-6 w-6 place-items-center rounded text-faint hover:bg-danger-soft hover:text-danger"
          >
            <Ban className="h-3.5 w-3.5" />
          </button>
        )}
        {canRetry && (
          <button
            type="button"
            title="Retry"
            onClick={() => act(() => window.api.jobs.retry(job.id))}
            className="press grid h-6 w-6 place-items-center rounded text-faint hover:bg-elevated hover:text-ink"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        )}
        {canResume && (
          <button
            type="button"
            title="Resume"
            onClick={() => act(() => window.api.jobs.resume(job.id))}
            className="press grid h-6 w-6 place-items-center rounded text-faint hover:bg-elevated hover:text-ink"
          >
            <PlayCircle className="h-3.5 w-3.5" />
          </button>
        )}
        {canDismiss && (
          <button
            type="button"
            title="Dismiss"
            onClick={() => act(() => window.api.jobs.dismiss(job.id))}
            className="press grid h-6 w-6 place-items-center rounded text-faint hover:bg-elevated hover:text-ink"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}
