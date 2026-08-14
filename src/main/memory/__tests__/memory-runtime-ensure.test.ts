// A null getMemoryDb() used to be permanent for the rest of a session even
// with Sales Brain switched on — initSalesBrain() only ever ran once,
// automatically, at startup or on a live toggle-flip, and nothing else ever
// retried it. ensureMemoryDb() is the fix: it retries once, on demand, and
// surfaces the real failure reason instead of a dead end. Same mocking
// pattern as memory-runtime-nightly.test.ts (mocks ../db so success/failure
// is controllable per test), extended to also control openMemoryDb so a
// dedupe test can prove only one real init attempt ever happens.
import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { MigrateResult } from '../db'

vi.mock('electron', () => ({ app: { getPath: () => '/fake/userData' } }))

const enabled = { current: true }
vi.mock('../../app-settings', () => ({ isSalesBrainEnabled: () => enabled.current }))

const fakeDb = { fake: true }
const openMemoryDb = vi.fn(() => fakeDb)
const migrate = vi.fn<() => Promise<MigrateResult>>(async () => ({
  ok: true,
  migrated: false,
  fromVersion: 1,
  toVersion: 1
}))
vi.mock('../db', () => ({
  memoryDbPath: () => '/fake/userData/memory.db',
  openMemoryDb: () => openMemoryDb(),
  migrate: () => migrate()
}))
vi.mock('../embeddings', () => ({
  configureEmbeddingsCacheDir: () => {},
  warmUpEmbeddings: async () => {}
}))
vi.mock('../nightly-consolidation-job', () => ({
  registerWarmUpEmbeddingsJob: () => {},
  enqueueWarmUpEmbeddings: () => {}
}))

const { ensureMemoryDb, getMemoryDb, __resetForTests } = await import('../memory-runtime')

beforeEach(() => {
  enabled.current = true
  openMemoryDb.mockClear()
  migrate.mockClear()
  migrate.mockResolvedValue({ ok: true, migrated: false, fromVersion: 1, toVersion: 1 })
  __resetForTests()
})

describe('ensureMemoryDb', () => {
  it('returns the db immediately, with no re-init, once already ready', async () => {
    await ensureMemoryDb()
    openMemoryDb.mockClear()

    const { db, detail } = await ensureMemoryDb()

    expect(db).toBe(fakeDb)
    expect(detail).toBe('already ready')
    expect(openMemoryDb).not.toHaveBeenCalled()
  })

  it('returns null/"disabled" without attempting init when Sales Brain is off', async () => {
    enabled.current = false

    const { db, detail } = await ensureMemoryDb()

    expect(db).toBeNull()
    expect(detail).toBe('disabled')
    expect(openMemoryDb).not.toHaveBeenCalled()
  })

  it('this is the actual fix: a never-initialized db is retried, not treated as a permanent dead end', async () => {
    // db starts null (__resetForTests) — the OLD getMemoryDb() would just
    // return null forever from here. ensureMemoryDb must attempt init itself.
    const { db } = await ensureMemoryDb()

    expect(db).toBe(fakeDb)
    expect(openMemoryDb).toHaveBeenCalledTimes(1)
    expect(getMemoryDb()).toBe(fakeDb) // module state genuinely updated, not just the return value
  })

  it('surfaces the REAL failure reason, not a generic message, when the retry itself fails', async () => {
    migrate.mockResolvedValue({
      ok: false,
      reason: 'migration-failed',
      fileVersion: 1,
      targetVersion: 2,
      error: 'disk full'
    })

    const { db, detail } = await ensureMemoryDb()

    expect(db).toBeNull()
    expect(detail).toContain('migration failed')
    expect(detail).toContain('disk full')
  })

  it('a LATER call gets a fresh attempt after a failed one — recovers without a restart', async () => {
    migrate.mockResolvedValueOnce({
      ok: false,
      reason: 'migration-failed',
      fileVersion: 1,
      targetVersion: 2,
      error: 'transient hiccup'
    })
    const first = await ensureMemoryDb()
    expect(first.db).toBeNull()

    migrate.mockResolvedValueOnce({ ok: true, migrated: false, fromVersion: 1, toVersion: 1 })
    const second = await ensureMemoryDb()
    expect(second.db).toBe(fakeDb)
  })

  it('de-duplicates concurrent callers onto the SAME attempt — two clicks do not race two migrations', async () => {
    const [a, b] = await Promise.all([ensureMemoryDb(), ensureMemoryDb()])

    expect(a.db).toBe(fakeDb)
    expect(b.db).toBe(fakeDb)
    expect(openMemoryDb).toHaveBeenCalledTimes(1)
  })

  // The 1.2.1 regression, directly. openMemoryDb() (better-sqlite3's
  // Database constructor) can throw synchronously on a native-module load
  // failure — index.ts's startup call has always wrapped it in try/catch for
  // exactly that reason. The first version of ensureMemoryDb did not, so on a
  // machine where init genuinely throws, the rejection propagated out of the
  // IPC handler and the renderer (which reads a result object, not a
  // rejection) showed the user NOTHING — the Import button silently did
  // nothing at all.
  describe('an init that THROWS must resolve, never reject — a rejection reaches the user as silence', () => {
    it('resolves with db:null and the real error text instead of rejecting', async () => {
      openMemoryDb.mockImplementationOnce(() => {
        throw new Error('was compiled against a different Node.js version')
      })

      const result = await ensureMemoryDb()

      expect(result.db).toBeNull()
      expect(result.detail).toContain('init threw')
      expect(result.detail).toContain('different Node.js version')
    })

    it('does not poison later attempts — a throw clears the shared in-flight promise', async () => {
      openMemoryDb.mockImplementationOnce(() => {
        throw new Error('transient native load failure')
      })
      const first = await ensureMemoryDb()
      expect(first.db).toBeNull()

      const second = await ensureMemoryDb()
      expect(second.db).toBe(fakeDb)
    })

    it('concurrent callers all resolve (never reject) when the shared attempt throws', async () => {
      openMemoryDb.mockImplementationOnce(() => {
        throw new Error('boom')
      })

      // Promise.all rejects if ANY of them rejected — this is the assertion.
      const [a, b] = await Promise.all([ensureMemoryDb(), ensureMemoryDb()])

      expect(a.db).toBeNull()
      expect(b.db).toBeNull()
    })
  })
})
