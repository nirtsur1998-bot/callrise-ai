// M29 A5.2 — BUG-088 (WAL-blind upload) and BUG-089 (restore without clearing
// stale sidecars), fixed through the ONE shared snapshot mechanism.
//
// The fixture reproduces BUG-088's exact live shape: a real WAL database
// where a checkpoint separates 'base' (folded into the main file) from
// 'walrow' (living only in memory.db-wal, like the founder's nine days of
// memories). The CONTROL asserts a raw fs.readFile really does lose
// 'walrow' — proving the fixture discriminates — before the fix is asserted.
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type DatabaseT from 'better-sqlite3'

let dir: string
vi.mock('electron', () => ({
  app: { getPath: () => dir },
  ipcMain: { handle: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false }
}))
// snapshot.ts consults the live runtime handle first; these tests exercise
// the open-fresh path, so the runtime (a heavy import graph) is stubbed out.
vi.mock('../memory/memory-runtime', () => ({ getMemoryDb: () => null }))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3') as typeof DatabaseT

const { snapshotMemoryDb } = await import('../memory/snapshot')
const { uploadSalesBrainDb, downloadSalesBrainDb } = await import('../backup')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sb-snapshot-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Build the BUG-088 shape: 'base' in the main file, 'walrow' only in the WAL. */
function walFixture(): { db: DatabaseT.Database; dbPath: string } {
  const dbPath = join(dir, 'memory.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec('create table memories (text TEXT)')
  db.prepare('insert into memories values (?)').run('base')
  db.pragma('wal_checkpoint(TRUNCATE)') // 'base' is now in the main file
  db.prepare('insert into memories values (?)').run('walrow') // WAL only
  return { db, dbPath }
}

function rowsOf(path: string): string[] {
  const db = new Database(path, { readonly: true })
  try {
    return (db.prepare('select text from memories order by text').all() as { text: string }[]).map(
      (r) => r.text
    )
  } finally {
    db.close()
  }
}

describe('the fixture reproduces BUG-088 (the control)', () => {
  it('a raw fs.readFile of memory.db loses the WAL-only row', async () => {
    const { db, dbPath } = walFixture()
    try {
      const rawCopy = join(dir, 'raw-copy.db')
      await writeFile(rawCopy, await readFile(dbPath))
      expect(rowsOf(rawCopy)).toEqual(['base']) // 'walrow' is GONE — the bug's shape
    } finally {
      db.close()
    }
  })
})

describe('snapshotMemoryDb — the one mechanism', () => {
  it('reads through the WAL: both rows present in the snapshot', async () => {
    const { db, dbPath } = walFixture()
    try {
      const dest = join(dir, 'snap.db')
      const r = await snapshotMemoryDb(dbPath, dest)
      expect(r.ok).toBe(true)
      expect(rowsOf(dest)).toEqual(['base', 'walrow'])
    } finally {
      db.close()
    }
  })

  it('uses a provided live handle when given one', async () => {
    const { db, dbPath } = walFixture()
    try {
      const dest = join(dir, 'snap-live.db')
      const r = await snapshotMemoryDb(dbPath, dest, { liveDb: db })
      expect(r.ok).toBe(true)
      expect(rowsOf(dest)).toEqual(['base', 'walrow'])
    } finally {
      db.close()
    }
  })

  it('no file: no-memory-db, and it never throws', async () => {
    const r = await snapshotMemoryDb(join(dir, 'nope.db'), join(dir, 'out.db'))
    expect(r).toEqual({ ok: false, reason: 'no-memory-db' })
  })
})

describe('BUG-088 — the upload ships the snapshot, not the stale main file', () => {
  it('uploaded bytes contain the WAL-only row, and the temp snapshot is cleaned up', async () => {
    const { db } = walFixture()
    try {
      let uploadedBytes: Buffer | null = null
      const client = {
        storage: {
          from: () => ({
            upload: async (_path: string, data: Buffer) => {
              uploadedBytes = Buffer.from(data)
              return { error: null }
            }
          })
        }
      }
      await uploadSalesBrainDb(client as never, 'uid-1')
      expect(uploadedBytes).not.toBeNull()
      const uploadedFile = join(dir, 'uploaded.db')
      await writeFile(uploadedFile, uploadedBytes!)
      expect(rowsOf(uploadedFile)).toEqual(['base', 'walrow']) // the fix, on the bug's own shape
      expect(existsSync(join(dir, 'memory.db.upload-snapshot'))).toBe(false) // no residue
    } finally {
      db.close()
    }
  })

  it('no memory.db: uploads nothing, silently (Sales Brain never enabled)', async () => {
    let called = false
    const client = {
      storage: {
        from: () => ({
          upload: async () => {
            called = true
            return { error: null }
          }
        })
      }
    }
    await uploadSalesBrainDb(client as never, 'uid-1')
    expect(called).toBe(false)
  })
})

describe('BUG-089 — the restore clears stale sidecars before writing', () => {
  it('plants stale -wal/-shm, restores, and the sidecars are gone with the DB readable', async () => {
    // A donor DB to be "the cloud copy".
    const donorPath = join(dir, 'donor.db')
    const donor = new Database(donorPath)
    donor.exec("create table memories (text TEXT); insert into memories values ('from-cloud')")
    donor.close()
    const cloudBytes = readFileSync(donorPath)

    // The BUG-089 trigger: sidecars present, main file absent.
    const dbPath = join(dir, 'memory.db')
    writeFileSync(`${dbPath}-wal`, 'stale garbage that must not survive')
    writeFileSync(`${dbPath}-shm`, 'stale garbage')
    expect(existsSync(`${dbPath}-wal`)).toBe(true) // control: the trigger is real

    const client = {
      storage: {
        from: () => ({
          download: async () => ({ data: new Blob([cloudBytes]), error: null })
        })
      }
    }
    await downloadSalesBrainDb(client as never, 'uid-1')

    expect(existsSync(dbPath)).toBe(true)
    expect(existsSync(`${dbPath}-wal`)).toBe(false) // the fix
    expect(existsSync(`${dbPath}-shm`)).toBe(false)
    expect(rowsOf(dbPath)).toEqual(['from-cloud']) // and the restored DB actually opens
  })

  it('never overwrites an existing local memory.db (the M25 invariant, untouched)', async () => {
    const dbPath = join(dir, 'memory.db')
    const local = new Database(dbPath)
    local.exec("create table memories (text TEXT); insert into memories values ('local-truth')")
    local.close()
    let downloadCalled = false
    const client = {
      storage: {
        from: () => ({
          download: async () => {
            downloadCalled = true
            return { data: null, error: null }
          }
        })
      }
    }
    await downloadSalesBrainDb(client as never, 'uid-1')
    expect(downloadCalled).toBe(false)
    expect(rowsOf(dbPath)).toEqual(['local-truth'])
  })
})

describe('one mechanism, both callers — asserted structurally', () => {
  it('backup.ts uploads via snapshotMemoryDb and has no raw read of the live db path', () => {
    // Judge the code, not the comments — the comment is allowed to NAME the
    // forbidden call while explaining why it is forbidden.
    const stripComments = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    const src = stripComments(readFileSync(join(__dirname, '..', 'backup.ts'), 'utf8'))
    const uploadFn = src.slice(
      src.indexOf('uploadSalesBrainDb'),
      src.indexOf('downloadSalesBrainDb')
    )
    expect(uploadFn).toContain('snapshotMemoryDb(')
    expect(uploadFn).not.toContain('readFile(dbPath)') // the BUG-088 line is gone for good
  })
})
