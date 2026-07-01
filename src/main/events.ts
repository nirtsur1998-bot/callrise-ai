import { app, ipcMain, BrowserWindow } from 'electron'
import { join } from 'node:path'
import {
  createEvent,
  listEvents,
  updateEvent,
  deleteEvent,
  getEvent,
  setEventSync,
  type CalendarEvent,
  type EventCreateInput,
  type EventUpdateInput
} from './events-fs'
import {
  isGoogleSyncEnabled,
  pushInsertEvent,
  pushUpdateEvent,
  pushDeleteEvent,
  dropCachedEvent
} from './google'

function eventsDir(): string {
  return join(app.getPath('userData'), 'events')
}

/** Tell every window the events on disk changed, so the calendar re-reads. Used
 *  after a background push stamps the Google link, so the pulled copy dedups. */
function notifyEventsChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('events:changed')
  }
}

// --- Per-event serialization ------------------------------------------------
// Concurrency on the SAME event (a rapid double-edit, an edit racing a delete,
// or reconcile() racing a user action) must not reorder at Google or clobber a
// tombstone. Two independent per-id chains keep it correct WITHOUT ever blocking
// the UI on a slow network call:
//   • pushChains — serializes the network pushes so only one is in flight per
//     event, and each one re-reads the current on-disk state (never a stale
//     snapshot), so the latest edit always wins.
//   • stateLocks — serializes the fast on-disk sync-state writes so a delete's
//     tombstone and a late push's 'synced' write can't interleave (resurrection).
const pushChains = new Map<string, Promise<unknown>>()
const stateLocks = new Map<string, Promise<unknown>>()

function serialize<T>(
  map: Map<string, Promise<unknown>>,
  id: string,
  fn: () => Promise<T>
): Promise<T> {
  const prev = map.get(id) ?? Promise.resolve()
  const result = prev.then(fn, fn) // run after prev settles, regardless of its outcome
  const gate = result.then(
    () => {},
    () => {}
  )
  map.set(id, gate)
  void gate.finally(() => {
    if (map.get(id) === gate) map.delete(id) // drop only if we're still the tail
  })
  return result
}

const enqueuePush = (id: string, fn: () => Promise<boolean>): Promise<boolean> =>
  serialize(pushChains, id, fn)
const withState = <T>(id: string, fn: () => Promise<T>): Promise<T> => serialize(stateLocks, id, fn)

/** Record a create/update push result. Serialized on the state lock and guarded
 *  so it can NEVER overwrite a tombstone a concurrent delete just wrote. */
async function recordPushResult(
  id: string,
  res: Awaited<ReturnType<typeof pushInsertEvent>>
): Promise<boolean> {
  return withState(id, async () => {
    const cur = await getEvent(eventsDir(), id)
    if (!cur || cur.sync?.state === 'deleted') return false // a pending delete wins
    if (res.ok) {
      await setEventSync(eventsDir(), id, {
        provider: res.provider,
        externalId: res.externalId,
        googleUpdatedAt: res.googleUpdatedAt,
        sync: { state: 'synced', lastPushedAt: new Date().toISOString() }
      })
    } else {
      await setEventSync(eventsDir(), id, {
        sync: { state: res.retryable ? 'dirty' : 'error', lastError: res.error }
      })
    }
    return res.ok
  })
}

/**
 * Make Google reflect this event's CURRENT on-disk state (best-effort). Re-reads
 * the event each time so a queued push always sends the latest edit. Returns
 * true if the sync outcome changed (so the caller can refresh the calendar).
 * Never throws.
 */
async function syncPush(id: string): Promise<boolean> {
  try {
    const event = await getEvent(eventsDir(), id)
    if (!event) return false

    if (!(await isGoogleSyncEnabled())) {
      // Sync off: only stamp a brand-new event as local-only.
      if (!event.sync)
        await withState(id, () => setEventSync(eventsDir(), id, { sync: { state: 'local-only' } }))
      return false
    }

    if (event.sync?.state === 'deleted') {
      if (!event.externalId) {
        await withState(id, () => deleteEvent(eventsDir(), id))
        return true
      }
      const res = await pushDeleteEvent(event.externalId, event.provider)
      if (res.ok) {
        await dropCachedEvent(event.externalId, event.provider) // stop the green chip reappearing
        await withState(id, () => deleteEvent(eventsDir(), id)) // remove the tombstone file
        return true
      }
      if (res.retryable) {
        // Transient (offline / 5xx): keep the tombstone; reconcile() retries later.
        await withState(id, () =>
          setEventSync(eventsDir(), id, {
            externalId: event.externalId,
            sync: { state: 'deleted', lastError: res.error }
          })
        )
        return false
      }
      // Non-retryable (e.g. a 403 permission denial): we can't delete it on
      // Google. Don't discard the local record — a far-future event outside the
      // pull window wouldn't come back and would silently vanish. Un-tombstone it
      // (back to synced) so it stays visible and the app matches Google; the user
      // can retry. reconcile() skips 'synced', so no retry storm.
      await withState(id, () =>
        setEventSync(eventsDir(), id, {
          provider: event.provider,
          externalId: event.externalId,
          sync: { state: 'synced', lastError: res.error }
        })
      )
      return true
    }

    // Linked → PATCH; never linked → create + link (also adopts events made
    // while sync was off, once they're next created/edited).
    const res = event.externalId ? await pushUpdateEvent(event) : await pushInsertEvent(event)
    return recordPushResult(id, res)
  } catch {
    return false // best-effort: a mirror failure never breaks the local store
  }
}

