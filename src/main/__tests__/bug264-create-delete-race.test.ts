// BUG-264 — create an event, delete it within a few seconds, and (per the
// original report) the delete could read `externalId` before the create's
// push had written it back, take the "never linked" branch, and orphan a
// real copy on the provider with nothing in the app referencing it anymore.
//
// Reading events.ts (2026-09-19) found the fix direction the founder decided
// on 2026-09-10 already built: events:delete's "not linked YET" branch
// enqueues onto the SAME per-id pushChains queue schedulePush() uses, so it
// runs strictly after any in-flight create-push settles. This drives that
// real race for real: a genuinely delayed push, a delete fired while it is
// still in flight, and asserts on the actual persisted outcome rather than
// reading the code and trusting it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => testDir },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    }
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('../backup', () => ({ scheduleBackup: () => {} }))
vi.mock('../event-reminders', () => ({
  startEventReminders: () => {},
  refreshEventReminders: () => {}
}))
vi.mock('../jobs/instance', () => ({
  getJobManager: () => ({ list: () => [], enqueue: () => {}, registerType: () => {} })
}))

// The delayed push: resolves only when the test explicitly releases it, so
// the race window is real wall-clock time under test control, not a hopeful
// setTimeout(0).
let releaseInsert: (() => void) | undefined
let insertCalls = 0
const remoteDeletes: Array<{ externalId: string; provider: string }> = []

vi.mock('../calendar-sync', () => ({
  isAnySyncEnabled: async () => true,
  pushInsertEvent: async (ev: { id: string }) => {
    insertCalls++
    await new Promise<void>((resolve) => {
      releaseInsert = resolve
    })
    return {
      ok: true,
      externalId: 'remote-' + ev.id,
      provider: 'google:me@example.com',
      remoteUpdatedAt: new Date().toISOString()
    }
  },
  pushUpdateEvent: async () => ({ ok: true }),
  pushDeleteEvent: async (externalId: string, provider: string) => {
    remoteDeletes.push({ externalId, provider })
    return { ok: true }
  },
  dropCachedEvent: () => {}
}))

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
let testDir: string

async function importFreshEvents(): Promise<typeof import('../events')> {
  vi.resetModules()
  return import('../events')
}

beforeEach(async () => {
  testDir = mkdtempSync(join(tmpdir(), 'events-bug264-'))
  mkdirSync(join(testDir, 'events'), { recursive: true })
  handlers.clear()
  insertCalls = 0
  remoteDeletes.length = 0
  releaseInsert = undefined
  const { registerEvents } = await importFreshEvents()
  registerEvents()
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('create-then-delete-fast (BUG-264)', () => {
  it('deleting while the create push is still in flight never orphans the remote copy', async () => {
    const create = handlers.get('events:create')!
    const del = handlers.get('events:delete')!

    const eventPromise = create({}, {
      title: 'Quick add, quick undo',
      start: '2026-10-01T15:00:00.000Z',
      end: '2026-10-01T16:00:00.000Z',
      allDay: false
    })
    // Let create's synchronous work (createEvent + schedulePush's enqueue)
    // run, but the push itself is still awaiting `releaseInsert`. Real disk
    // I/O (createEvent's write, syncPush's re-read) is in this path, so this
    // needs real wall-clock time, not just a microtask flush.
    await new Promise((r) => setTimeout(r, 200))
    expect(insertCalls).toBe(1)
    expect(releaseInsert).toBeTruthy()

    const event = (await eventPromise) as { id: string }

    // THE RACE: delete fires now, before externalId has landed.
    const deleteResultPromise = del({}, event.id)

    // Now let the create's push resolve.
    releaseInsert!()
    await new Promise((r) => setTimeout(r, 10))

    const deleteResult = (await deleteResultPromise) as { ok: boolean }
    expect(deleteResult.ok).toBe(true)

    // THE ASSERTION THAT MATTERS: either the local record still carries the
    // link (so its own tombstone push will delete the remote copy), or a
    // remote delete already fired for it. What must NEVER be true is an
    // orphan: a remote event nothing in the app references.
    const { getEvent } = await import('../events-fs')
    const after = await getEvent(join(testDir, 'events'), event.id)

    const remoteCopyWasCreated = insertCalls === 1
    const linkedLocally = after?.externalId === 'remote-' + event.id
    const remoteDeleteFired = remoteDeletes.some((d) => d.externalId === 'remote-' + event.id)

    expect(remoteCopyWasCreated).toBe(true) // sanity: the race actually happened
    expect(linkedLocally || remoteDeleteFired).toBe(true)
  })
})
