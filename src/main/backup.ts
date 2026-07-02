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
import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import { getSupabaseClient, getSignedInUserId } from './auth'
import { listTasks, type Task } from './tasks-fs'
import { listEvents, type CalendarEvent } from './events-fs'

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
    // Tasks include tombstones (deleted flag) so deletions propagate. Events are
    // live local events only (event delete-tombstones land with restore in the
    // next step); the Google read-cache is a separate store and never included.
    const tasks = await listTasks(tasksDir(), { includeDeleted: true })
    const events = (await listEvents(eventsDir())).filter((e) => e.source === 'local')

    const taskRows: BackupRow[] = tasks.map((t: Task) => ({
      id: t.id,
      user_id: userId,
      updated_at: t.updatedAt,
      deleted: t.deleted === true,
      payload: t
    }))
    const eventRows: BackupRow[] = events.map((e) => ({
      id: e.id,
      user_id: userId,
      updated_at: e.updatedAt,
      deleted: false,
      payload: eventPayload(e)
    }))

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

// --- Scheduling: single-flight + debounced on-change + periodic -------------

let pushing = false
let rerun = false
let debounceTimer: ReturnType<typeof setTimeout> | null = null

/** Run a push now, single-flight. If asked again mid-run, run once more after. */
async function runPush(): Promise<void> {
  if (pushing) {
    rerun = true
    return
  }
  pushing = true
  try {
    do {
      rerun = false
      await pushAll()
    } while (rerun)
  } finally {
    pushing = false
  }
}

/** Coalesce a burst of local changes into one push ~`delayMs` later. */
export function scheduleBackup(delayMs = 10_000): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void runPush()
  }, delayMs)
}

let registered = false

export function registerBackup(): void {
  if (registered) return
  registered = true

  // Manual "back up now" (the settings button in a later step calls this).
  ipcMain.handle('backup:pushNow', () => pushAll())
  ipcMain.handle('backup:getStatus', () => readState())

  // Pin this device's owner the moment an account signs in (or its session is
  // restored on launch), even before any push — so a later different sign-in
  // on a shared machine is refused by the ownership guard.
  getSupabaseClient()?.auth.onAuthStateChange((_event, session) => {
    const uid = session?.user?.id
    if (uid) void claimOwnershipIfUnset(uid)
  })

  // Push existing data shortly after launch, then a periodic safety flush.
  scheduleBackup(3_000)
  setInterval(() => void runPush(), 10 * 60_000)
}
