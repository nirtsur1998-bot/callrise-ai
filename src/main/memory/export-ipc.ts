// M29 A5.3 — "Export Sales Brain…": a one-click consistent snapshot of
// memory.db while the app runs, via THE shared mechanism (snapshotMemoryDb —
// the same call BUG-088's cloud upload uses; the one-helper constraint is
// asserted by test). Replaces the founder's quit-and-copy-three-files weekly
// ritual from docs/M29-salesbrain-stopgap.md.

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { memoryDbPath } from './db'
import { snapshotMemoryDb } from './snapshot'

export interface ExportSnapshotResult {
  ok: boolean
  path?: string
  bytes?: number
  canceled?: boolean
  /** 'no-memory-db' | 'snapshot-failed' — short reasons, never error prose. */
  reason?: string
}

export async function exportSalesBrainSnapshot(): Promise<ExportSnapshotResult> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const defaultName = `SalesBrain-${new Date().toISOString().slice(0, 10)}.db`
  const { canceled, filePath } = await dialog.showSaveDialog(win!, {
    title: 'Export Sales Brain',
    defaultPath: join(app.getPath('downloads'), defaultName),
    filters: [{ name: 'SQLite database', extensions: ['db'] }]
  })
  if (canceled || !filePath) return { ok: false, canceled: true }

  const result = await snapshotMemoryDb(memoryDbPath(app.getPath('userData')), filePath)
  if (!result.ok) return { ok: false, reason: result.reason }
  shell.showItemInFolder(filePath)
  return { ok: true, path: filePath, bytes: result.bytes }
}

export function registerSalesBrainExport(): void {
  ipcMain.handle('salesBrain:exportSnapshot', () => exportSalesBrainSnapshot())
}
