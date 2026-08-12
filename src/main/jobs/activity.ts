// M26 Phase 2 — turns raw job-list snapshots into the actual notification
// events CLAUDE.md asks for: a toast the instant something starts, a toast
// (+ native notification when the window isn't focused) the instant
// something finishes -- UNLESS a live call is in progress, in which case
// completions are buffered and delivered as one digest the moment the call
// ends ("HARD RULE -- call-aware Do-Not-Disturb: while a live call is
// active, NO OS popups and no noisy in-app toasts").
//
// The decision logic (ActivityNotifier, computeTaskbarProgress) is plain
// data in, plain data out -- no Electron import, no I/O -- so it's unit
// testable the same way IdleStopWatcher (auto-stop.ts) and
// isRecurringDue/isIdleDue (scheduler.ts) already are in this codebase.
// wireJobActivity() at the bottom is the thin, untested-by-design layer
// that actually calls into Electron.
import { BrowserWindow } from 'electron'
import { showNativeNotification } from '../notifications'
import type { Job, JobState } from './types'
import type { JobManager } from './JobManager'

export type ActivityEvent =
  | { kind: 'started'; job: Job; message: string }
  | { kind: 'succeeded' | 'failed'; job: Job; message: string }
  | { kind: 'digest'; jobs: Job[]; message: string }

function isTerminal(state: JobState): boolean {
  return (
    state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'interrupted'
  )
}

function completionEvent(job: Job): ActivityEvent {
  if (job.state === 'succeeded') return { kind: 'succeeded', job, message: `${job.title} — done` }
  return {
    kind: 'failed',
    job,
    message: `${job.title} — failed: ${job.error?.message ?? 'something went wrong'}`
  }
}

function digestEvent(jobs: Job[]): ActivityEvent {
  const succeeded = jobs.filter((j) => j.state === 'succeeded').length
  const failed = jobs.filter((j) => j.state === 'failed').length
  const parts: string[] = []
  if (succeeded) parts.push(`${succeeded} finished`)
  if (failed) parts.push(`${failed} failed`)
  return {
    kind: 'digest',
    jobs,
    message: `While you were on your call: ${parts.join(', ')} — track in Activity`
  }
}

/** Stateful across calls (tracks what it's already seen), but every method
 *  is pure with respect to the outside world — feed it snapshots, get back
 *  exactly the events that should fire right now, already DND-filtered. */
export class ActivityNotifier {
  private previous = new Map<string, Job>()
  private pendingDigest: Job[] = []
  private wasLiveActive = false

  next(jobs: Job[]): ActivityEvent[] {
    const events: ActivityEvent[] = []
    const liveActive = jobs.some((j) => j.lane === 'LIVE' && j.state === 'running')

    for (const job of jobs) {
      // The call itself is never "background work about the call" — its
      // own start/end must never generate a job notification (that would
      // read as an odd "Test job — done" the instant every call wraps up).
      // Only non-LIVE jobs are notification-worthy here.
      if (job.lane === 'LIVE') continue
      // Job types that ship their own, better-worded completion
      // notification — contact auto-attach's "Automatically created and
      // attached 'Dana'" beats a generic "Detecting who this was — done".
      // They still appear in the Activity Center; this only suppresses the
      // toast/OS-notification stream, so migrating such a feature to a job
      // doesn't silently double up its notifications. Safe to skip before
      // the bookkeeping below: `previous` is rebuilt from the full list at
      // the end of this method regardless.
      if (job.silent) continue
      const prior = this.previous.get(job.id)
      if (!prior) {
        // A brand-new job. Suppressed entirely during a call, not
        // buffered — by the time the call ends, "X started a while ago"
        // is stale, uninteresting information; the digest should be about
        // what finished, not what began.
        if (!liveActive) {
          events.push({
            kind: 'started',
            job,
            message: `Started: ${job.title} — track in Activity`
          })
        }
        continue
      }
      const justFinished =
        !isTerminal(prior.state) && (job.state === 'succeeded' || job.state === 'failed')
      if (!justFinished) continue
      if (liveActive) this.pendingDigest.push(job)
      else events.push(completionEvent(job))
    }

    if (this.wasLiveActive && !liveActive && this.pendingDigest.length > 0) {
      events.push(digestEvent(this.pendingDigest))
      this.pendingDigest = []
    }

    this.previous = new Map(jobs.map((j) => [j.id, j]))
    this.wasLiveActive = liveActive
    return events
  }
}

