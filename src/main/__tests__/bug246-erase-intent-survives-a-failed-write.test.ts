// BUG-246 — the erase intent behind BUG-206's fix was written with every
// failure swallowed.
//
// BUG-206 made "Forget everything" record an EVENT ("the user asked for this")
// rather than letting a later restore infer intent from a STATE ("the store is
// empty"). The place that event is recorded is `backup-pending-scrubs.json`.
// It was written like this:
//
//   await writeJsonAtomic(pendingScrubsPath(), { keys }).catch(() => {})
//   void (async () => { ... })()          // and nobody could await it either
//
// Two independent swallows on one privacy path. BUG-244 then measured
// `writeJsonAtomic`'s rename failing with EPERM on this very machine under
// contention — so the failure is not hypothetical. When it happens:
//
//   1. the erase intent is never recorded;
//   2. drainPendingScrubs has nothing to drain, so the cloud copy survives;
//   3. downloadSalesBrainDb's BUG-206 guard reads an empty queue and RESTORES
//      the data the user just erased — under a dialog reading "This cannot be
//      undone."
//
// The first test is the load-bearing one: with the queue file impossible to
// write, the restore must STILL be refused.
import { mkdtempSync, rmSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dir: string
vi.mock('electron', () => ({
  app: { getPath: () => dir, getVersion: () => '0.0.0-test', on: vi.fn(), whenReady: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../memory/memory-runtime', () => ({ getMemoryDb: () => null }))
// registerBackup() registers a job type, and the real JobManager is created by
// main/index.ts. Stubbed so the LISTENER WIRING under test is the real one
// rather than something this file re-creates — the wiring is exactly what
// BUG-206 got wrong, so the test must not supply its own.
vi.mock('../jobs/instance', () => ({
  getJobManager: () => ({
    registerType: vi.fn(),
    register: vi.fn(),
    enqueue: vi.fn(() => 'job-1'),
    list: () => []
  }),
  setJobManager: vi.fn()
}))

const { downloadSalesBrainDb, registerBackup, resetPendingScrubMemoryForTests } =
  await import('../backup')
const { notifySalesBrainErased } = await import('../app-settings')
const { writeJsonAtomicDurable } = await import('../atomic-write')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bug246-'))
  // The erase listener is wired in registerBackup(), not at module scope. The
  // first draft of this test skipped it and failed for that reason rather than
  // for the reason it names — worth the line of comment: a test that fails
  // for the wrong reason is one step from a test that PASSES for the wrong
  // reason. registerBackup() is idempotent, so calling it per-test is safe.
  registerBackup()
  // The in-memory queue is module state and only a successful write clears it,
  // so without this the erase queued by one case silently refuses the next
  // case's restore — and the CONTROL below would pass for the wrong reason.
  resetPendingScrubMemoryForTests()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A Supabase-shaped stub that records whether a restore was even attempted.
 *  Asserting on the ATTEMPT, not on a return value: "did not restore" is the
 *  claim, and a function that returns void can satisfy it either way. */
function clientSpy(): { client: unknown; downloads: () => number } {
  let downloads = 0
  const client = {
    storage: {
      from: () => ({
        download: async () => {
          downloads++
          return { data: null, error: { message: 'not found' } }
        },
        remove: async () => ({ error: null }),
        upload: async () => ({ error: null })
      })
    },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) })
    })
  }
  return { client, downloads: () => downloads }
}

/** Make the queue file impossible to write by putting a DIRECTORY in its
 *  place: the atomic rename onto it fails the way a held handle does. */
function blockTheQueueFile(): void {
  mkdirSync(join(dir, 'backup-pending-scrubs.json'))
}

describe('BUG-246 — an erase that cannot be written down is still an erase', () => {
  it('refuses the restore even when the queue file cannot be written', async () => {
    blockTheQueueFile()

    // The user presses "Forget everything". This is the real listener chain:
    // memory-center-ipc calls notifySalesBrainErased, app-settings fans it out,
    // backup.ts queues the salesBrain scrub.
    notifySalesBrainErased()
    await vi.waitFor(async () => {
      // The write genuinely failed — otherwise this test proves nothing.
      expect(existsSync(join(dir, 'backup-pending-scrubs.json'))).toBe(true)
    })
    // Let the fire-and-forget queue write finish failing.
    await new Promise((r) => setTimeout(r, 600))

    const spy = clientSpy()
    await downloadSalesBrainDb(spy.client as never, 'user-1')

    // RED-CHECK: drop the in-memory half of readPendingScrubs and this goes to
    // 1 — the restore runs and the erased brain comes back.
    expect(
      spy.downloads(),
      'the restore must be refused: the user erased the brain, and a failed queue write is not consent to bring it back'
    ).toBe(0)
  })

  it('restores normally when no erase was ever requested', async () => {
    // The control that makes the test above mean something. Without it, a
    // guard that refuses EVERY restore would pass the first test.
    const spy = clientSpy()
    await downloadSalesBrainDb(spy.client as never, 'user-1')
    expect(spy.downloads(), 'a restore with no queued erase must still happen').toBe(1)
  })
})

describe('BUG-246 — writeJsonAtomicDurable retries contention, and only contention', () => {
  it('gives up in bounded time rather than waiting forever', async () => {
    // ENOENT (a missing parent) is in the retryable set — BUG-244 saw the temp
    // file vanish under it — so this exercises the full retry ladder.
    const started = Date.now()
    await expect(
      writeJsonAtomicDurable(join(dir, 'no', 'such', 'dir', 'x.json'), { a: 1 })
    ).rejects.toThrow()
    const elapsed = Date.now() - started

    // The bound is the point: an unbounded retry would manufacture exactly the
    // stall BUG-141 is about. 25+50+100+200 = 375ms of sleeping, plus the five
    // attempts themselves.
    expect(elapsed).toBeGreaterThanOrEqual(375)
    expect(elapsed).toBeLessThan(5_000)
  })

  it('writes normally when nothing is contending', async () => {
    const path = join(dir, 'fine.json')
    await writeJsonAtomicDurable(path, { keys: ['salesBrain'] })
    expect(existsSync(path)).toBe(true)
  })
})

describe('BUG-246 — the test-only reset stays test-only', () => {
  it('is called by no shipping source file', () => {
    // A reset that production could reach would be a way to forget an erase.
    // Pinned here rather than trusted: same rule as the import-graph test on
    // the consent switches.
    const src = join(__dirname, '..')
    const offenders: string[] = []
    const walk = (d: string): void => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue
        const full = join(d, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.ts') && entry.name !== 'backup.ts') {
          if (readFileSync(full, 'utf8').includes('resetPendingScrubMemoryForTests')) {
            offenders.push(full)
          }
        }
      }
    }
    walk(src)
    expect(offenders, 'a shipping file reaches the test-only scrub reset').toEqual([])
  })
})
