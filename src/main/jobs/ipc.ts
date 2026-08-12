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
import type { Job } from './types'
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

export function registerJobsIpc(manager: JobManager): void {
  if (registered) return
  registered = true

  ipcMain.handle('jobs:list', (): Job[] => manager.list())
  ipcMain.handle('jobs:get', (_e, id: string): Job | null => manager.get(id))
  ipcMain.handle('jobs:cancel', (_e, id: string): { ok: boolean } => ({ ok: manager.cancel(id) }))
  ipcMain.handle('jobs:retry', (_e, id: string): Job | null => manager.retry(id))
  ipcMain.handle('jobs:resume', (_e, id: string): Job | null => manager.resume(id))
  ipcMain.handle('jobs:dismiss', (_e, id: string): { ok: boolean } => ({ ok: manager.dismiss(id) }))

  const broadcastChanged = throttle(
    (jobs: Job[]) => broadcast('jobs:changed', jobs),
    BROADCAST_THROTTLE_MS
  )
  manager.onChange((jobs) => broadcastChanged.call(jobs))

  // Dev-only, and narrowly typed even in dev — see the file header.
  if (is.dev) {
    ipcMain.handle('jobs:dev:startFake', (_e, req: DevFakeJobRequest): Job => {
      return manager.enqueue(FAKE_JOB_TYPE[req.kind], req.input)
    })
  }
}
