// M29 A5.3 — the Export Sales Brain button, driven end to end with a real
// database and a stubbed dialog. Also extends the one-mechanism assertion:
// the export IPC and the cloud upload must BOTH call snapshotMemoryDb —
// "not two implementations of db.backup() that drift" (founder).
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type DatabaseT from 'better-sqlite3'

let dir: string
let savePath: string | undefined
let saveCanceled = false
const showItemInFolder = vi.fn()

vi.mock('electron', () => ({
  app: { getPath: () => dir },
  ipcMain: { handle: vi.fn() },
  dialog: {
    showSaveDialog: async () => ({ canceled: saveCanceled, filePath: savePath })
  },
  shell: { showItemInFolder },
  BrowserWindow: { getFocusedWindow: () => ({}), getAllWindows: () => [{}] }
}))
vi.mock('../memory-runtime', () => ({ getMemoryDb: () => null }))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3') as typeof DatabaseT

const { exportSalesBrainSnapshot } = await import('../export-ipc')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sb-export-'))
  savePath = undefined
  saveCanceled = false
  showItemInFolder.mockClear()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeWalDb(): void {
  const db = new Database(join(dir, 'memory.db'))
  db.pragma('journal_mode = WAL')
  db.exec('create table memories (text TEXT)')
  db.prepare('insert into memories values (?)').run('base')
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.prepare('insert into memories values (?)').run('walrow')
  db.close() // the button also works with the app's connection closed
}

describe('Export Sales Brain', () => {
  it('writes a consistent snapshot (WAL row included) and opens the folder', async () => {
    makeWalDb()
    savePath = join(dir, 'SalesBrain-export.db')
    const r = await exportSalesBrainSnapshot()
    expect(r.ok).toBe(true)
    expect(r.path).toBe(savePath)
    expect(existsSync(savePath)).toBe(true)
    const check = new Database(savePath, { readonly: true })
    try {
      const rows = (
        check.prepare('select text from memories order by text').all() as { text: string }[]
      ).map((x) => x.text)
      expect(rows).toEqual(['base', 'walrow'])
    } finally {
      check.close()
    }
    expect(showItemInFolder).toHaveBeenCalledWith(savePath)
  })

  it('cancel in the dialog exports nothing and opens nothing', async () => {
    makeWalDb()
    saveCanceled = true
    const r = await exportSalesBrainSnapshot()
    expect(r).toEqual({ ok: false, canceled: true })
    expect(showItemInFolder).not.toHaveBeenCalled()
  })

  it('no Sales Brain yet: an honest reason, never a throw', async () => {
    savePath = join(dir, 'out.db')
    const r = await exportSalesBrainSnapshot()
    expect(r).toEqual({ ok: false, reason: 'no-memory-db' })
    expect(existsSync(savePath)).toBe(false)
  })
})

describe('one mechanism, both callers (extended from the A5.2 assertion)', () => {
  it('export-ipc.ts snapshots via snapshotMemoryDb and never touches better-sqlite3 itself', () => {
    const stripComments = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    const src = stripComments(readFileSync(join(__dirname, '..', 'export-ipc.ts'), 'utf8'))
    expect(src).toContain('snapshotMemoryDb(')
    expect(src).not.toContain('better-sqlite3')
    expect(src).not.toContain('.backup(')
  })
})
