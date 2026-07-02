// Per-user cloud MIRROR (M16). Local files stay the source of truth; this pushes
// a copy of the user's own data to Supabase so it can be restored on a new
// machine. Best-effort: a push never blocks or breaks local work.
//
// v1 syncs TASKS and local CALENDAR EVENTS only. Buyer transcripts, attachment
// files, and calls are deliberately NOT synced yet (calls arrive in a later
// step; transcripts never leave the device in v1).
//
// The push is a FULL upsert of every record each time — simple and inherently
// crash-safe (no watermark that could skip a record). Idempotency + "newest
// wins" are enforced by the DB (primary key (user_id, id) + the server-side
// trigger), so re-pushing an unchanged or older record is a harmless no-op.
import { app, ipcMain, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import { getSupabaseClient, getSignedInUserId } from './auth'
import { listTasks, importTask, type Task } from './tasks-fs'
import { listEvents, importEvent, type CalendarEvent } from './events-fs'
import { reconcileStore, type CloudRow } from './backup-core'

function tasksDir(): string {
  return join(app.getPath('userData'), 'tasks')
}
function eventsDir(): string {
  return join(app.getPath('userData'), 'events')
}
function statePath(): string {
  return join(app.getPath('userData'), 'backup-state.json')
}
function ownerPath(): string {
  return join(app.getPath('userData'), 'backup-owner.json')
}

// This device's local data belongs to exactly ONE account (the app is
// single-user per machine). We pin that owner the first time an account signs
// in, and REFUSE to back up when a different account is signed in — otherwise a
// shared machine could upload account A's leftover local files into account B's
// cloud (RLS can't catch it: the rows would be legitimately stamped as B).
// Clearing/reassigning this belongs to a later "reset this device" feature.
async function readOwner(): Promise<string | null> {
  try {
    const v = JSON.parse(await fs.readFile(ownerPath(), 'utf8')) as { userId?: unknown }
    return typeof v.userId === 'string' && v.userId ? v.userId : null
  } catch {
    return null
  }
}
/**
 * Pin this device's data to `userId` if no owner is set yet. Uses an EXCLUSIVE
 * create ('wx'), so if two accounts ever race to claim a fresh machine the FIRST
 * writer wins atomically and later claims get EEXIST and leave the winner intact
 * — the "pin to first account" invariant is race-proof, never a lost/torn claim.
 */
async function claimOwnershipIfUnset(userId: string): Promise<void> {
  try {
    await fs.writeFile(ownerPath(), JSON.stringify({ userId }), { encoding: 'utf8', flag: 'wx' })
  } catch {
    /* already owned (EEXIST) or unwritable — leave any existing owner untouched */
  }
}

export interface BackupState {
  lastPushAt?: string
  /** When the last successful FULL sync (pull + push) finished. Also the cursor
   *  for concurrent-edit detection: a local record edited after this AND
   *  superseded by a newer cloud version gets a .conflict copy. */
  lastSyncAt?: string
  lastError?: string
  lastErrorAt?: string
}

async function readState(): Promise<BackupState> {
  try {
    return JSON.parse(await fs.readFile(statePath(), 'utf8')) as BackupState
  } catch {
    return {}
  }
}
async function writeState(patch: BackupState): Promise<void> {
  const next = { ...(await readState()), ...patch }
  await fs.writeFile(statePath(), JSON.stringify(next), 'utf8').catch(() => {})
}

/** Strip the machine-specific Google-link fields: a backed-up event is a clean
 *  local event; Google re-linking happens naturally on that machine's own sync
 *  (v1 decision — sidesteps the setEventSync cursor gap on restore). */
function eventPayload(e: CalendarEvent): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...e }
  delete payload.provider
  delete payload.externalId
  delete payload.sync
  delete payload.googleUpdatedAt
  return payload
}

interface BackupRow {
  id: string
  user_id: string
  updated_at: string
  deleted: boolean
  payload: unknown
}

const CHUNK = 200

async function upsertRows(
  client: ReturnType<typeof getSupabaseClient>,
  table: string,
  rows: BackupRow[]
): Promise<void> {
  if (!client) return
  for (let i = 0; i < rows.length; i += CHUNK) {
    // The client carries the user's JWT → RLS applies; on conflict, the DB
    // trigger keeps whichever row is newest (server-decided).
    const { error } = await client.from(table).upsert(rows.slice(i, i + CHUNK), {
      onConflict: 'user_id,id'
    })
    if (error) throw new Error(`${table}: ${error.message}`)
  }
}

