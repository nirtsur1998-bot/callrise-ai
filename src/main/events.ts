import { app, ipcMain, BrowserWindow } from 'electron'
import { join } from 'node:path'
import {
  createEvent,
  listEvents,
  updateEvent,
  getEvent,
  setEventSync,
  markEventDeleted,
  type CalendarEvent,
  type EventCreateInput,
  type EventUpdateInput
} from './events-fs'
import {
  isAnySyncEnabled,
  pushInsertEvent,
  pushUpdateEvent,
  pushDeleteEvent,
  dropCachedEvent
} from './calendar-sync'
import { scheduleBackup } from './backup'
import { getJobManager } from './jobs/instance'
import type { Job } from './jobs/types'
import { NO_AI_PURPOSE } from './jobs/types'

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

const enqueuePush = <T>(id: string, fn: () => Promise<T>): Promise<T> =>
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
    if (!cur || cur.sync?.state === 'deleted') {
      // Defense in depth: the record vanished (deleted/tombstoned) while the
      // push was in flight. If the push CREATED an event on Google, no local
      // record references it anymore and no tombstone can ever find it —
      // best-effort delete the stray so it isn't orphaned on Google forever.
      // (A tombstone that still carries the link delivers its own delete via
      // the push queue, so the cleanup only fires when the record is gone.)
      if (!cur && res.ok) {
        void pushDeleteEvent(res.externalId, res.provider)
          .then((del) => (del.ok ? dropCachedEvent(res.externalId, res.provider) : undefined))
          .catch(() => {})
      }
      return false // a pending delete wins
    }
    if (res.ok) {
      await setEventSync(eventsDir(), id, {
        provider: res.provider,
        externalId: res.externalId,
        remoteUpdatedAt: res.remoteUpdatedAt,
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

    if (!(await isAnySyncEnabled())) {
      // Sync off: only stamp a brand-new event as local-only.
      if (!event.sync)
        await withState(id, () => setEventSync(eventsDir(), id, { sync: { state: 'local-only' } }))
      return false
    }

    if (event.sync?.state === 'deleted') {
      if (!event.externalId) {
        // Nothing to remove on Google — convert straight to a backup tombstone.
        await withState(id, () => markEventDeleted(eventsDir(), id))
        return true
      }
      const res = await pushDeleteEvent(event.externalId, event.provider)
      if (res.ok) {
        await dropCachedEvent(event.externalId, event.provider) // stop the green chip reappearing
        // Google confirmed — convert the transient Google tombstone into a
        // permanent BACKUP tombstone so the deletion propagates to the cloud.
        await withState(id, () => markEventDeleted(eventsDir(), id))
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
      // bumpUpdatedAt: the revival must carry a FRESH timestamp — the deletion
      // may already be in the cloud mirror, and its server-side newest-wins
      // would reject a revival dated the same as the tombstone (split-brain).
      await withState(id, () =>
        setEventSync(eventsDir(), id, {
          provider: event.provider,
          externalId: event.externalId,
          sync: { state: 'synced', lastError: res.error },
          bumpUpdatedAt: true
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

/** M26 Batch 5 — the reconcile drain's job type. */
const RECONCILE_JOB_TYPE = 'calendar:reconcile'

/** Queue a push for one event and refresh the calendar if the outcome changed.
 *
 *  M26 Batch 5 — DELIBERATELY NOT a job, unlike the reconcile drain below.
 *  Three reasons, all specific to this one: it takes ~0.1–2s (there is no
 *  progress to report), it already survives navigation (it has always run in
 *  main), and a failure already surfaces ON THE EVENT ITSELF in the Calendar
 *  UI via sync.state — which is a far better place for it than a generic
 *  Activity Center row. Migrating it would add one job entry per calendar
 *  edit in exchange for nothing, and would replace this per-EVENT
 *  serialization chain with a single global one, needlessly serializing
 *  unrelated events during a bulk edit. */
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
  if (reconciling || !(await isAnySyncEnabled())) return
  reconciling = true
  let changed = false
  try {
    const all = await listEvents(eventsDir(), { includeDeleted: true })
    for (const e of all) {
      const state = e.sync?.state
      // A confirmed 403 permission denial ('forbidden', from classifyPushError)
      // is TERMINAL — the calendar's access was revoked/downgraded on Google's
      // side, so retrying can never succeed until the user changes something.
      // Skip it (mirroring how syncPush special-cases the delete-path 403)
      // instead of silently retrying forever.
      if (state === 'error' && e.sync?.lastError === 'forbidden') continue
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
    scheduleBackup() // mirror to the cloud (debounced, best-effort)
    return event
  })
  ipcMain.handle('events:update', async (_e, id: string, patch: EventUpdateInput) => {
    const event = await updateEvent(eventsDir(), id, patch) // local truth first
    if (event) {
      schedulePush(id)
      scheduleBackup()
    }
    return event
  })
  ipcMain.handle('events:delete', async (_e, id: string) => {
    const event = await getEvent(eventsDir(), id)
    if (!event) return { ok: false }
    // Sync off → nothing in Google to remove; backup-tombstone now
    // (kept, not erased, so the deletion propagates to the cloud mirror).
    if (!(await isAnySyncEnabled())) {
      const res = await withState(id, () => markEventDeleted(eventsDir(), id))
      scheduleBackup()
      return res
    }
    if (!event.externalId) {
      // Not linked YET — but the create's push may still be in flight
      // (events:create fires schedulePush without awaiting it). Serialize on the
      // SAME push chain so this runs strictly after that push's recordPushResult:
      // by then the event IS linked and we tombstone-with-link (a real Google
      // delete follows), instead of erasing the link and orphaning the copy the
      // create just made on Google.
      const res = await enqueuePush(id, async (): Promise<{ ok: boolean }> => {
        const cur = await getEvent(eventsDir(), id)
        if (!cur) return { ok: false }
        if (!cur.externalId) {
          // Truly never linked — nothing in Google to remove; backup-tombstone.
          return withState(id, () => markEventDeleted(eventsDir(), id))
        }
        // Linked meanwhile: Google-tombstone, same as the linked path below.
        await withState(id, () =>
          setEventSync(eventsDir(), id, {
            provider: cur.provider,
            externalId: cur.externalId,
            sync: { state: 'deleted' },
            bumpUpdatedAt: true
          })
        )
        return { ok: true }
      })
      if (res.ok) schedulePush(id) // no-op if backup-tombstoned; pushes the Google delete if linked
      scheduleBackup()
      return res
    }
    // Linked: Google-tombstone locally (hidden from the UI immediately,
    // serialized so a late push can't overwrite it), then delete on Google via
    // the push queue; once Google confirms it becomes a backup tombstone.
    // bumpUpdatedAt: a delete IS a user action — the cloud backup's newest-wins
    // needs the fresh timestamp to accept the deletion row.
    await withState(id, () =>
      setEventSync(eventsDir(), id, {
        provider: event.provider,
        externalId: event.externalId,
        sync: { state: 'deleted' },
        bumpUpdatedAt: true
      })
    )
    schedulePush(id)
    scheduleBackup() // the deletion is visible to the backup immediately
    return { ok: true }
  })
  // Adopt a Google event: create a LOCAL event linked to it (carrying the edited
  // fields), so the change PATCHes the same Google event and the pulled copy
  // dedups away. Only meaningful when two-way sync is on.
  ipcMain.handle('events:adopt', async (_e, input: EventCreateInput) => {
    const event = await createEvent(eventsDir(), input) // linked (has externalId)
    schedulePush(event.id) // externalId present → PATCH the existing Google event
    scheduleBackup()
    return event
  })
  // Delete a Google event from the app: materialize a tombstone linked to it,
  // then push the delete (with offline retry) — reusing the linked-delete path.
  ipcMain.handle('events:deleteExternal', async (_e, link: EventCreateInput) => {
    if (!link?.externalId || !(await isAnySyncEnabled())) return { ok: false }
    const event = await createEvent(eventsDir(), link)
    await withState(event.id, () =>
      setEventSync(eventsDir(), event.id, {
        provider: event.provider,
        externalId: event.externalId,
        sync: { state: 'deleted' },
        bumpUpdatedAt: true
      })
    )
    schedulePush(event.id)
    scheduleBackup()
    return { ok: true }
  })
  // M26 Batch 5 — the reconcile drain as a MAINTENANCE job. Unlike a single
  // event push (see the note on schedulePush), this is a BATCH-shaped
  // operation: it walks every event and re-pushes each one whose earlier
  // push failed, so after a spell offline it can take a genuinely long time
  // and does real work the rep would otherwise have no way to see.
  //
  // Silent: it is self-healing retry machinery with no decision attached,
  // and a per-event failure already surfaces on the event itself in the
  // Calendar UI, which is a better place for it than a generic toast.
  //
  // reconcile()'s own `reconciling` single-flight flag still guards it, so
  // overlapping triggers collapse exactly as before.
  getJobManager().registerType<Record<string, never>, string>({
    type: RECONCILE_JOB_TYPE,
    lane: 'MAINTENANCE',
    // M27 — calendar reminders — no AI provider, so AI quota pressure must never hold it.
    aiPurpose: NO_AI_PURPOSE,
    titleFor: () => 'Catching up calendar changes',
    cancellable: false,
    silent: true,
    executor: {
      kind: 'inline-async',
      run: async () => {
        await reconcile()
        return 'Calendar caught up.'
      }
    }
  })

  ipcMain.handle('events:reconcile', () => {
    try {
      const manager = getJobManager()
      const already = manager
        .list()
        .find(
          (j: Job) =>
            j.type === RECONCILE_JOB_TYPE && (j.state === 'running' || j.state === 'queued')
        )
      if (!already) manager.enqueue(RECONCILE_JOB_TYPE, {})
    } catch (err) {
      // Never break a calendar sync because the job system refused.
      console.error('[events] could not enqueue reconcile:', err)
    }
  })
}
