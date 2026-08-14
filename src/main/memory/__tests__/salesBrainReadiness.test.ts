// A null getMemoryDb() used to be permanent for the rest of a session even
// with Sales Brain switched on: initSalesBrain() only ever ran once,
// automatically, at startup (raced against a 15s cap so a slow init never
// blocks login) or once more on a live settings-toggle flip. Nothing else
// ever retried it — confirmed live: a real report where waiting well past
// startup, then clicking Import again in the same session, still hit the
// exact same generic "Sales Brain is not ready yet." message.
//
// ensureMemoryDb() (memory-runtime.ts) is the fix, tested directly in
// memory-runtime-ensure.test.ts. This file covers the two USER-FACING call
// sites that now use it instead of the bare, non-retrying getMemoryDb():
// the backfill "Import now" button and the onboarding interview's answer
// submission — the second one is the more insidious pre-existing shape,
// since it used to silently skip fact-extraction with no error, no sign
// anything was wrong, while the interview's own progress still visibly
// advanced.
import { describe, expect, it, vi } from 'vitest'

describe('salesBrain:backfill:start — retries instead of a permanent dead end', () => {
  it('proceeds to enqueue when ensureMemoryDb recovers the db', async () => {
    vi.resetModules()
    let handler: ((e: unknown, opts: unknown) => Promise<unknown>) | null = null
    vi.doMock('electron', () => ({
      app: { getPath: () => '/userData' },
      ipcMain: {
        handle: (ch: string, fn: (e: unknown, opts: unknown) => Promise<unknown>) => {
          if (ch === 'salesBrain:backfill:start') handler = fn
        }
      }
    }))
    vi.doMock('../../app-settings', () => ({ isSalesBrainEnabled: () => true }))
    const ensureMemoryDb = vi.fn(async () => ({ db: {}, detail: 'already ready' }))
    vi.doMock('../memory-runtime', () => ({ ensureMemoryDb, getMemoryDb: () => ({}) }))
    vi.doMock('../../jobs/instance', () => ({
      getJobManager: () => ({ list: () => [], enqueue: () => ({ id: 'job-1' }), registerType: () => {} })
    }))
    vi.doMock('../backfill', () => ({ runBackfill: vi.fn() }))

    const { registerBackfill } = await import('../backfill-ipc')
    registerBackfill()
    const result = await handler!({}, {})

    expect(ensureMemoryDb).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ ok: true, jobId: 'job-1' })
  })

  it('surfaces the REAL failure reason — not the old generic "not ready yet" — when the retry still fails', async () => {
    vi.resetModules()
    let handler: ((e: unknown, opts: unknown) => Promise<unknown>) | null = null
    vi.doMock('electron', () => ({
      app: { getPath: () => '/userData' },
      ipcMain: {
        handle: (ch: string, fn: (e: unknown, opts: unknown) => Promise<unknown>) => {
          if (ch === 'salesBrain:backfill:start') handler = fn
        }
      }
    }))
    vi.doMock('../../app-settings', () => ({ isSalesBrainEnabled: () => true }))
    vi.doMock('../memory-runtime', () => ({
      ensureMemoryDb: async () => ({ db: null, detail: 'migration failed: {"error":"disk full"}' }),
      getMemoryDb: () => null
    }))
    vi.doMock('../../jobs/instance', () => ({
      getJobManager: () => ({ list: () => [], enqueue: () => ({ id: 'job-1' }), registerType: () => {} })
    }))
    vi.doMock('../backfill', () => ({ runBackfill: vi.fn() }))

    const { registerBackfill } = await import('../backfill-ipc')
    registerBackfill()
    const result = (await handler!({}, {})) as { ok: boolean; message?: string }

    expect(result.ok).toBe(false)
    expect(result.message).toContain('disk full')
    expect(result.message).not.toBe('Sales Brain is not ready yet.')
  })
})

describe('salesBrain:onboarding:submitAnswer — retries instead of silently skipping extraction', () => {
  // `electron` is deliberately NOT mocked here — each test below mocks it
  // itself with a real handler-capturing map, since that's the actual thing
  // each test needs to drive.
  function mockCommon(ensureMemoryDb: () => Promise<{ db: unknown; detail: string }>): void {
    vi.doMock('node:fs', () => ({
      promises: {
        readFile: async () => {
          throw new Error('ENOENT')
        },
        mkdir: async () => {}
      }
    }))
    vi.doMock('../../atomic-write', () => ({ writeJsonAtomic: vi.fn(async () => {}) }))
    vi.doMock('../../app-settings', () => ({ isSalesBrainEnabled: () => true }))
    vi.doMock('../memory-runtime', () => ({ ensureMemoryDb }))
    vi.doMock('../onboarding', () => ({
      ONBOARDING_TOPICS: [{ id: 'pricing', question: 'How do you price?', categories: ['rep-pattern'] }],
      extractOnboardingFacts: vi.fn(async () => [{ statement: 'fact' }]),
      topicById: (id: string) => (id === 'pricing' ? { id: 'pricing', question: 'How do you price?' } : undefined)
    }))
  }

  it('actually extracts and consolidates when ensureMemoryDb recovers the db mid-interview', async () => {
    vi.resetModules()
    const fakeDb = {}
    const consolidateNewCandidate = vi.fn(async () => 'created')
    mockCommon(async () => ({ db: fakeDb, detail: 'already ready' }))
    vi.doMock('../consolidation', () => ({ consolidateNewCandidate }))

    const registeredHandlers = new Map<string, (...args: unknown[]) => unknown>()
    vi.doMock('electron', () => ({
      app: { getPath: () => '/userData' },
      ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => registeredHandlers.set(ch, fn) }
    }))

    const { registerOnboarding } = await import('../onboarding-ipc')
    registerOnboarding()
    const submit = registeredHandlers.get('salesBrain:onboarding:submitAnswer')!
    await submit({}, 'pricing', 'value-based, always')

    expect(consolidateNewCandidate).toHaveBeenCalledTimes(1)
    expect(consolidateNewCandidate).toHaveBeenCalledWith(fakeDb, { statement: 'fact' })
  })

  it('still skips extraction (no throw) — the pre-existing safe fallback — when the retry still fails', async () => {
    vi.resetModules()
    const consolidateNewCandidate = vi.fn(async () => 'created')
    mockCommon(async () => ({ db: null, detail: 'migration failed: disk full' }))
    vi.doMock('../consolidation', () => ({ consolidateNewCandidate }))

    const registeredHandlers = new Map<string, (...args: unknown[]) => unknown>()
    vi.doMock('electron', () => ({
      app: { getPath: () => '/userData' },
      ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => registeredHandlers.set(ch, fn) }
    }))

    const { registerOnboarding } = await import('../onboarding-ipc')
    registerOnboarding()
    const submit = registeredHandlers.get('salesBrain:onboarding:submitAnswer')!
    const result = await submit({}, 'pricing', 'value-based, always')

    expect(consolidateNewCandidate).not.toHaveBeenCalled()
    expect(result).toBeDefined() // still resolves (progress state), never throws into the renderer
  })
})
