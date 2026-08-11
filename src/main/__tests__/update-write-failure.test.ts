// BUG-024 — a write failure during an update/delete (e.g. a file briefly
// locked by antivirus/cloud sync on Windows, or a full disk) must come back
// as a distinguishable failure signal (null / {ok:false}), not silently look
// like nothing happened. This proves the main-process side of that contract;
// the renderer side (useTasks.ts/useCalendar.ts surfacing it instead of
// closing the edit dialog as if it saved) isn't covered by a Node test since
// this repo has no React-hook-testing setup — verified by reading the code.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const realAtomicWrite =
  await vi.importActual<typeof import('../atomic-write')>('../atomic-write')

vi.mock('../atomic-write', () => ({
  writeJsonAtomic: vi.fn(async () => {
    throw new Error('simulated write failure (e.g. EBUSY from antivirus/cloud-sync lock)')
  })
}))

const { createTask, updateTask, deleteTask } = await import('../tasks-fs')
const { createEvent, updateEvent, markEventDeleted } = await import('../events-fs')
const { writeJsonAtomic } = await import('../atomic-write')

/** Lets exactly the next write through to the real implementation, so a
 *  fixture can be created before the failure under test is simulated. */
function letNextWriteSucceed(): void {
  vi.mocked(writeJsonAtomic).mockImplementationOnce(realAtomicWrite.writeJsonAtomic)
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'callrise-update-fail-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('tasks-fs write failures', () => {
  it('updateTask returns null (not the stale task) when the write actually fails', async () => {
    letNextWriteSucceed()
    const task = await createTask(dir, { title: 'Call the buyer back' })

    const result = await updateTask(dir, task.id, { title: 'Edited title' })
    expect(result).toBeNull()
  })

  it('deleteTask returns {ok:false} when the write actually fails', async () => {
    letNextWriteSucceed()
    const task = await createTask(dir, { title: 'Send the proposal' })

    const result = await deleteTask(dir, task.id)
    expect(result).toEqual({ ok: false })
  })
})

describe('events-fs write failures', () => {
  it('updateEvent returns null when the write actually fails', async () => {
    letNextWriteSucceed()
    const event = await createEvent(dir, {
      title: 'Discovery call',
      start: new Date().toISOString(),
      end: new Date(Date.now() + 3_600_000).toISOString()
    })

    const result = await updateEvent(dir, event.id, { title: 'Rescheduled discovery call' })
    expect(result).toBeNull()
  })

  it('markEventDeleted returns {ok:false} when the write actually fails', async () => {
    letNextWriteSucceed()
    const event = await createEvent(dir, {
      title: 'Kickoff call',
      start: new Date().toISOString(),
      end: new Date(Date.now() + 3_600_000).toISOString()
    })

    const result = await markEventDeleted(dir, event.id)
    expect(result).toEqual({ ok: false })
  })
})