export type BackupResult =
  { ok: true; pushed: { tasks: number; events: number } } | { ok: false; error: string }

/** Push all local tasks + events to the cloud (full upsert). Never throws. */
export async function pushAll(): Promise<BackupResult> {
  const client = getSupabaseClient()
  if (!client) return { ok: false, error: 'not-configured' }
  const userId = await getSignedInUserId()
  if (!userId) return { ok: false, error: 'not-signed-in' }
  // Ownership guard: never upload this device's local data under a DIFFERENT
  // account than the one it belongs to (shared-machine cross-account leak).
  // If unowned, atomically claim it, then RE-READ so a lost claim race also
  // fails closed — we proceed only when we're the confirmed owner.
  let owner = await readOwner()
  if (!owner) {
    await claimOwnershipIfUnset(userId)
    owner = await readOwner()
  }
  if (owner !== userId) {
    await writeState({ lastError: 'ownership-mismatch', lastErrorAt: new Date().toISOString() })
    return { ok: false, error: 'ownership-mismatch' }
  }
  try {
    // Tombstones are included so DELETIONS propagate: tasks carry `deleted`;
    // events count as deleted when backup-tombstoned OR still in the transient
    // Google-delete state. The Google read-cache is a separate store, never here.
    const tasks = await listTasks(tasksDir(), { includeDeleted: true })
    const events = (await listEvents(eventsDir(), { includeDeleted: true })).filter(
      (e) => e.source === 'local'
    )

    const taskRows: BackupRow[] = tasks.map((t: Task) => ({
      id: t.id,
      user_id: userId,
      updated_at: t.updatedAt,
      deleted: t.deleted === true,
      payload: t
    }))
    const eventRows: BackupRow[] = events.map((e) => {
      const deleted = e.deleted === true || e.sync?.state === 'deleted'
      const payload = eventPayload(e)
      if (deleted) payload.deleted = true // a pull elsewhere imports it as a tombstone
      return { id: e.id, user_id: userId, updated_at: e.updatedAt, deleted, payload }
    })

    await upsertRows(client, 'backup_tasks', taskRows)
    await upsertRows(client, 'backup_events', eventRows)
    await writeState({ lastPushAt: new Date().toISOString(), lastError: undefined })
    return { ok: true, pushed: { tasks: taskRows.length, events: eventRows.length } }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'push-failed'
    await writeState({ lastError: msg, lastErrorAt: new Date().toISOString() })
    return { ok: false, error: msg }
  }
}

// --- Pull + reconcile (restore) ----------------------------------------------
// The reconcile rules live in backup-core.ts (pure + unit-provable): per-record
// by id, newest wins, cloud tombstones apply only when newer, never wipe, and a
// two-machine concurrent edit keeps the losing local version as `<id>.conflict`.

const PAGE = 1000

async function fetchAllRows(
  client: NonNullable<ReturnType<typeof getSupabaseClient>>,
  table: string,
  userId: string
): Promise<CloudRow[]> {
  const out: CloudRow[] = []
  for (let from = 0; ; from += PAGE) {
    // RLS already scopes to our own rows; the explicit filter is belt-and-braces.
    // order('id') makes the paging STABLE — .range() is LIMIT/OFFSET, and without
    // an ORDER BY Postgres may return pages in different orders, silently
    // skipping records past the first page during a large restore.
    const { data, error } = await client
      .from(table)
      .select('id,updated_at,deleted,payload')
      .eq('user_id', userId)
      .order('id')
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    out.push(...((data ?? []) as CloudRow[]))
    if (!data || data.length < PAGE) break
  }
  return out
}

function notifyEventsChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('events:changed')
  }
}

export type RestoreResult =
  { ok: true; imported: { tasks: number; events: number } } | { ok: false; error: string }

/** Pull the cloud mirror and reconcile it into the local stores. Never throws,
 *  never wipes: every change is per-record, and only when the cloud is newer. */