/** Queue a push for one event and refresh the calendar if the outcome changed. */
function schedulePush(id: string): void {
  void enqueuePush(id, () => syncPush(id)).then((changed) => {
    if (changed) notifyEventsChanged()
  })
}

// Drains events whose push failed earlier (offline/transient) or whose delete is
// still pending. Runs after a successful pull. Single-flight; each push is
// serialized with any concurrent user action on the same event.
let reconciling = false
async function reconcile(): Promise<void> {
  if (reconciling || !(await isGoogleSyncEnabled())) return
  reconciling = true
  let changed = false
  try {
    const all = await listEvents(eventsDir(), { includeDeleted: true })
    for (const e of all) {
      const state = e.sync?.state
      if (state === 'deleted' || state === 'dirty' || state === 'error') {
        if (await enqueuePush(e.id, () => syncPush(e.id))) changed = true
      }
    }
  } finally {
    reconciling = false
  }
  if (changed) notifyEventsChanged()
}

let registered = false

export function registerEvents(): void {
  if (registered) return
  registered = true

  ipcMain.handle('events:list', (): Promise<CalendarEvent[]> => listEvents(eventsDir()))
  ipcMain.handle('events:create', async (_e, input: EventCreateInput) => {
    const event = await createEvent(eventsDir(), input) // local truth first — always succeeds
    schedulePush(event.id) // fire-and-forget: offline/errors never block the local create
    return event
  })
  ipcMain.handle('events:update', async (_e, id: string, patch: EventUpdateInput) => {
    const event = await updateEvent(eventsDir(), id, patch) // local truth first
    if (event) schedulePush(id)
    return event
  })
  ipcMain.handle('events:delete', async (_e, id: string) => {
    const event = await getEvent(eventsDir(), id)
    if (!event) return { ok: false }
    // Unlinked, or sync off → nothing in Google to remove; hard-delete now.
    if (!event.externalId || !(await isGoogleSyncEnabled())) {
      return deleteEvent(eventsDir(), id)
    }
    // Linked: tombstone locally (hidden from the UI immediately, serialized so a
    // late push can't overwrite it), then delete on Google via the push queue.
    // The file is removed for real only once Google confirms.
    await withState(id, () =>
      setEventSync(eventsDir(), id, {
        provider: event.provider,
        externalId: event.externalId,
        sync: { state: 'deleted' }
      })
    )
    schedulePush(id)
    return { ok: true }
  })
  // Adopt a Google event: create a LOCAL event linked to it (carrying the edited
  // fields), so the change PATCHes the same Google event and the pulled copy
  // dedups away. Only meaningful when two-way sync is on.
  ipcMain.handle('events:adopt', async (_e, input: EventCreateInput) => {
    const event = await createEvent(eventsDir(), input) // linked (has externalId)
    schedulePush(event.id) // externalId present → PATCH the existing Google event
    return event
  })
  // Delete a Google event from the app: materialize a tombstone linked to it,
  // then push the delete (with offline retry) — reusing the linked-delete path.
  ipcMain.handle('events:deleteExternal', async (_e, link: EventCreateInput) => {
    if (!link?.externalId || !(await isGoogleSyncEnabled())) return { ok: false }
    const event = await createEvent(eventsDir(), link)
    await withState(event.id, () =>
      setEventSync(eventsDir(), event.id, {
        provider: event.provider,
        externalId: event.externalId,
        sync: { state: 'deleted' }
      })
    )
    schedulePush(event.id)
    return { ok: true }
  })
  ipcMain.handle('events:reconcile', () => reconcile())
}
