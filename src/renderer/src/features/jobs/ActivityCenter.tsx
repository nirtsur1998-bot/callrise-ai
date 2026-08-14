import { useEffect, useRef, useState } from 'react'
import { Activity, Ban, Check, RotateCcw, PlayCircle, X, Trash2, AlertTriangle } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { Badge, type BadgeTone } from '@renderer/components/Badge'
import { EmptyState } from '@renderer/components/EmptyState'
import { useToast } from '@renderer/features/notifications/useToast'
import { useJobs } from './useJobs'
import { holdsUnreviewedOutput } from './holdsUnreviewedOutput'
import {
  BUTTON_SIZE,
  clampToViewport,
  defaultPosition,
  panelPlacement,
  type Point
} from './activityButtonPosition'
import type { Job, JobActivityEvent, JobState } from '../../../../preload/index.d'

const LAST_VIEWED_KEY = 'salesos.activityCenter.lastViewedAt'
const POSITION_KEY = 'salesos.activityCenter.position'

function getLastViewed(): number {
  const raw = localStorage.getItem(LAST_VIEWED_KEY)
  const n = raw ? Number(raw) : 0
  return Number.isFinite(n) ? n : 0
}

/** Where the rep last parked the button, or null to use the default corner.
 *  Tolerant of anything unparseable — a corrupt value must never stop the
 *  Activity Center rendering at all. */
