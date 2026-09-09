// BUG-244 — the two DURABLE QUEUES in backup.ts carry deletions the user
// asked for, and both used to swallow their write failure entirely
// (`.catch(() => {})`). A dropped write there does not defer the deletion, it
// forgets it: the local call is already gone, so the cloud blob is orphaned
// with nothing anywhere recording that it was ever meant to go.
//
// The failure is real, not hypothetical: writeJsonAtomic's `rename` was seen
// failing with EPERM on the founder's own machine under load on 2026-09-09,
// on a real store's state file, when something outside our processes held a
// handle on it for a moment.
//
// RED-CHECKED against the pre-fix behaviour (one attempt, `.catch(() => {})`,
// no report), 2026-09-09: **5 of the 6 fail there.** The sixth — "does NOT
// retry a failure that cannot improve" — PASSES against the unfixed code,
// vacuously, because code that never retries trivially satisfies "attempted
// once". It is kept deliberately, as a guard against a future unbounded
// retry rather than as evidence for this fix, and it is called out here so
// nobody counts it among the ones that prove anything.
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dir: string
vi.mock('electron', () => ({
  app: { getPath: () => dir },
  ipcMain: { handle: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../memory/memory-runtime', () => ({ getMemoryDb: () => null }))

// A partial mock of the atomic writer: real by default, so the queue really
// lands on disk, with each test overriding the next call(s) to simulate the
// EPERM that was actually observed. The wrapper lives in its own module
// precisely so this boundary exists to mock — see durable-write.ts's header.
const realAtomic = await vi.importActual<typeof import('../atomic-write')>('../atomic-write')
vi.mock('../atomic-write', async () => {
  const actual = await vi.importActual<typeof import('../atomic-write')>('../atomic-write')
  return { ...actual, writeJsonAtomic: vi.fn(actual.writeJsonAtomic) }
})
const { writeJsonAtomic } = await import('../atomic-write')
const { writeJsonAtomicDurable } = await import('../durable-write')

/** An ErrnoException the way node actually raises one, so the helper's
 *  transient/permanent decision is exercised on `code`, not on the message. */
function errno(code: string): NodeJS.ErrnoException {
  const e = new Error(`simulated ${code}`) as NodeJS.ErrnoException
  e.code = code
  return e
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'durable-queue-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  // mockRESET, not mockClear: several tests queue an implementation on this
  // mock, and a surviving one would land in the next test (this file's own
  // instance of the hazard BUG-141's entry documents).
  vi.mocked(writeJsonAtomic).mockReset()
  vi.mocked(writeJsonAtomic).mockImplementation(realAtomic.writeJsonAtomic)
})

describe('writeJsonAtomicDurable — the transient sharing violation', () => {
  it('retries past an EPERM and the record actually lands on disk', async () => {
    const path = join(dir, 'queue.json')
    let calls = 0
    vi.mocked(writeJsonAtomic).mockImplementation(async (p, v) => {
      calls += 1
      if (calls === 1) throw errno('EPERM') // the observed failure, once
      return realAtomic.writeJsonAtomic(p, v)
    })

    const ok = await writeJsonAtomicDurable(path, { items: ['blob-1'] }, 'test queue')

    expect(ok).toBe(true)
    expect(calls).toBe(2) // it did NOT give up after the first attempt
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ items: ['blob-1'] })
  })

  it('a caller learns the request was LOST when every attempt fails', async () => {
    vi.mocked(writeJsonAtomic).mockRejectedValue(errno('EPERM'))
    const failures: { what: string; attempts: number }[] = []

    const ok = await writeJsonAtomicDurable(
      join(dir, 'queue.json'),
      { items: [] },
      'the queue of cloud blobs to delete',
      { onFailure: (what, _err, attempts) => failures.push({ what, attempts }) }
    )

    // Not "no error came back" — the caller is told, by name, that the
    // request did not survive. That is the whole difference from `.catch(() => {})`.
    expect(ok).toBe(false)
    expect(failures).toEqual([{ what: 'the queue of cloud blobs to delete', attempts: 3 }])
  })

  it('never throws into its caller, even when the write is hopeless', async () => {
    vi.mocked(writeJsonAtomic).mockRejectedValue(errno('ENOSPC'))
    await expect(
      writeJsonAtomicDurable(join(dir, 'q.json'), {}, 'test', { onFailure: () => {} })
    ).resolves.toBe(false)
  })

  it('does NOT retry a failure that cannot improve — ENOSPC is attempted once', async () => {
    let calls = 0
    vi.mocked(writeJsonAtomic).mockImplementation(async () => {
      calls += 1
      throw errno('ENOSPC')
    })
    await writeJsonAtomicDurable(join(dir, 'q.json'), {}, 'test', { onFailure: () => {} })
    // Retrying a full disk just spends the caller's time before the same
    // answer. The bound exists so this path cannot become BUG-141's stall.
    expect(calls).toBe(1)
  })

  it('is bounded — a permanently locked file costs three attempts, not an unbounded wait', async () => {
    let calls = 0
    vi.mocked(writeJsonAtomic).mockImplementation(async () => {
      calls += 1
      throw errno('EBUSY')
    })
    const t0 = Date.now()
    await writeJsonAtomicDurable(join(dir, 'q.json'), {}, 'test', { onFailure: () => {} })
    expect(calls).toBe(3)
    // 40 ms + 120 ms of backoff; the ceiling is generous so a loaded machine
    // does not fail this, but an unbounded retry would blow straight past it.
    expect(Date.now() - t0).toBeLessThan(5_000)
  })
})

describe('backup.ts queues the deletion durably', () => {
  it('a queued attachment blob delete survives a transient EPERM on the queue write', async () => {
    let writes = 0
    vi.mocked(writeJsonAtomic).mockImplementation(async (p, v) => {
      writes += 1
      if (writes === 1) throw errno('EPERM')
      return realAtomic.writeJsonAtomic(p, v)
    })

    const { queueAttachmentBlobDeletes } = await import('../backup')
    queueAttachmentBlobDeletes([{ id: 'att-1', ext: 'pdf' }])

    // queueAttachmentBlobDeletes is deliberately fire-and-forget (nobody is
    // waiting on a delete queue), so the assertion has to wait for the tail
    // rather than await a promise that is not returned.
    await vi.waitFor(
      async () => {
        const raw = await readFile(join(dir, 'backup-pending-blob-deletes.json'), 'utf8')
        expect(JSON.parse(raw)).toEqual({ items: [{ id: 'att-1', ext: 'pdf' }] })
      },
      { timeout: 5_000, interval: 25 }
    )
  })
})
