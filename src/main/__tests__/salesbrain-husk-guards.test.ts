// BUG-092 — an empty local memory.db defeated the restore guard, and the next
// upload then overwrote the only cloud copy with it (`upsert: true`, no
// version history). Reached by a user doing exactly the right thing: enabling
// the backup to get their memories back.
//
// Measured husk shapes, both of which an existence check reads as "local truth":
//   0 bytes    — `new DatabaseCtor(path)` creates the file before the WAL
//                pragma or loadExtension can throw (the clean-Windows class)
//   8192 bytes — successful init, schema only, zero `memories` rows
//
// Founder-approved decision table (the uncertain row follows their rule,
// "when the choice is 'might lose data' vs 'might leave clutter', clutter wins"):
//   no file              -> restore
//   >=1 memory row       -> DO NOT restore  (the M25 invariant, preserved)
//   0 memory rows        -> restore
//   unopenable / corrupt -> rename aside, THEN restore
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type DatabaseT from 'better-sqlite3'

let dir: string
const steps: string[] = []

vi.mock('electron', () => ({
  app: { getPath: () => dir },
  ipcMain: { handle: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../memory/memory-runtime', () => ({ getMemoryDb: () => null }))
vi.mock('../telemetry/signals', async () => {
  const actual = await vi.importActual<typeof import('../telemetry/signals')>('../telemetry/signals')
  return {
    ...actual,
    signalBackupStepFailed: (p: { step: string }) => {
      steps.push(p.step)
    }
  }
})

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3') as typeof DatabaseT

const { downloadSalesBrainDb, uploadSalesBrainDb } = await import('../backup')
const { localMemoryCount } = await import('../memory/memory-count')

/** memoryDbPath builds with a FORWARD slash; match it exactly. */
const dbPathOf = (): string => `${dir}/memory.db`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'husk-guards-'))
  steps.length = 0
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeDb(rows: string[]): void {
  const db = new Database(dbPathOf())
  db.pragma('journal_mode = WAL')
  db.exec('create table memories (text TEXT)')
  for (const r of rows) db.prepare('insert into memories values (?)').run(r)
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.close()
}

function cloudWith(text: string): { bytes: Buffer; client: unknown; downloaded: () => boolean } {
  const donorDir = mkdtempSync(join(tmpdir(), 'donor-'))
  const donorPath = join(donorDir, 'd.db')
  const donor = new Database(donorPath)
  donor.exec(`create table memories (text TEXT); insert into memories values ('${text}')`)
  donor.close()
  const bytes = readFileSync(donorPath)
  rmSync(donorDir, { recursive: true, force: true })
  let was = false
  return {
    bytes,
    downloaded: () => was,
    client: {
      storage: {
        from: () => ({
          download: async () => {
            was = true
            return { data: new Blob([new Uint8Array(bytes)]), error: null }
          },
          list: async () => ({ data: [{ name: 'memory.db' }], error: null }),
          upload: async () => ({ error: null })
        })
      }
    }
  }
}

function rowsOf(path: string): string[] {
  const db = new Database(path, { readonly: true })
  try {
    return (db.prepare('select text from memories').all() as { text: string }[]).map((r) => r.text)
  } finally {
    db.close()
  }
}

describe('localMemoryCount distinguishes the three states an existence check cannot', () => {
  it('absent / populated / empty / unreadable', () => {
    expect(localMemoryCount(dbPathOf())).toEqual({ ok: false, reason: 'absent' })

    makeDb(['a', 'b'])
    expect(localMemoryCount(dbPathOf())).toEqual({ ok: true, count: 2 })

    rmSync(dbPathOf())
    makeDb([])
    expect(localMemoryCount(dbPathOf())).toEqual({ ok: true, count: 0 }) // 8192-byte husk

    rmSync(dbPathOf())
    writeFileSync(dbPathOf(), '') // the 0-byte husk
    const zero = localMemoryCount(dbPathOf())
    expect(zero.ok).toBe(false)
    if (!zero.ok) expect(zero.reason).toBe('unreadable')
  })
})

describe('BUG-092 — the restore decision table', () => {
  it('NO FILE -> restores', async () => {
    const cloud = cloudWith('from-cloud')
    await downloadSalesBrainDb(cloud.client as never, 'uid-1')
    expect(rowsOf(dbPathOf())).toEqual(['from-cloud'])
  })

  it('>=1 MEMORY ROW -> does NOT restore (the M25 invariant, preserved)', async () => {
    makeDb(['local-truth'])
    const cloud = cloudWith('from-cloud')
    await downloadSalesBrainDb(cloud.client as never, 'uid-1')
    expect(cloud.downloaded()).toBe(false) // never even fetched
    expect(rowsOf(dbPathOf())).toEqual(['local-truth'])
  })

  it('0 MEMORY ROWS -> restores over the husk', async () => {
    makeDb([]) // schema-only, 8192 bytes — the common trigger
    const cloud = cloudWith('from-cloud')
    await downloadSalesBrainDb(cloud.client as never, 'uid-1')
    expect(rowsOf(dbPathOf())).toEqual(['from-cloud'])
  })

  it('UNREADABLE -> renames aside, restores, and never destroys the original', async () => {
    writeFileSync(dbPathOf(), 'not a sqlite file at all')
    const cloud = cloudWith('from-cloud')
    await downloadSalesBrainDb(cloud.client as never, 'uid-1')

    expect(rowsOf(dbPathOf())).toEqual(['from-cloud']) // restored
    const aside = readdirSync(dir).filter((f) => f.includes('local-unreadable'))
    expect(aside, 'the unreadable file must be kept, not overwritten').toHaveLength(1)
    expect(steps).toContain('salesBrainLocalUnreadable') // and counted, not silent
  })

  it('a 0-byte husk takes the unreadable path, not the empty path', async () => {
    writeFileSync(dbPathOf(), '')
    const cloud = cloudWith('from-cloud')
    await downloadSalesBrainDb(cloud.client as never, 'uid-1')
    expect(readdirSync(dir).filter((f) => f.includes('local-unreadable'))).toHaveLength(1)
    expect(rowsOf(dbPathOf())).toEqual(['from-cloud'])
  })
})

describe('BUG-092 — the upload refusal (the irreversible half)', () => {
  it('REFUSES to upload an empty local DB over an existing cloud copy', async () => {
    makeDb([]) // zero memories
    let uploaded = false
    const client = {
      storage: {
        from: () => ({
          list: async () => ({ data: [{ name: 'memory.db' }], error: null }),
          upload: async () => {
            uploaded = true
            return { error: null }
          }
        })
      }
    }
    await uploadSalesBrainDb(client as never, 'uid-1')
    expect(uploaded, 'an empty upload over a real backup is unrecoverable').toBe(false)
    expect(steps).toContain('salesBrainUploadRefusedEmpty') // counted, not silent
  })

  it('still uploads an empty DB when the cloud has nothing to lose', async () => {
    makeDb([])
    let uploaded = false
    const client = {
      storage: {
        from: () => ({
          list: async () => ({ data: [], error: null }), // nothing up there
          upload: async () => {
            uploaded = true
            return { error: null }
          }
        })
      }
    }
    await uploadSalesBrainDb(client as never, 'uid-1')
    expect(uploaded, 'the refusal must not become a blanket block').toBe(true)
  })

  it('refuses when the cloud listing FAILS — uncertainty resolves to "do not overwrite"', async () => {
    makeDb([])
    let uploaded = false
    const client = {
      storage: {
        from: () => ({
          list: async () => {
            throw new Error('network')
          },
          upload: async () => {
            uploaded = true
            return { error: null }
          }
        })
      }
    }
    await uploadSalesBrainDb(client as never, 'uid-1')
    expect(uploaded).toBe(false)
  })

  it('a POPULATED DB uploads normally — the guard must not block real backups', async () => {
    makeDb(['real-memory'])
    let uploadedBytes: Buffer | null = null
    const client = {
      storage: {
        from: () => ({
          list: async () => ({ data: [{ name: 'memory.db' }], error: null }),
          upload: async (_p: string, data: Buffer) => {
            uploadedBytes = Buffer.from(data)
            return { error: null }
          }
        })
      }
    }
    await uploadSalesBrainDb(client as never, 'uid-1')
    expect(uploadedBytes).not.toBeNull()
    const out = join(dir, 'uploaded.db')
    writeFileSync(out, uploadedBytes!)
    expect(rowsOf(out)).toEqual(['real-memory'])
    expect(steps).not.toContain('salesBrainUploadRefusedEmpty')
  })
})
