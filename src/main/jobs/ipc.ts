// The renderer's whole view of the job system: read the queue, control a
// job (cancel/retry/resume/dismiss), and a throttled push of the full
// snapshot whenever anything changes. Deliberately NOT a generic "enqueue"
// endpoint — only main-process code (a Phase 3 adapter's own IPC handler,
// or this file's own dev-only fake-job endpoint) may call
// JobManager.enqueue(); letting the renderer enqueue arbitrary job types by
// name would bypass whatever validation each real feature's own handler is
// supposed to apply.
import { BrowserWindow, ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { JobManager } from './JobManager'
import type { Job, JobView } from './types'
import { throttle } from './throttle'
import type { FakeBatchInput, FakeCpuInput, FakeStagedInput } from './fakeJobs'

/** CLAUDE.md: "throttle updates (~4/sec max) so a hot loop can't flood
 *  IPC." 260ms rather than a flat 250 so this and JobManager's own
 *  persistence throttle don't beat in lockstep against every caller. */
const BROADCAST_THROTTLE_MS = 260

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

type DevFakeJobRequest =
  | { kind: 'batch'; input: FakeBatchInput }
  | { kind: 'staged'; input: FakeStagedInput }
  | { kind: 'cpu'; input: FakeCpuInput }

const FAKE_JOB_TYPE: Record<DevFakeJobRequest['kind'], string> = {
  batch: 'dev:fakeBatch',
  staged: 'dev:fakeStaged',
  cpu: 'dev:fakeCpu'
}

let registered = false

/**
 * M27 — the renderer's view: stored jobs plus the derived
 * `deferredForCapacity` flag, attached HERE at the IPC boundary rather than
 * inside JobManager. That placement is the point: `manager.list()` stays the
 * clean stored state that `flush()` persists, so a purely-presentational flag
 * can never leak into jobs-state.json (or into retention/resume logic that
 * reads it back). Shallow-copies only the affected jobs — the common case
 * (no pressure) allocates nothing at all.
 */
function jobViews(manager: JobManager): JobView[] {
  const deferred = manager.deferredJobIds()
  if (deferred.size === 0) return manager.list()
  return manager.list().map((j) => (deferred.has(j.id) ? { ...j, deferredForCapacity: true } : j))
}

export function registerJobsIpc(manager: JobManager): void {
  if (registered) return
  registered = true

  ipcMain.handle('jobs:list', (): JobView[] => jobViews(manager))
  ipcMain.handle('jobs:get', (_e, id: string): Job | null => manager.get(id))
  ipcMain.handle('jobs:cancel', (_e, id: string): { ok: boolean } => ({ ok: manager.cancel(id) }))
  ipcMain.handle('jobs:retry', (_e, id: string): Job | null => manager.retry(id))
  ipcMain.handle('jobs:resume', (_e, id: string): Job | null => manager.resume(id))
  ipcMain.handle('jobs:dismiss', (_e, id: string): { ok: boolean } => ({ ok: manager.dismiss(id) }))

  // Re-derives the view at SEND time rather than forwarding the snapshot the
  // change event carried: capacity can change without any job changing (a
  // cooldown expiring is not a job event), and the poll in JobManager
  // re-ticks on exactly that. Deriving here keeps the flag honest at the
  // moment it's actually sent.
  const broadcastChanged = throttle(
    () => broadcast('jobs:changed', jobViews(manager)),
    BROADCAST_THROTTLE_MS
  )
  manager.onChange(() => broadcastChanged.call())

  // Dev-only, and narrowly typed even in dev — see the file header.
  if (is.dev) {
    ipcMain.handle('jobs:dev:startFake', (_e, req: DevFakeJobRequest): Job => {
      return manager.enqueue(FAKE_JOB_TYPE[req.kind], req.input)
    })
  }
}