function getStoredPosition(): Point | null {
  try {
    const raw = localStorage.getItem(POSITION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Point>
    if (typeof parsed?.x !== 'number' || typeof parsed?.y !== 'number') return null
    if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return null
    return { x: parsed.x, y: parsed.y }
  } catch {
    return null
  }
}

/** How far the pointer must travel before a press counts as a DRAG rather
 *  than a click. Without it, the tiny movement in an ordinary click would
 *  register as a drag and swallow the open-the-panel action. */
const DRAG_THRESHOLD_PX = 4

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

  // M27 — draggable button. `null` means "never moved", which renders at the
  // original bottom-right anchor; the default is computed lazily from the
  // live window size rather than stored, so a rep who never drags it keeps
  // the corner placement across any window size, exactly as before.
  const [position, setPosition] = useState<Point | null>(getStoredPosition)
  const dragRef = useRef<{ dx: number; dy: number; moved: boolean } | null>(null)
  // Set the moment a drag ends, and cleared by the click that immediately
  // follows it. Pointer-up on a moved button still fires a click event; this
  // is what stops parking the button from also opening the panel.
  const suppressNextClickRef = useRef(false)

  const viewport = (): { width: number; height: number } => ({
    width: window.innerWidth,
    height: window.innerHeight
  })

  // Re-clamp when the window changes size. This is the difference between
  // "drag it anywhere" and "drag it somewhere you can never reach again": a
  // button parked at the right edge of a maximised window would otherwise sit
  // outside a restored half-width one, permanently.
  useEffect(() => {
    const onResize = (): void => {
      setPosition((p) => (p === null ? null : clampToViewport(p, viewport())))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>): void => {
    // Left button / primary touch only — a right-click should still be a
    // plain context menu, not the start of a drag.
    if (e.button !== 0) return
    const start = position ?? defaultPosition(viewport())
    dragRef.current = { dx: e.clientX - start.x, dy: e.clientY - start.y, moved: false }
    // Keeps events coming even when the pointer outruns the 40px button,
    // which it will on any fast drag.
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    const next = clampToViewport(
      { x: e.clientX - drag.dx, y: e.clientY - drag.dy },
      viewport()
    )
    const from = position ?? defaultPosition(viewport())
    if (!drag.moved && Math.hypot(next.x - from.x, next.y - from.y) >= DRAG_THRESHOLD_PX) {
      drag.moved = true
    }
    if (drag.moved) setPosition(next)
  }

  const endDrag = (e: React.PointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    if (!drag.moved) return
    suppressNextClickRef.current = true
    // Persisted only on drop, not on every move — a drag is dozens of frames
    // and localStorage is synchronous.
    setPosition((p) => {
      if (p) localStorage.setItem(POSITION_KEY, JSON.stringify(p))
      return p
    })
  }

  const handleButtonClick = (): void => {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false
      return
    }
    openPanel()
  }

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
  const finished = jobs
    .filter((j) => j.state === 'succeeded' || j.state === 'failed' || j.state === 'interrupted')
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))

  // M27 — drafts get their own pinned section instead of sinking into the
  // chronological Recent list.
  //
  // BUG-048 and BUG-050 exist because already-paid-for AI output (Generate
  // tasks' proposals, Generate CRM note's draft) used to be discarded when a
  // screen closed. The fix moved that output into the JOB, where it survives
  // navigation and even a restart — and retention.ts refuses to prune it, so
  // it is genuinely safe on disk. But safe-on-disk and FINDABLE are different
  // guarantees: Recent is strictly newest-first, and the post-call cascade
  // alone fires roughly six automatic jobs per call, so a draft from this
  // morning is buried under dozens of "Detecting who this was — done" rows by
  // the afternoon. A draft the rep can't find is functionally a draft they
  // lost, which is the exact outcome those two bugs were fixed to prevent.
  //
  // Same predicate retention.ts and Clear-history already use, deliberately —
  // one definition of "still holds unreviewed output", so the section shown,
  // the rows Clear-history skips, and the jobs pruning refuses can never
  // disagree about which jobs those are.
  const needsReview = finished.filter(holdsUnreviewedOutput)
  const recent = finished.filter((j) => !holdsUnreviewedOutput(j))
  // Counts drafts too (hence `finished`, not `recent`) — a freshly-generated
  // draft waiting on the rep is the single most badge-worthy thing here.
  const unread = finished.filter((j) => (j.endedAt ?? 0) > lastViewedAt).length
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
  // M27 — `recent` now EXCLUDES unreviewed drafts by construction (they live
  // in their own pinned section above), so this loop can no longer reach one
  // even in principle. That's a strictly stronger version of the same
  // protection than the per-item skip this used to rely on. Main still
  // refuses the delete outright (JobManager.dismiss demands consumed:true),
  // which remains the actual guarantee — this is the third independent layer,
  // not the only one.
  const clearHistory = (): void => {
    for (const job of recent) {
      act(() => window.api.jobs.dismiss(job.id))
    }
  }
  const clearableCount = recent.length

  return (
    // M27 — DRAGGABLE. The default is still the original bottom-right corner
    // (same corner as the toast stack, parked above it so a toast never
    // covers this persistent button; bottom-LEFT was tried and rejected for
    // colliding with the sidebar's Settings + account block). But it is no
    // longer FIXED there: the rep can drag it anywhere, because where it
    // needs to be depends on what they're looking at — on the live-call
    // screen it sat over the Voice AI panel's own controls.
    //
    // Positioned by explicit coordinates once moved; `position === null` means
    // untouched, which resolves to the same corner it has always used.
    <div
      ref={rootRef}
      className="fixed z-50"
      style={(() => {
        const p = position ?? defaultPosition(viewport())
        return { left: p.x, top: p.y, width: BUTTON_SIZE, height: BUTTON_SIZE }
      })()}
    >
      <button
        type="button"
        onClick={handleButtonClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        aria-label={
          active > 0 ? `${active} background job${active === 1 ? '' : 's'} active` : 'Activity'
        }
        title="Activity — drag to move"
        className={cn(
          'press relative flex h-10 w-10 cursor-grab items-center justify-center rounded-full border shadow-pop transition active:cursor-grabbing',
          // Suppresses the browser's own touch panning/scrolling while
          // dragging, so a drag on a touchscreen moves the button instead of
          // scrolling whatever is underneath it.
          'touch-none',
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
        // M27 — placement follows the button. This used to be hardcoded
        // `right-0 bottom-12`, which is correct ONLY for a bottom-right
        // button; with the button draggable to the top-left, that same panel
        // would open upward and leftward — off-screen on both axes. Each axis
        // now picks the side with room (see panelPlacement).
        <div
          className={cn(
            'absolute flex max-h-[70vh] w-80 flex-col overflow-hidden rounded-2xl border border-line-soft bg-surface shadow-pop',
            (() => {
              const place = panelPlacement(position ?? defaultPosition(viewport()), viewport())
              return cn(
                place.vertical === 'above' ? 'bottom-12' : 'top-12',
                place.horizontal === 'right' ? 'right-0' : 'left-0'
              )
            })()
          )}
        >
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
            {running.length === 0 &&
            queued.length === 0 &&
            recent.length === 0 &&
            needsReview.length === 0 ? (
              <EmptyState
                icon={Activity}
                title="Nothing here yet"
                description="Background work — imports, AI summaries, scans — will show up here as it runs."
                compact
              />
            ) : (
              <>
                {/* M27 — FIRST, above running work, and deliberately so: this
                    is the only group holding something the rep must act on
                    (already-paid-for AI output waiting to be reviewed or
                    saved). Everything below it is informational. */}
                <Group title="Needs your review" jobs={needsReview} act={act} />
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
            {/* M27 — a job held by quota-pressure deferral is still `queued`,
                but the bare word "queued" reads as "your turn is coming
                shortly" when the real reason is that every configured AI
                model is currently unusable, which can last hours. Say which
                one it actually is. */}
            {job.deferredForCapacity ? 'waiting for AI capacity' : job.state}
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