export async function pullAll(): Promise<RestoreResult> {
  const client = getSupabaseClient()
  if (!client) return { ok: false, error: 'not-configured' }
  const userId = await getSignedInUserId()
  if (!userId) return { ok: false, error: 'not-signed-in' }
  // Same ownership guard as the push: on a FRESH machine this claims the device
  // (that's the restore-on-new-machine path); on a mismatched machine it refuses.
  let owner = await readOwner()
  if (!owner) {
    await claimOwnershipIfUnset(userId)
    owner = await readOwner()
  }
  if (owner !== userId) {
    await writeState({ lastError: 'ownership-mismatch', lastErrorAt: new Date().toISOString() })
    return { ok: false, error: 'ownership-mismatch' }
  }
  try {
    const { lastSyncAt } = await readState()

    // onlyIfNewer: the importers RE-CHECK the on-disk record at write time, so a
    // user edit/delete landing mid-restore (after this snapshot) is never
    // clobbered by stale cloud data.
    const guardedImportTask = (dir: string, p: unknown): ReturnType<typeof importTask> =>
      importTask(dir, p, { onlyIfNewer: true })
    const guardedImportEvent = (dir: string, p: unknown): ReturnType<typeof importEvent> =>
      importEvent(dir, p, { onlyIfNewer: true })

    const taskRows = await fetchAllRows(client, 'backup_tasks', userId)
    const taskMap = new Map(
      (await listTasks(tasksDir(), { includeDeleted: true })).map((t) => [t.id, t])
    )
    const tasksChanged = await reconcileStore(
      tasksDir(),
      taskRows,
      taskMap,
      guardedImportTask,
      lastSyncAt
    )

    const eventRows = await fetchAllRows(client, 'backup_events', userId)
    const eventMap = new Map(
      (await listEvents(eventsDir(), { includeDeleted: true }))
        .filter((e) => e.source === 'local')
        .map((e) => [e.id, e])
    )
    const eventsChanged = await reconcileStore(
      eventsDir(),
      eventRows,
      eventMap,
      guardedImportEvent,
      lastSyncAt
    )

    if (eventsChanged > 0) notifyEventsChanged() // the calendar re-reads live
    return { ok: true, imported: { tasks: tasksChanged, events: eventsChanged } }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'pull-failed'
    await writeState({ lastError: msg, lastErrorAt: new Date().toISOString() })
    return { ok: false, error: msg }
  }
}

// --- Scheduling ---------------------------------------------------------------
// Every backup operation runs through ONE promise chain, so a pull can never
// interleave with a push (or another pull) — no overlap races, no flags.

let chain: Promise<unknown> = Promise.resolve()
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn)
  chain = p.then(
    () => {},
    () => {}
  )
  return p
}

/** Full sync: pull + reconcile, then push. The lastSyncAt cursor (used for
 *  concurrent-edit conflict detection) only advances when BOTH succeeded, and
 *  is stamped with a time captured BEFORE the pull — a conservative cursor can
 *  only produce an extra .conflict copy, never a missed one. */
export async function syncNow(): Promise<{ pull: RestoreResult; push: BackupResult }> {
  const startedAt = new Date().toISOString()
  const pull = await pullAll()
  const push = await pushAll()
  if (pull.ok && push.ok) await writeState({ lastSyncAt: startedAt })
  return { pull, push }
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null

/** Coalesce a burst of local changes into one push ~`delayMs` later. */
export function scheduleBackup(delayMs = 10_000): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void enqueue(pushAll)
  }, delayMs)
}

let registered = false

export function registerBackup(): void {
  if (registered) return
  registered = true

  // Manual triggers (the settings UI in a later step calls these).
  ipcMain.handle('backup:pushNow', () => enqueue(pushAll))
  ipcMain.handle('backup:syncNow', () => enqueue(syncNow))
  ipcMain.handle('backup:getStatus', () => readState())

  getSupabaseClient()?.auth.onAuthStateChange((event, session) => {
    const uid = session?.user?.id
    // Pin this device's owner the moment an account appears (sign-in or a
    // restored session), even before any push — so a later different sign-in
    // on a shared machine is refused by the ownership guard.
    if (uid) void claimOwnershipIfUnset(uid)
    // A fresh SIGN-IN is the restore moment (first run on a new machine pulls
    // everything back). Session restores are covered by the launch sync below.
    if (event === 'SIGNED_IN' && uid) void enqueue(syncNow)
  })

  // Full sync shortly after launch (restore first, then push), then periodic.
  setTimeout(() => void enqueue(syncNow), 3_000)
  setInterval(() => void enqueue(syncNow), 10 * 60_000)
}
