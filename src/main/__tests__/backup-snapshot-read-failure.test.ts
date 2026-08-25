// M29 sweep finding H5 — a failed READ of the Sales Brain snapshot must be
// COUNTED, not silently swallowed.
//
// Before the fix the catch was a bare `return`: no log line, no signal, no
// state write. And because it returns rather than throws, `pushAll` fell
// through to `writeState({ lastPushError: undefined })` and reported a clean
// backup — so the card said "Backed up just now" forever while the Sales Brain
// had never been uploaded. That is BUG-087's exact shape (a swallowed error
// hiding a total backup failure) reintroduced inside BUG-088's own fix, and it
// made backup.ts's header claim — "EVERY best-effort sub-step failure also
// counts" — false.
//
// This lives in its own file because it needs a MODULE-LEVEL mock of
// node:fs/promises. vi.spyOn cannot redefine an ESM export ("Cannot redefine
// property: readFile"), so the failure is injected at the module boundary
// instead — a real rejection from the real call site, not a stubbed unit.
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type DatabaseT from 'better-sqlite3'

let dir: string
/** When set, a readFile of exactly this path rejects — the AV-scanner shape. */
let failReadOf: string | null = null
const steps: string[] = []

vi.mock('electron', () => ({
  app: { getPath: () => dir },
  ipcMain: { handle: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../memory/memory-runtime', () => ({ getMemoryDb: () => null }))

// The signal is the thing under test: record every step name it is told about.
vi.mock('../telemetry/signals', async () => {
  const actual = await vi.importActual<typeof import('../telemetry/signals')>('../telemetry/signals')
  return {
    ...actual,
    signalBackupStepFailed: (props: { step: string }) => {
      steps.push(props.step)
    }
  }
})

// NOTE the module: backup.ts does `import { promises as fs } from 'node:fs'`,
// NOT from 'node:fs/promises'. Mocking the latter looked right and intercepted
// nothing — the control below passed while the real test failed, which is
// exactly how a wrong-door mock announces itself (taxonomy species 21).
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    default: actual,
    promises: {
      ...actual.promises,
      readFile: async (p: unknown, ...rest: unknown[]) => {
        if (failReadOf && String(p) === failReadOf) {
          throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
        }
        return (actual.promises.readFile as (...a: unknown[]) => Promise<Buffer>)(p, ...rest)
      }
    }
  }
})

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3') as typeof DatabaseT

const { uploadSalesBrainDb } = await import('../backup')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sb-readfail-'))
  failReadOf = null
  steps.length = 0
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeDb(): DatabaseT.Database {
  const db = new Database(join(dir, 'memory.db'))
  db.pragma('journal_mode = WAL')
  db.exec("create table memories (text TEXT); insert into memories values ('x')")
  return db
}

describe('H5 — the snapshot read failure is counted and uploads nothing', () => {
  it('CONTROL: with the read working, the upload happens and no step is counted', async () => {
    const db = makeDb()
    try {
      let uploaded = false
      const client = {
        storage: {
          from: () => ({
            upload: async () => {
              uploaded = true
              return { error: null }
            }
          })
        }
      }
      await uploadSalesBrainDb(client as never, 'uid-1')
      expect(uploaded).toBe(true)
      expect(steps).toEqual([]) // nothing failed, nothing counted
    } finally {
      db.close()
    }
  })

  it('a failed snapshot read counts salesBrainSnapshotRead and uploads NOTHING', async () => {
    const db = makeDb()
    try {
      // memoryDbPath builds with a FORWARD slash (`${userDataDir}/memory.db`),
      // so on Windows the real path is mixed-separator. Building it with
      // path.join here produced a backslash and the exact-match never fired —
      // the mock intercepted nothing and the upload sailed through. Construct
      // it exactly the way the code under test does.
      const snapshotPath = `${dir}/memory.db.upload-snapshot`
      failReadOf = snapshotPath

      let uploaded = false
      const client = {
        storage: {
          from: () => ({
            upload: async () => {
              uploaded = true
              return { error: null }
            }
          })
        }
      }
      await uploadSalesBrainDb(client as never, 'uid-1')

      // The behaviour half: a possibly-stale read is never a fallback.
      expect(uploaded).toBe(false)
      // The counting half — the part that was missing. Paired with the
      // behaviour assertion above so a regression in either direction is red.
      expect(steps).toContain('salesBrainSnapshotRead')
      // The finally still cleans up, so no residue disables better-sqlite3's
      // own crash-cleanup on later runs.
      expect(existsSync(snapshotPath)).toBe(false)
    } finally {
      db.close()
    }
  })
})
