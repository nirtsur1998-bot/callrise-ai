// M25 Sales Brain — IPC surface for backfill. Progress is polled (the
// renderer calls status() on an interval while running), same simplicity
// tradeoff as everywhere else in this app that surfaces long-running
// progress (no push-event streaming infrastructure needed for a rare,
// user-triggered, one-off action).
import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { isSalesBrainEnabled } from '../app-settings'
import { getMemoryDb } from './memory-runtime'
import { runBackfill, type BackfillProgress } from './backfill'

function callsDir(): string {
  return join(app.getPath('userData'), 'calls')
}
function contactsDir(): string {
  return join(app.getPath('userData'), 'contacts')
}
function dealsDir(): string {
  return join(app.getPath('userData'), 'deals')
}

let lastProgress: BackfillProgress = { running: false, stage: 'idle', processed: 0, total: 0 }

let registered = false

export function registerBackfill(): void {
  if (registered) return
  registered = true

  ipcMain.handle(
    'salesBrain:backfill:start',
    async (_e, opts: unknown): Promise<{ ok: boolean; message?: string }> => {
      if (!isSalesBrainEnabled()) return { ok: false, message: 'Sales Brain is off.' }
      const db = getMemoryDb()
      if (!db) return { ok: false, message: 'Sales Brain is not ready yet.' }
      if (lastProgress.running) return { ok: false, message: 'A backfill is already running.' }

      const o = (opts && typeof opts === 'object' ? opts : {}) as Record<string, unknown>
      lastProgress = { running: true, stage: 'contacts', processed: 0, total: 0 }
      void runBackfill(
        db,
        {
          includeContacts: o.includeContacts !== false,
          includeDeals: o.includeDeals !== false,
          includeCalls: o.includeCalls === true, // opt-in, off unless explicitly requested — the slow/costly part
          callsDir: callsDir(),
          contactsDir: contactsDir(),
          dealsDir: dealsDir()
        },
        (p) => {
          lastProgress = p
        }
      )
      return { ok: true }
    }
  )

  ipcMain.handle('salesBrain:backfill:status', async (): Promise<BackfillProgress> => {
    return lastProgress
  })
}