export interface TaskbarProgress {
  /** -1 clears the bar; 0-1 is a real fraction; ignored (but still passed,
   *  in-range, for platforms that don't support the indeterminate mode) when
   *  `mode` is 'indeterminate'. */
  progress: number
  mode?: 'indeterminate'
}

/** Determinate only when EVERY currently-running job is itself reporting
 *  real determinate progress — a mix of "12/50" and "Analyzing…" has no
 *  honest single percent, so the whole bar goes indeterminate rather than
 *  quietly ignoring half the running work. */
export function computeTaskbarProgress(jobs: Job[]): TaskbarProgress {
  const running = jobs.filter((j) => j.state === 'running')
  if (running.length === 0) return { progress: -1 }
  const allDeterminate = running.every((j) => j.progress.mode === 'determinate')
  if (!allDeterminate) return { progress: 1, mode: 'indeterminate' }
  let done = 0
  let total = 0
  for (const j of running) {
    if (j.progress.mode === 'determinate') {
      done += j.progress.itemsDone
      total += j.progress.itemsTotal
    }
  }
  return { progress: total > 0 ? done / total : 0 }
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

/** Wires ActivityNotifier + computeTaskbarProgress to real Electron APIs.
 *  Call once, after the JobManager and the main window's creation are both
 *  underway (a getter, not the window itself, since this is wired up before
 *  createWindow() runs later in the same startup sequence). */
export function wireJobActivity(
  manager: JobManager,
  getMainWindow: () => BrowserWindow | null
): void {
  const notifier = new ActivityNotifier()

  manager.onChange((jobs) => {
    for (const event of notifier.next(jobs)) {
      // In-app toast — every event gets one, whether or not the window has
      // focus (a toast the rep never sees because they were elsewhere is a
      // fine trade for never missing one because of a stricter gate).
      broadcast('jobs:notify', event)

      // OS-native notification: completions only ("Starting any job shows
      // an immediate toast" is explicitly an in-app-only requirement), and
      // only when the window is unfocused/minimized/hidden — the whole
      // point of the OS layer is reaching the rep while they're in a
      // DIFFERENT app; the in-app toast already covers the focused case.
      if (event.kind === 'started') continue
      const win = getMainWindow()
      if (win && win.isFocused() && win.isVisible()) continue
      showNativeNotification({
        title: 'CallRise AI',
        body: event.message,
        onClick: () => {
          const w = getMainWindow()
          w?.webContents.send(
            'jobs:openRequested',
            event.kind === 'digest' ? undefined : event.job.id
          )
        }
      })
    }

    const { progress, mode } = computeTaskbarProgress(jobs)
    getMainWindow()?.setProgressBar(progress, mode ? { mode } : undefined)

    // NOT wired to the ambient-detection tray icon (detection-tray.ts) —
    // considered per the founder's own sign-off on the Phase 0 finding
    // ("reuse the tray, don't add a second one"), but detection-tray.ts's
    // updateTray() owns its own snapshot/tooltip state privately inside
    // detection-service.ts's closure; merging a job summary into that
    // tooltip needs real coordination between the two modules, not a
    // one-line call, and risks a real bug in the already-working ambient-
    // detection feature for a cosmetic win most users (detection defaults
    // off) would never see anyway. Deliberately deferred, not forgotten —
    // the in-app indicator (ActivityCenter.tsx) is the one CLAUDE.md's
    // spec actually requires ("a persistent indicator in the app chrome"),
    // and it doesn't depend on the tray at all.
  })
}
