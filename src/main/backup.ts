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
import { signalBackupStepFailed } from './telemetry/signals'
import { localMemoryCount } from './memory/memory-count'
import { app, ipcMain, shell, BrowserWindow } from 'electron'
import { join, dirname } from 'node:path'
import { promises as fs } from 'node:fs'
import { getSupabaseClient, getSignedInUserId } from './auth'
import { listTasks, importTask, type Task } from './tasks-fs'
import { listEvents, importEvent, type CalendarEvent } from './events-fs'
import {
  listCallsForBackup,
  callBackupPayload,
  callFullBackupPayload,
  importCall,
  attachmentBlobPath,
  touchAllCallsForRepush,
  type Call
} from './calls-fs'
import { listEntries, importEntry, type KnowledgeEntry } from './knowledge-fs'
import {
  listQueue as listObjectionQueue,
  importQueueItem as importObjectionQueueItem
} from './objection-queue-fs'
import { backupRefusedForSandbox } from './sandbox-profile'
import { memoryDbPath, removeWalSidecars } from './memory/db'
import { snapshotMemoryDb } from './memory/snapshot'
import { listContacts, importContact, type Contact } from './contacts-fs'
import { listDeals, importDeal, type Deal } from './deals-fs'
import { loadDealStagesMeta, applyPulledDealStages } from './deal-stages'
import {
  loadAppSettings,
  applyPulledSettings,
  setSyncScopeDisabledListener,
  type BackupSyncScope
} from './app-settings'
import { writeJsonAtomic } from './atomic-write'
import {
  conversationsDir as assistantConversationsDir,
  listConversations,
  getConversation,
  importConversation
} from './assistant/conversations-fs'
import {
  reconcileStore,
  ts,
  toServerMs,
  toServerIso,
  toDeviceIso,
  type CloudRow
} from './backup-core'
import { getJobManager } from './jobs/instance'
import type { Job } from './jobs/types'
import { NO_AI_PURPOSE } from './jobs/types'

/** M29 A2 — BUG-087's lesson: EVERY best-effort sub-step failure also counts
 *  into the aggregate signal (step + short code, never the error text), so a
 *  step that fails for everyone forever is a dashboard row, not archaeology.
 *
 *  The word "every" here is a promise to enumerate, not emphasis. It was FALSE
 *  from A5.2 until 2026-08-24: the Sales Brain snapshot-read catch was a bare
 *  `return`, found by the sweep (H5) and fixed in the same pass that restored
 *  this sentence. If you add a best-effort catch in this file, it counts — or
 *  this sentence has to change again. */
function reportBackupStep(step: string, err: unknown): void {
  const e = err as { code?: unknown; statusCode?: unknown; status?: unknown; name?: unknown } | null
  const raw = e?.code ?? e?.statusCode ?? e?.status ?? e?.name
  const code =
    (typeof raw === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(raw) && raw) ||
    (typeof raw === 'number' && String(raw)) ||
    undefined
  signalBackupStepFailed({ step, code: code || undefined })
}

/** M26 Phase 3 — the visible sync job. Registered from registerBackup(),
 *  which runs after main creates the shared JobManager. */
const SYNC_JOB_TYPE = 'backup:sync'

/** Start a visible sync job unless one is already queued or running, and
 *  return its id. Shared by the manual "Sync now" button and the sign-in
 *  restore, so the two can never race into overlapping jobs.
 *
 *  Returns null only if the job system refuses — never throws: a failed
 *  enqueue must not take down a sign-in. */
function startSyncJob(): string | null {
  try {
    const manager = getJobManager()
    const already = manager
      .list()
      .find((j: Job) => j.type === SYNC_JOB_TYPE && (j.state === 'running' || j.state === 'queued'))
    if (already) return already.id
    return manager.enqueue(SYNC_JOB_TYPE, {}).id
  } catch (err) {
    console.error('[backup] could not start the sync job:', err)
    reportBackupStep('syncJobStart', err)
    return null
  }
}

function tasksDir(): string {
  return join(app.getPath('userData'), 'tasks')
}
function eventsDir(): string {
  return join(app.getPath('userData'), 'events')
}
function callsDir(): string {
  return join(app.getPath('userData'), 'calls')
}
function knowledgeDir(): string {
  return join(app.getPath('userData'), 'knowledge')
}

/** BUG-189 — the objection review queue (objection-queue/*.json). */
function objectionQueueDir(): string {
  return join(app.getPath('userData'), 'objection-queue')
}
function contactsDir(): string {
  return join(app.getPath('userData'), 'contacts')
}
function dealsDir(): string {
  return join(app.getPath('userData'), 'deals')
}
function statePath(): string {
  return join(app.getPath('userData'), 'backup-state.json')
}
function pendingBlobDeletesPath(): string {
  return join(app.getPath('userData'), 'backup-pending-blob-deletes.json')
}

// --- Attachment blob deletion --------------------------------------------------
// Storage objects live outside the row reconcile, so nothing removed them:
// deleting a call left its uploaded files in the bucket forever. Deletions are
// QUEUED locally (durable across restarts/offline) and drained on every push.

interface PendingBlobDelete {
  id: string
  ext: string
}

async function readPendingBlobDeletes(): Promise<PendingBlobDelete[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(pendingBlobDeletesPath(), 'utf8')) as {
      items?: unknown
    }
    if (!Array.isArray(parsed.items)) return []
    return parsed.items.filter(
      (i): i is PendingBlobDelete =>
        !!i &&
        typeof i === 'object' &&
        typeof (i as PendingBlobDelete).id === 'string' &&
        typeof (i as PendingBlobDelete).ext === 'string'
    )
  } catch {
    return []
  }
}

async function writePendingBlobDeletes(items: PendingBlobDelete[]): Promise<void> {
  await writeJsonAtomic(pendingBlobDeletesPath(), { items }).catch(() => {})
}

/** Called by calls.ts when a call (or a single attachment) is deleted —
 *  queue its uploaded blobs for removal from the cloud bucket. Best-effort
 *  and durable: drained on the next push, retried until it succeeds. */
export function queueAttachmentBlobDeletes(items: PendingBlobDelete[]): void {
  if (!items.length) return
  void (async () => {
    const existing = await readPendingBlobDeletes()
    const seen = new Set(existing.map((i) => `${i.id}.${i.ext}`))
    const fresh = items.filter((i) => !seen.has(`${i.id}.${i.ext}`))
    if (fresh.length) await writePendingBlobDeletes([...existing, ...fresh])
    scheduleBackup()
  })()
}

// --- Scrub-on-toggle-off ---------------------------------------------------
// The opt-in privacy toggles used to be upload-only: turning one OFF stopped
// future pushes but left everything already uploaded in the cloud, while the
// UI said "never leaves this Mac". A toggle-off now queues a durable scrub,
// drained at the start of every push (so it survives offline/restart and is
// retried until it succeeds). Local files are never touched — re-enabling the
// toggle simply re-uploads from local.

type ScrubKey = keyof BackupSyncScope

function pendingScrubsPath(): string {
  return join(app.getPath('userData'), 'backup-pending-scrubs.json')
}

/**
 * Every scope key whose data can be REMOVED from the cloud when the user
 * switches it off.
 *
 * BUG-200 / BUG-202 — this listed five of the seven, and the two it omitted
 * were exactly the two that default ON (`salesBrain`, `riseConversations`).
 * Switching either off stopped future uploads and left everything already
 * uploaded in place, with no path in the product to remove it. Both are here
 * now, and both have a branch in drainPendingScrubs below; a key in this list
 * WITHOUT a branch is a silent no-op, which is why that chain now ends in an
 * `else` that throws rather than falling through.
 */
/** EXHAUSTIVE over BackupSyncScope on purpose, the same way CALL_FIELD_RULES
 *  is exhaustive over Required<Call>: adding a sync scope key is a COMPILE
 *  ERROR until it is given a removal path here, rather than a silent gap
 *  nobody notices until someone asks where their data went. `true` means the
 *  key can be scrubbed; there is no `false` case, because a category that can
 *  be uploaded and not removed is the bug this replaces. */
const SCRUB_KEY_SET: Record<ScrubKey, true> = {
  transcripts: true,
  attachments: true,
  knowledgeBase: true,
  settingsPersonalization: true,
  contacts: true,
  salesBrain: true,
  riseConversations: true
}
export const SCRUB_KEYS = Object.keys(SCRUB_KEY_SET) as ScrubKey[]

async function readPendingScrubs(): Promise<ScrubKey[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(pendingScrubsPath(), 'utf8')) as { keys?: unknown }
    const keys = parsed.keys
    if (!Array.isArray(keys)) return []
    return SCRUB_KEYS.filter((k) => keys.includes(k))
  } catch {
    return []
  }
}

async function writePendingScrubs(keys: ScrubKey[]): Promise<void> {
  await writeJsonAtomic(pendingScrubsPath(), { keys }).catch(() => {})
}

function queuePendingScrubs(keys: ScrubKey[]): void {
  void (async () => {
    const existing = await readPendingScrubs()
    const merged = SCRUB_KEYS.filter((k) => existing.includes(k) || keys.includes(k))
    await writePendingScrubs(merged)
    scheduleBackup(1_000) // scrub promptly — this is a privacy action, not a routine edit
  })()
}

/**
 * BUG-204 — a scrub must prove the data is GONE, not merely that no error came
 * back.
 *
 * MEASURED, against the live project, on three tables: a DELETE that row-level
 * security filters down to zero rows returns HTTP 200, an empty body and
 * `error === null`. That is byte-identical to a DELETE that removed every row.
 * The old check was `if (error) throw`, so it could not tell "deleted
 * everything" from "deleted nothing", cleared the key from the pending queue,
 * and the Backup card reported an erase that never happened.
 *
 * It was correct only by accident: before 2026-09-erase-paths.sql the one table
 * we hit also lacked the DELETE GRANT, and a missing grant DOES raise an error.
 * Any table with the grant and no policy would have scrubbed silently.
 *
 * THE RULE, and it is not the obvious one. The pass condition is
 * `after === 0`, NOT "the count went down".
 *   - `before === 0 && after === 0` is a SUCCESS (`already-empty`), and it is
 *     the common case. Treating "the count did not move" as failure would
 *     re-queue it forever, and for the `transcripts` key that means
 *     `touchAllCallsForRepush` rewriting and re-uploading the user's entire
 *     call history on every push, which is the exact loop the comment in that
 *     branch was written to avoid.
 *   - `after === 0` is also strictly STRONGER than "moved": before 5, after 2
 *     has moved and is not erased.
 *
 * `before` still earns its round trip, for a reason that only shows up in what
 * the user is told: with three numbers we can separate "RLS filtered the
 * delete" (`deleted === 0`, the BUG-204 fingerprint) from "the delete worked
 * and another device re-added rows" (`deleted > 0`). With two we cannot, and
 * we would tell someone their data was not deleted when the truth is that
 * their other laptop is still syncing. A false alarm on a privacy promise is
 * its own failure.
 *
 * THE FLOOR, stated because it should be: every count reads through the same
 * JWT and the same `user_id = eq.<me>` predicate as the delete. A blind SELECT
 * policy reads zero before and zero after, and this — or any other design that
 * asks the same server the same way — retires the key confidently. Nothing
 * here clears that, and nothing should claim to.
 */
export type ScrubOutcome = 'erased' | 'already-empty'

/** Carries a short code so `reportBackupStep` can forward it: that helper only
 *  passes through values matching /^[A-Za-z0-9_.-]{1,64}$/. */
export class ScrubError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'ScrubError'
  }
}

/** This user's row count for a table, exact, transferring no rows.
 *  `n: null` means the count could not be READ — never treat it as zero. */
async function countUserRows(
  client: NonNullable<ReturnType<typeof getSupabaseClient>>,
  table: string,
  userId: string
): Promise<{ n: number | null; why?: string }> {
  const { count, error } = await client
    .from(table)
    .select('user_id', { count: 'exact', head: true })
    .eq('user_id', userId)
  if (error) return { n: null, why: error.message }
  return typeof count === 'number' ? { n: count } : { n: null, why: 'no count header' }
}

/** Delete this user's rows from `table` and PROVE the table is empty for them
 *  afterwards. Throws a ScrubError on anything but a proven-empty outcome, so
 *  the caller's existing catch re-queues the key unchanged. */
export async function eraseUserRowsProven(
  client: NonNullable<ReturnType<typeof getSupabaseClient>>,
  table: string,
  userId: string
): Promise<ScrubOutcome> {
  // Best effort, and tolerated when null: `before` never decides pass/fail, it
  // only names WHICH failure happened.
  const before = await countUserRows(client, table, userId)

  // `delete({ count: 'exact' })` appends a Prefer header to a request already
  // being sent, so the affected-row count costs no extra round trip and cannot
  // change which rows are targeted.
  const { count: deleted, error } = await client
    .from(table)
    .delete({ count: 'exact' })
    .eq('user_id', userId)
  if (error) throw new ScrubError('delete-error', `${table}: ${error.message}`)

  const after = await countUserRows(client, table, userId)
  if (after.n === null) {
    throw new ScrubError('unverifiable', `${table}: could not read a count back (${after.why})`)
  }
  if (after.n === 0) return before.n === 0 ? 'already-empty' : 'erased'

  if (deleted === 0) {
    throw new ScrubError(
      'survivors',
      `${table}: the delete reported 0 rows affected and ${after.n} remain — a policy filtered it`
    )
  }
  throw new ScrubError(
    're-added',
    `${table}: deleted ${deleted} but ${after.n} remain — another device is still pushing`
  )
}

/** The Storage twin of eraseUserRowsProven. Same three numbers from different
 *  primitives, and the same pass condition.
 *
 *  `remove()` needs BOTH delete and select permission on storage.objects, so a
 *  bucket with a delete policy and a broken select policy returns 200 with an
 *  empty `data` and no error — BUG-204's shape exactly, one layer over. The
 *  confirming `list` after the loop is the assertion the old code never made:
 *  it broke out of the loop immediately after a remove and never looked again. */
export async function eraseStoragePrefixProven(
  client: NonNullable<ReturnType<typeof getSupabaseClient>>,
  bucketName: string,
  userId: string
): Promise<ScrubOutcome> {
  const bucket = client.storage.from(bucketName)
  let seen = 0
  let removed = 0
  for (;;) {
    const { data, error } = await bucket.list(userId, { limit: 100 })
    if (error) throw new ScrubError('list-error', `${bucketName}: ${error.message}`)
    if (!data?.length) break
    seen += data.length
    const { data: gone, error: rmErr } = await bucket.remove(
      data.map((o) => `${userId}/${o.name}`)
    )
    if (rmErr) throw new ScrubError('remove-error', `${bucketName}: ${rmErr.message}`)
    const n = gone?.length ?? 0
    removed += n
    // A page that removed NOTHING would spin this loop forever on a full page.
    // Break and let the confirming list below report it as survivors.
    if (n === 0) break
    if (data.length < 100) break
  }

  const { data: left, error: leftErr } = await bucket.list(userId, { limit: 1 })
  if (leftErr) {
    throw new ScrubError('unverifiable', `${bucketName}: could not re-list after removing`)
  }
  if (left?.length) {
    throw new ScrubError(
      removed === 0 ? 'survivors' : 're-added',
      `${bucketName}: ${left.length}+ object(s) still under the prefix after removing ${removed}`
    )
  }
  return seen === 0 ? 'already-empty' : 'erased'
}

/** Delete every object under this user's folder in the attachments bucket. */
async function scrubAllAttachmentBlobs(
  client: NonNullable<ReturnType<typeof getSupabaseClient>>,
  userId: string
): Promise<void> {
  await eraseStoragePrefixProven(client, 'attachments', userId)
}

/**
 * BUG-200 — remove the uploaded Sales Brain from Storage.
 *
 * The upload writes exactly `${userId}/memory.db`, but this lists and removes
 * EVERYTHING under the user's prefix, the same shape as the attachment scrub
 * above. The founder asked for an account-erase path that actually works, and
 * an erase that only deletes the one filename it expects is not one: an object
 * written by an older build, or a partial upload under another name, would
 * survive it silently.
 *
 * Throws on failure so the caller keeps the key queued and retries next push.
 *
 * BUG-204: it now also throws when the objects are still there after removing
 * them, which the old loop could not notice because it broke out immediately
 * after the remove and never re-listed.
 */
async function scrubSalesBrainDb(
  client: NonNullable<ReturnType<typeof getSupabaseClient>>,
  userId: string
): Promise<void> {
  await eraseStoragePrefixProven(client, 'sales-brain', userId)
}

/** Drain queued scrubs. Each key is retried independently; a key is only
 *  removed from the queue once its scrub succeeded. Runs at the START of a
 *  push, so e.g. the transcripts scrub (touch + re-push quote-free rows)
 *  takes effect in the same push that follows. */
/**
 * BUG-205 — switching TRANSCRIPTS off must also remove the Sales Brain that is
 * already uploaded.
 *
 * The brain upload is gated on the transcripts toggle as well as its own,
 * because a memory's `evidence` is a verbatim span of the transcript. Gating
 * the upload alone would stop FUTURE uploads and leave the verbatim quotes
 * already sitting in the account — which is BUG-200's exact shape reappearing
 * inside its own fix, and the reason this expansion exists rather than being
 * left to the user to work out.
 *
 * Pure and exported so it can be tested directly: the listener it feeds is
 * registered inside registerBackup and is not reachable from a test.
 */
export function expandDisabledScrubKeys(keys: ScrubKey[]): ScrubKey[] {
  if (!keys.includes('transcripts') || keys.includes('salesBrain')) return keys
  return [...keys, 'salesBrain']
}

async function drainPendingScrubs(
  client: NonNullable<ReturnType<typeof getSupabaseClient>>,
  userId: string
): Promise<void> {
  const pending = await readPendingScrubs()
  if (!pending.length) return
  const remaining: ScrubKey[] = []
  let lastError: string | undefined
  for (const key of pending) {
    try {
      if (key === 'transcripts') {
        // The server trigger only accepts strictly-newer rows, so the old
        // transcript-bearing rows can only be evicted by NEWER quote-free
        // ones — bump every call's updatedAt and let this push replace them.
        await touchAllCallsForRepush(callsDir())
        // BUG-189 — the objection queue rows are the buyer's words too, and
        // they leave with the same switch: deleted outright (the one table
        // with a delete policy — a tombstone would still be a row). Its own
        // try: if the table does not exist yet there is nothing there to
        // scrub, and a missing table must not keep this key pending forever
        // (which would re-touch every call on every push).
        try {
          await eraseUserRowsProven(client, 'backup_objection_queue', userId)
        } catch (err) {
          console.error('[backup] objection queue scrub failed:', err)
          reportBackupStep('objectionQueueScrub', err)
        }
      } else if (key === 'attachments') {
        await scrubAllAttachmentBlobs(client, userId)
      } else if (key === 'knowledgeBase') {
        await eraseUserRowsProven(client, 'backup_knowledge', userId)
      } else if (key === 'contacts') {
        for (const table of ['backup_contacts', 'backup_deals', 'backup_deal_stages']) {
          await eraseUserRowsProven(client, table, userId)
        }
      } else if (key === 'settingsPersonalization') {
        await eraseUserRowsProven(client, 'backup_settings', userId)
      } else if (key === 'salesBrain') {
        // BUG-200. Storage, not a table: the brain is uploaded as a single
        // memory.db blob, so the erase is a bucket remove.
        await scrubSalesBrainDb(client, userId)
      } else if (key === 'riseConversations') {
        // BUG-202. Needs a DELETE policy on the table — see
        // supabase/2026-09-rise-conversations-delete-policy.sql. Without it
        // row-level security refuses this and the key stays queued, which is
        // the correct failure: it retries rather than reporting success.
        // The table name stays a literal here on purpose: the guard in
        // every-uploadable-category-can-be-erased.test.ts scans this function's
        // source for it, and hiding it behind a lookup would turn that check
        // green while checking nothing.
        await eraseUserRowsProven(client, 'backup_rise_conversations', userId)
      } else {
        // BUG-200's near-miss, made impossible. This chain had NO else, so a
        // key added to SCRUB_KEYS without a branch fell through every test,
        // threw nothing, was not pushed onto `remaining`, and was written out
        // of the pending queue AS THOUGH ITS SCRUB HAD SUCCEEDED. The Backup
        // card would have shown the erase done and nothing would have been
        // deleted. Throwing keeps the key queued and surfaces it as a failed
        // step, so the next person to add a key without a branch finds out.
        throw new Error(`no scrub branch for sync scope key '${key}' — add one beside the others`)
      }
    } catch (err) {
      console.error(`[backup] scrub of '${key}' failed (will retry next push):`, err)
      // BUG-203. Every other failing step in this file reports itself; this one
      // did not, so a scrub failing on every push forever was invisible both to
      // the user and to the aggregate signal. Without this, BUG-204's counts
      // detect the failure on one machine and nobody ever hears about it.
      reportBackupStep(`scrub.${key}`, err)
      lastError = err instanceof ScrubError ? err.code : 'error'
      remaining.push(key)
    }
  }
  await writePendingScrubs(remaining)
  // BUG-203. Separate from lastPushError for the same reason push and pull are
  // separate above: a successful backup must never be able to imply a
  // successful erase. Cleared explicitly when nothing is left queued, so a
  // resolved failure does not stick on the card.
  await writeState(
    remaining.length
      ? {
          pendingScrubs: remaining,
          lastScrubError: lastError ?? 'error',
          lastScrubErrorAt: new Date().toISOString()
        }
      : { pendingScrubs: [], lastScrubError: undefined, lastScrubErrorAt: undefined }
  )
}

async function processPendingBlobDeletes(
  client: NonNullable<ReturnType<typeof getSupabaseClient>>,
  userId: string
): Promise<void> {
  const items = await readPendingBlobDeletes()
  if (!items.length) return
  const bucket = client.storage.from('attachments')
  const { error } = await bucket.remove(items.map((i) => `${userId}/${i.id}.${i.ext}`))
  // remove() succeeds for already-missing objects, so success = queue drained.
  // On error keep the whole queue for the next push.
  if (!error) await writePendingBlobDeletes([])
}

const ATTACHMENT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
}

export interface BackupState {
  lastPushAt?: string
  /** When the last successful FULL sync (pull + push) finished. Also the cursor
   *  for concurrent-edit detection: a local record edited after this AND
   *  superseded by a newer cloud version gets a .conflict copy. */
  lastSyncAt?: string
  // Push and pull errors are tracked SEPARATELY (not one shared `lastError`):
  // pushAll and pullAll both run inside syncNow, and if they shared one field,
  // whichever ran second would clear the other's failure on its own success —
  // e.g. a genuinely broken restore (pull fails) followed by a normal push
  // (succeeds) would silently erase the pull's error, and the trust UI would
  // show "backed up" while restore was actually broken.
  lastPushError?: string
  lastPushErrorAt?: string
  lastPullError?: string
  lastPullErrorAt?: string
  /** This device's clock minus the server's, in ms, from the last successful
   *  measurement. Used to put local timestamps on the server's timeline before
   *  comparing them (see backup-core's toServerMs) and to warn the user when
   *  their clock is badly wrong. Absent = never successfully measured. */
  clockSkewMs?: number
  clockSkewCheckedAt?: string
  /** BUG-203 — scrub keys whose removal has NOT succeeded yet, and why.
   *  Deliberately its own field rather than folded into lastPushError, for
   *  exactly the reason push and pull are separate above: a successful backup
   *  must never be able to imply a successful erase. A user whose erase keeps
   *  failing used to see "Backed up just now" and nothing else, forever. */
  pendingScrubs?: ScrubKey[]
  lastScrubError?: string
  lastScrubErrorAt?: string
}

async function readState(): Promise<BackupState> {
  try {
    return JSON.parse(await fs.readFile(statePath(), 'utf8')) as BackupState
  } catch {
    return {}
  }
}
function conflictDirs(): string[] {
  return [tasksDir(), eventsDir(), callsDir(), knowledgeDir(), contactsDir(), dealsDir()]
}

async function countConflictFiles(): Promise<number> {
  let count = 0
  for (const dir of conflictDirs()) {
    try {
      count += (await fs.readdir(dir)).filter((f) => f.endsWith('.conflict')).length
    } catch {
      /* store dir missing — nothing to count */
    }
  }
  return count
}

async function writeState(patch: BackupState): Promise<void> {
  const next = { ...(await readState()), ...patch }
  // Atomic like every other store: a torn write here blanks lastSyncAt, which
  // degrades conflict detection and wipes the "Backed up X ago" status.
  await writeJsonAtomic(statePath(), next).catch(() => {})
}

/** Past this much device-vs-server clock difference we warn the user. Well
 *  above any plausible network/NTP jitter, well below the multi-hour skews that
 *  actually corrupt ordering. Non-blocking: it is a hint, never a gate. */
export const CLOCK_SKEW_WARN_MS = 2 * 60_000

/**
 * Measure this device's clock offset from the server (device - server).
 *
 * Best-effort by design, exactly like every other cloud call here: if the
 * `server_now()` function hasn't been created yet (the user runs
 * supabase/backup-schema.sql by hand) or the network is down, we return null
 * and every caller falls back to a 0 correction — i.e. the previous behaviour.
 * A skew we can't measure must never block a sync.
 */
async function measureClockSkew(
  client: NonNullable<ReturnType<typeof getSupabaseClient>>
): Promise<number | null> {
  try {
    const before = Date.now()
    const { data, error } = await client.rpc('server_now')
    const after = Date.now()
    if (error || data == null) return null
    const serverMs = Date.parse(String(data))
    if (Number.isNaN(serverMs)) return null
    // Compare the server's instant against the MIDPOINT of our own request
    // window, so round-trip latency isn't misread as clock skew.
    return Math.round(before + (after - before) / 2 - serverMs)
  } catch {
    return null
  }
}

/** Strip only the machine-specific sync STATE. The Google/Outlook IDENTITY
 *  (provider/externalId/remoteUpdatedAt) is account-level — the same remote
 *  event has the same ids on every machine — and carrying it lets a restore
 *  re-link an adopted event instead of duplicating it (the old strip-everything
 *  approach made the restored copy AND the pulled chip both show, and editing
 *  the copy inserted a duplicate on the remote calendar). */
function eventPayload(e: CalendarEvent): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...e }
  delete payload.sync
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
  rows: BackupRow[],
  skewMs = 0
): Promise<void> {
  if (!client) return
  // Upload every timestamp on the SERVER's timeline, so the trigger's
  // newest-wins comparison is between comparable values even when two devices
  // syncing the same account have differently-wrong clocks.
  const normalised =
    skewMs === 0 ? rows : rows.map((r) => ({ ...r, updated_at: toServerIso(r.updated_at, skewMs) }))
  for (let i = 0; i < normalised.length; i += CHUNK) {
    // The client carries the user's JWT → RLS applies; on conflict, the DB
    // trigger keeps whichever row is newest (server-decided).
    const { error } = await client.from(table).upsert(normalised.slice(i, i + CHUNK), {
      onConflict: 'user_id,id'
    })
    if (error) throw new Error(`${table}: ${error.message}`)
  }
}

/** Upload every attachment blob referenced by `calls` to the private
 *  "attachments" Storage bucket (path "<user_id>/<attachment_id>.<ext>").
 *  Re-uploads every push (upsert) rather than diffing — attachments are
 *  immutable once added, so this is a simple, always-correct v1; it does mean
 *  re-sending unchanged bytes on every periodic sync, a bandwidth tradeoff
 *  accepted for now (same "simple architecture first" spirit as the rest of
 *  the app). One attachment's failure is skipped, not fatal to the others. */
async function uploadAttachments(
  client: NonNullable<ReturnType<typeof getSupabaseClient>>,
  userId: string,
  calls: Call[]
): Promise<void> {
  const bucket = client.storage.from('attachments')
  for (const call of calls) {
    for (const att of call.attachments ?? []) {
      try {
        const data = await fs.readFile(attachmentBlobPath(callsDir(), att.id, att.ext))
        const path = `${userId}/${att.id}.${att.ext}`
        const { error } = await bucket.upload(path, data, {
          upsert: true,
          contentType: ATTACHMENT_MIME[att.ext] ?? 'application/octet-stream'
        })
        if (error) console.error(`[backup] attachment ${att.id} upload failed:`, error.message)
      } catch {
        /* local blob missing/unreadable — skip just this one attachment */
      }
    }
  }
}

/** Download any attachment blob `calls` reference that's missing locally —
 *  the counterpart to uploadAttachments, used after a restore pulls in call
 *  metadata that references attachments this (new) device doesn't have yet. */
async function downloadMissingAttachments(
  client: NonNullable<ReturnType<typeof getSupabaseClient>>,
  userId: string,
  calls: Call[]
): Promise<void> {
  const bucket = client.storage.from('attachments')
  for (const call of calls) {
    for (const att of call.attachments ?? []) {
      const localPath = attachmentBlobPath(callsDir(), att.id, att.ext)
      try {
        await fs.access(localPath)
        continue // already have it
      } catch {
        /* missing locally — try to fetch it */
      }
      try {
        const { data, error } = await bucket.download(`${userId}/${att.id}.${att.ext}`)
        if (error || !data) continue
        const buf = Buffer.from(await data.arrayBuffer())
        await fs.mkdir(dirname(localPath), { recursive: true })
        await fs.writeFile(localPath, buf)
      } catch {
        /* best-effort — a missing attachment blob just means it won't open yet */
      }
    }
  }
}

/** M25 — uploads the WHOLE memory.db file as one blob, same mechanism as
 *  uploadAttachments (a private Storage bucket, path "<user_id>/memory.db")
 *  — see supabase/2026-08-sales-brain-backup.sql for the bucket/RLS setup
 *  and its own doc comment for why whole-file, not row-per-record, is the
 *  correct v1 here. A no-op (not an error) if Sales Brain was never turned
 *  on — there's simply no file to upload yet. */
// Exported for the BUG-088/BUG-089 regression tests, which drive it with a
// stubbed Supabase client against a real on-disk WAL fixture.
export async function uploadSalesBrainDb(
  client: NonNullable<ReturnType<typeof getSupabaseClient>>,
  userId: string
): Promise<void> {
  const dbPath = memoryDbPath(app.getPath('userData'))
  // BUG-088 — never fs.readFile(dbPath) here: memory.db runs in WAL mode and
  // the main file can be DAYS staler than the -wal sidecar (nine days on the
  // founder's own machine when this was found). snapshotMemoryDb is the one
  // shared mechanism (the Export button uses the same call); it reads
  // through the WAL and yields a single consistent file.
  // BUG-092, the irreversible half. Supabase Storage upsert has no version
  // history, so an empty upload is unrecoverable. This gate is INDEPENDENT of
  // the restore guard above on purpose: if that one is ever wrong, this still
  // refuses. Founder's call — a hard block, not a warning: an upload we skip
  // is recoverable, an overwrite is not.
  //
  // 2026-09-07, BUG-206 — this is now a BLANKET block, and that reverses a
  // recorded decision deliberately, with the founder's explicit word.
  //
  // It used to refuse only when the cloud already held something, so that an
  // empty brain could still reach an empty bucket. The reasoning that was
  // written under had no erase path in it: uploading nothing was the only way
  // the cloud copy could ever be made to go away, so blocking it completely
  // would have meant "Forget everything" could never propagate.
  //
  // There is now a verified erase path (BUG-200's scrub through BUG-204's
  // eraseStoragePrefixProven), and an erasure travels as a DELETE rather than
  // as an upload of emptiness. So the question this gate used to ask — "is it
  // safe to overwrite the cloud with this empty file?" — no longer needs an
  // answer in either direction: nothing legitimate uploads an empty brain.
  // An empty local store means one of "not started yet", "corrupt", "husked",
  // or "just erased", and uploading it serves none of them.
  //
  // The consequence, stated because it is the cost: a genuinely fresh install
  // with an empty brain and an empty bucket now uploads nothing at all until
  // it learns its first fact. That is fine; there was nothing to preserve.
  const localForUpload = localMemoryCount(dbPath)
  if (localForUpload.ok && localForUpload.count === 0) {
    console.error('[backup] refusing to upload an EMPTY Sales Brain')
    reportBackupStep('salesBrainUploadRefusedEmpty', { code: 'empty-local' })
    return
  }

  const snapshotPath = `${dbPath}.upload-snapshot`
  const snap = await snapshotMemoryDb(dbPath, snapshotPath)
  if (!snap.ok) {
    if (snap.reason !== 'no-memory-db') {
      console.error('[backup] Sales Brain snapshot for upload failed:', snap.errorClass)
      reportBackupStep('salesBrainSnapshot', { code: snap.errorClass })
    }
    return // never upload a possibly-stale raw read as a fallback
  }
  let data: Buffer
  try {
    data = await fs.readFile(snapshotPath)
  } catch (err) {
    // M29 sweep finding H5: this catch used to be a bare `return`. The
    // snapshot succeeded, the read of it failed (an AV scanner holding a
    // file created milliseconds earlier is the realistic case on Windows),
    // and NOTHING recorded it — no log line, no signal, no state. Because it
    // returns rather than throws, pushAll then wrote lastPushError: undefined
    // and reported a clean backup, so the card said "Backed up just now"
    // forever while the Sales Brain had never been uploaded. That is BUG-087's
    // exact shape reintroduced inside BUG-088's own fix, and it made this
    // module's header claim ("every best-effort sub-step failure also counts")
    // false. Counted now, so the header can say "every" truthfully.
    console.error('[backup] Sales Brain snapshot read failed:', err)
    reportBackupStep('salesBrainSnapshotRead', err)
    return
  } finally {
    await fs.unlink(snapshotPath).catch(() => {})
  }
  const bucket = client.storage.from('sales-brain')
  const { error } = await bucket.upload(`${userId}/memory.db`, data, {
    upsert: true,
    contentType: 'application/octet-stream'
  })
  if (error) {
    console.error('[backup] Sales Brain DB upload failed:', error.message)
    reportBackupStep('salesBrainUpload', error)
  }
}

/** The counterpart to uploadSalesBrainDb — pulls the cloud copy down ONLY
 *  if there is no local memory.db at all (a fresh install / new machine).
 *  Deliberately never overwrites an EXISTING local file: since this is a
 *  whole-file blob with no row-level merge, downloading over a local file
 *  that already has newer local-only memories would silently lose them —
 *  the safer default is "a brand new machine gets the cloud copy once,
 *  after that local always wins" until real multi-device merge exists (see
 *  this module's own doc comment on BackupSyncScope.salesBrain). */
// Exported for the BUG-089 regression test (stale-sidecars fixture).
export async function downloadSalesBrainDb(
  client: NonNullable<ReturnType<typeof getSupabaseClient>>,
  userId: string
): Promise<void> {
  const dbPath = memoryDbPath(app.getPath('userData'))

  // BUG-092 — this used to be an EXISTENCE test (`await fs.access(dbPath)`),
  // which asks the wrong question. openMemoryDb creates the file with
  // `new DatabaseCtor(dbPath)` BEFORE the WAL pragma or loadExtension can
  // throw, so a failed init leaves a 0-byte husk; and a freshly-enabled Sales
  // Brain is schema-only (8192 bytes, zero rows). Both read as "local truth
  // worth protecting", so the restore was skipped — and the husk was then
  // uploaded over the only cloud copy with upsert:true. A user reached this by
  // doing exactly the right thing: turning the backup on to get their
  // memories back.
  //
  // The decision table (founder-approved 2026-08-24). The guiding rule for the
  // uncertain row is theirs: "when the choice is 'might lose data' vs 'might
  // leave clutter', clutter wins."
  //
  //   no file                 -> restore            (unchanged)
  //   >=1 memory row          -> DO NOT restore     (the M25 invariant, intact)
  //   0 memory rows           -> restore            (an empty brain is not local truth)
  //   unopenable / corrupt    -> rename aside, THEN restore
  const local = localMemoryCount(dbPath)
  if (local.ok && local.count > 0) {
    return // real local memories — never overwrite them from the cloud
  }
  if (!local.ok && local.reason === 'unreadable') {
    // Never destroy a file we merely failed to read: it may be recoverable by
    // hand, and a stray file on disk costs nothing next to losing a brain.
    try {
      const asideName = `${dbPath}.local-unreadable-${new Date()
        .toISOString()
        .replace(/[:.]/g, '-')}`
      await fs.rename(dbPath, asideName)
      console.error(`[backup] local memory.db unreadable (${local.errorClass}); moved to ${asideName}`)
      reportBackupStep('salesBrainLocalUnreadable', { code: local.errorClass })
    } catch (err) {
      // If we cannot even move it aside, do NOT restore over it.
      console.error('[backup] could not move unreadable memory.db aside:', err)
      reportBackupStep('salesBrainAsideFailed', err)
      return
    }
    // The sidecars belonged to the file we just moved aside; they must not be
    // left pointing at whatever lands here next (BUG-089's hazard, reached by
    // a different route). The restore path below clears them again before it
    // writes — that call stays, because the 0-rows and no-file rows reach it
    // without passing through here.
    removeWalSidecars(dbPath)
  }
  try {
    const bucket = client.storage.from('sales-brain')
    const { data, error } = await bucket.download(`${userId}/memory.db`)
    if (error || !data) return
    const buf = Buffer.from(await data.arrayBuffer())
    await fs.mkdir(dirname(dbPath), { recursive: true })
    // BUG-089 — a stale -wal/-shm left beside a just-restored main file makes
    // SQLite read inconsistent state (silently wrong memories, no error).
    // removeWalSidecars was written for exactly this hazard; this path was
    // unreachable while the bucket didn't exist (taxonomy species 24) and
    // never got the call.
    removeWalSidecars(dbPath)
    await fs.writeFile(dbPath, buf)
  } catch {
    /* best-effort — a missing/failed download just means Sales Brain starts fresh on this machine */
  }
}

export type BackupResult =
  | { ok: true; pushed: { tasks: number; events: number; calls: number } }
  | { ok: false; error: string }

/** Push all local tasks + events to the cloud (full upsert). Never throws. */
export async function pushAll(): Promise<BackupResult> {
  // BUG-186 — a dev build on a profile COPY refuses to reach the real backend
  // unless CALLRISE_SANDBOX_ALLOW_SYNC=1. Recorded like any other push
  // failure so the Backup card says so instead of showing a stale green.
  if (backupRefusedForSandbox()) {
    await writeState({ lastPushError: 'sandbox', lastPushErrorAt: new Date().toISOString() })
    return { ok: false, error: 'sandbox' }
  }
  // Record the "can't sync at all" states like any other push failure —
  // otherwise a signed-out user keeps seeing a green "Backed up N hours ago"
  // while every sync silently no-ops.
  const client = getSupabaseClient()
  if (!client) {
    await writeState({ lastPushError: 'not-configured', lastPushErrorAt: new Date().toISOString() })
    return { ok: false, error: 'not-configured' }
  }
  const userId = await getSignedInUserId()
  if (!userId) {
    await writeState({ lastPushError: 'not-signed-in', lastPushErrorAt: new Date().toISOString() })
    return { ok: false, error: 'not-signed-in' }
  }
  try {
    // Clock offset for this push — every uploaded updated_at is normalised onto
    // the server's timeline with it. Best-effort: unmeasurable → 0 → previous
    // behaviour, never a failed push.
    const skewMs = (await measureClockSkew(client)) ?? 0

    // Privacy scrubs first (toggle-offs waiting to take effect in the cloud) —
    // the transcripts scrub touches calls so THIS push replaces their rows.
    try {
      await drainPendingScrubs(client, userId)
    } catch (err) {
      console.error('[backup] scrub drain failed:', err)
      reportBackupStep('scrubDrain', err)
    }

    // Tombstones are included so DELETIONS propagate: tasks carry `deleted`;
    // events count as deleted when backup-tombstoned OR still in the transient
    // remote-delete state. The Google/Outlook read-caches are separate stores,
    // never here.
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

    // Calls: metadata + summary + quote-free coaching by default. callBackupPayload
    // is the privacy guarantee — it strips segments (transcript), preview, coaching
    // evidence quotes, and attachment contents. Only the explicit, off-by-default
    // "sync transcripts" toggle (Settings → Privacy & data) switches to the FULL
    // payload. Tombstones carry `deleted` either way.
    const syncScope = loadAppSettings().syncScope
    const buildCallPayload = syncScope.transcripts ? callFullBackupPayload : callBackupPayload
    const calls = await listCallsForBackup(callsDir())
    const callRows: BackupRow[] = calls.map((c: Call) => ({
      id: c.id,
      user_id: userId,
      updated_at: c.updatedAt,
      deleted: c.deleted === true,
      payload: buildCallPayload(c)
    }))

    await upsertRows(client, 'backup_tasks', taskRows, skewMs)
    await upsertRows(client, 'backup_events', eventRows, skewMs)
    await upsertRows(client, 'backup_calls', callRows, skewMs)

    // Optional categories (Settings → Privacy & data toggles). Each is best-effort
    // and isolated from the core sync above and from each other — a missing table
    // or bucket (not yet set up in Supabase) must never fail the core backup.
    if (syncScope.knowledgeBase) {
      try {
        const entries = await listEntries(knowledgeDir(), { includeDeleted: true })
        const knowledgeRows: BackupRow[] = entries.map((e: KnowledgeEntry) => ({
          id: e.id,
          user_id: userId,
          updated_at: e.updatedAt,
          deleted: e.deleted === true,
          payload: e
        }))
        await upsertRows(client, 'backup_knowledge', knowledgeRows, skewMs)
      } catch (err) {
        console.error('[backup] knowledge-base push failed:', err)
        reportBackupStep('knowledgePush', err)
      }
    }
    // BUG-189 — the objection review queue. Gated on the TRANSCRIPTS toggle,
    // not its own: an item is the buyer's words verbatim, the same category
    // the toggle already governs, and one switch the user already understands
    // beats a second one that means the same thing. Same isolation discipline
    // as every optional category: its own try/catch, its own step. Tombstones
    // travel as `deleted` rows (quotes already dropped on disk).
    if (syncScope.transcripts) {
      try {
        const items = await listObjectionQueue(objectionQueueDir(), { includeDeleted: true })
        const queueRows: BackupRow[] = items.map((i) => ({
          id: i.id,
          user_id: userId,
          updated_at: i.updatedAt,
          deleted: i.deleted === true,
          payload: i
        }))
        await upsertRows(client, 'backup_objection_queue', queueRows, skewMs)
      } catch (err) {
        console.error('[backup] objection queue push failed:', err)
        reportBackupStep('objectionQueuePush', err)
      }
    }
    // BUG-157 — Rise conversations. Same isolation discipline as every optional
    // category: a missing backup_rise_conversations table must never fail the
    // rest of the push, so this is its own try/catch and reports its own step.
    if (syncScope.riseConversations) {
      try {
        const dir = assistantConversationsDir(app.getPath('userData'))
        // BUG-207 — includeDeleted, because a tombstone is the whole point:
        // it is what tells every other device, and this device's own next
        // restore, that the thread was deleted on purpose.
        const metas = await listConversations(dir, { includeDeleted: true })
        const convRows: BackupRow[] = []
        for (const meta of metas) {
          // listConversations returns a LIST PROJECTION without the message
          // array — backing that up would sync titles and lose every word of
          // the actual conversation, which is the whole thing being protected.
          const full = await getConversation(dir, meta.id, { includeDeleted: true })
          if (!full) continue
          convRows.push({
            id: full.id,
            user_id: userId,
            updated_at: full.updatedAt,
            // BUG-207. This was hardcoded `false` with a comment explaining
            // that the store had no tombstones, which was true and was the
            // bug: the row for a deleted thread kept saying "not deleted", so
            // the restore re-imported it onto the machine it had just been
            // deleted from.
            deleted: full.deleted === true,
            payload: full
          })
        }
        await upsertRows(client, 'backup_rise_conversations', convRows, skewMs)
      } catch (err) {
        console.error('[backup] rise conversations push failed:', err)
        reportBackupStep('riseConversationsPush', err)
      }
    }
    if (syncScope.settingsPersonalization) {
      try {
        const settings = loadAppSettings()
        const { error } = await client.from('backup_settings').upsert(
          {
            user_id: userId,
            updated_at: toServerIso(settings.settingsUpdatedAt, skewMs),
            payload: settings
          },
          { onConflict: 'user_id' }
        )
        if (error) throw new Error(error.message)
      } catch (err) {
        console.error('[backup] settings push failed:', err)
        reportBackupStep('settingsPush', err)
      }
    }
    if (syncScope.attachments) {
      try {
        await uploadAttachments(client, userId, calls)
      } catch (err) {
        console.error('[backup] attachment upload failed:', err)
        reportBackupStep('attachmentUpload', err)
      }
    }
    // BUG-205 — gated on the TRANSCRIPTS toggle as well as its own, and this
    // is the founder's decision of 2026-09-07, for the same reason the
    // objection queue is gated that way: a Sales Brain memory's `evidence` is
    // a VERBATIM span of the transcript (extraction.ts, up to 400 characters),
    // which is the buyer's words, which is precisely the category the
    // transcripts toggle already governs.
    //
    // Before this, someone who deliberately switched transcript backup off —
    // having made an explicit decision about verbatim buyer speech — still had
    // word-for-word quotes going up inside memory.db, labelled only "Sales
    // Brain memories". Seven separate pieces of copy tried to describe that
    // truthfully and every one of them came back false or misleading, which is
    // what made it a behaviour problem rather than a wording problem.
    if (syncScope.salesBrain && syncScope.transcripts) {
      try {
        await uploadSalesBrainDb(client, userId)
      } catch (err) {
        console.error('[backup] Sales Brain DB upload failed:', err)
        reportBackupStep('salesBrainUpload', err)
      }
    }
    if (syncScope.contacts) {
      try {
        const people = await listContacts(contactsDir(), { includeDeleted: true })
        const contactRows: BackupRow[] = people.map((c: Contact) => ({
          id: c.id,
          user_id: userId,
          updated_at: c.updatedAt,
          deleted: c.deleted === true,
          payload: c
        }))
        await upsertRows(client, 'backup_contacts', contactRows, skewMs)
      } catch (err) {
        console.error('[backup] contacts push failed:', err)
        reportBackupStep('contactsPush', err)
      }
      // Deals travel with contacts (same toggle) — a restored contact list
      // without its deals is half a CRM. Same isolation discipline: a missing
      // backup_deals table must never fail the rest of the push.
      try {
        const deals = await listDeals(dealsDir(), { includeDeleted: true })
        const dealRows: BackupRow[] = deals.map((d: Deal) => ({
          id: d.id,
          user_id: userId,
          updated_at: d.updatedAt,
          deleted: d.deleted === true,
          // outcomeReason travels EXPLICITLY, null when there is none — the
          // stored record drops the key when empty, so a bare payload cannot
          // distinguish "cleared on this machine" from "written by an older
          // build that has never heard of the field". importDeal reads the
          // difference: null clears, ABSENT preserves. Same three-way
          // contract callBackupPayload uses for a call's dealId, same reason.
          payload: { ...d, outcomeReason: d.outcomeReason ?? null }
        }))
        await upsertRows(client, 'backup_deals', dealRows, skewMs)
      } catch (err) {
        console.error('[backup] deals push failed:', err)
        reportBackupStep('dealsPush', err)
      }
      // The stage list the deals point into — single row per user, like
      // backup_settings. Without it, restored deals on a new machine land in
      // the "No stage" column whenever custom stages were used.
      try {
        const { stages, updatedAt } = loadDealStagesMeta()
        const { error } = await client
          .from('backup_deal_stages')
          .upsert(
            { user_id: userId, updated_at: toServerIso(updatedAt, skewMs), payload: { stages } },
            { onConflict: 'user_id' }
          )
        if (error) throw new Error(error.message)
      } catch (err) {
        console.error('[backup] deal-stages push failed:', err)
        reportBackupStep('dealStagesPush', err)
      }
    }

    // Drain queued attachment-blob deletions (deleted calls / removed
    // attachments) — independent of the attachments toggle: removing what
    // no longer exists locally is always right.
    try {
      await processPendingBlobDeletes(client, userId)
    } catch (err) {
      console.error('[backup] blob-delete drain failed:', err)
      reportBackupStep('blobDeleteDrain', err)
    }

    await writeState({
      lastPushAt: new Date().toISOString(),
      lastPushError: undefined,
      lastPushErrorAt: undefined
    })
    return {
      ok: true,
      pushed: { tasks: taskRows.length, events: eventRows.length, calls: callRows.length }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'push-failed'
    await writeState({ lastPushError: msg, lastPushErrorAt: new Date().toISOString() })
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
      .select('id,updated_at,server_updated_at,deleted,payload')
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

/** Tell the renderer a restore changed tasks/calls on disk, so those screens
 *  re-read (otherwise restored data only appears on re-navigation). */
function notifyDataChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('backup:changed')
  }
}

export type RestoreResult =
  | { ok: true; imported: { tasks: number; events: number; calls: number } }
  | { ok: false; error: string }

/** Pull the cloud mirror and reconcile it into the local stores. Never throws,
 *  never wipes: every change is per-record, and only when the cloud is newer. */
export async function pullAll(): Promise<RestoreResult> {
  // BUG-186 — see pushAll. A pull from a sandbox is the quieter half of the
  // same hazard: it would drag the real account's data into a throwaway copy.
  if (backupRefusedForSandbox()) {
    await writeState({ lastPullError: 'sandbox', lastPullErrorAt: new Date().toISOString() })
    return { ok: false, error: 'sandbox' }
  }
  const client = getSupabaseClient()
  if (!client) {
    await writeState({ lastPullError: 'not-configured', lastPullErrorAt: new Date().toISOString() })
    return { ok: false, error: 'not-configured' }
  }
  const userId = await getSignedInUserId()
  if (!userId) {
    await writeState({ lastPullError: 'not-signed-in', lastPullErrorAt: new Date().toISOString() })
    return { ok: false, error: 'not-signed-in' }
  }
  try {
    const { lastSyncAt } = await readState()

    // Measure the device-vs-server clock offset BEFORE reconciling: every
    // "is the cloud copy newer?" decision below depends on it. Best-effort —
    // an unmeasurable skew applies a 0 correction (the old behaviour) rather
    // than failing the restore.
    const measuredSkew = await measureClockSkew(client)
    const skewMs = measuredSkew ?? 0
    if (measuredSkew !== null) {
      await writeState({
        clockSkewMs: measuredSkew,
        clockSkewCheckedAt: new Date().toISOString()
      })
    }

    // onlyIfNewer: the importers RE-CHECK the on-disk record at write time, so a
    // user edit/delete landing mid-restore (after this snapshot) is never
    // clobbered by stale cloud data.
    const guardedImportTask = (dir: string, p: unknown): ReturnType<typeof importTask> =>
      importTask(dir, p, { onlyIfNewer: true })
    const guardedImportEvent = (dir: string, p: unknown): ReturnType<typeof importEvent> =>
      importEvent(dir, p, { onlyIfNewer: true })
    const guardedImportCall = (dir: string, p: unknown): ReturnType<typeof importCall> =>
      importCall(dir, p, { onlyIfNewer: true })
    const guardedImportEntry = (dir: string, p: unknown): ReturnType<typeof importEntry> =>
      importEntry(dir, p, { onlyIfNewer: true })
    const guardedImportContact = (dir: string, p: unknown): ReturnType<typeof importContact> =>
      importContact(dir, p, { onlyIfNewer: true })
    const guardedImportDeal = (dir: string, p: unknown): ReturnType<typeof importDeal> =>
      importDeal(dir, p, { onlyIfNewer: true })

    const taskRows = await fetchAllRows(client, 'backup_tasks', userId)
    const taskMap = new Map(
      (await listTasks(tasksDir(), { includeDeleted: true })).map((t) => [t.id, t])
    )
    const tasksChanged = await reconcileStore(
      tasksDir(),
      taskRows,
      taskMap,
      guardedImportTask,
      lastSyncAt,
      skewMs
    )
    if (tasksChanged > 0) notifyDataChanged() // Tasks refresh (fire per stage, so a later failure never hides done work)

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
      lastSyncAt,
      skewMs
    )
    if (eventsChanged > 0) notifyEventsChanged() // the calendar re-reads live

    const callRows = await fetchAllRows(client, 'backup_calls', userId)
    const callMap = new Map((await listCallsForBackup(callsDir())).map((c) => [c.id, c]))
    const callsChanged = await reconcileStore(
      callsDir(),
      callRows,
      callMap,
      guardedImportCall,
      lastSyncAt,
      skewMs
    )
    if (callsChanged > 0) notifyDataChanged() // Past Calls refresh

    // Optional categories (Settings → Privacy & data toggles) — same isolation
    // discipline as the push side: a missing table/bucket must never fail the
    // core restore above.
    const syncScope = loadAppSettings().syncScope
    // BUG-157 — Rise conversations, restored before the rest for no reason
    // other than keeping this block next to nothing that depends on it.
    if (syncScope.riseConversations) {
      try {
        const dir = assistantConversationsDir(app.getPath('userData'))
        const convRows = await fetchAllRows(client, 'backup_rise_conversations', userId)
        const localMetas = await listConversations(dir)
        const convMap = new Map(
          localMetas.map((m) => [m.id, { id: m.id, updatedAt: m.updatedAt }])
        )
        const convChanged = await reconcileStore(
          dir,
          convRows,
          convMap,
          (d, payload) => importConversation(d, payload, { onlyIfNewer: true }),
          lastSyncAt,
          skewMs
        )
        if (convChanged > 0) notifyDataChanged()
      } catch (err) {
        console.error('[backup] rise conversations restore failed:', err)
        reportBackupStep('riseConversationsRestore', err)
      }
    }
    if (syncScope.knowledgeBase) {
      try {
        const knowledgeRows = await fetchAllRows(client, 'backup_knowledge', userId)
        const knowledgeMap = new Map(
          (await listEntries(knowledgeDir(), { includeDeleted: true })).map((e) => [e.id, e])
        )
        const knowledgeChanged = await reconcileStore(
          knowledgeDir(),
          knowledgeRows,
          knowledgeMap,
          guardedImportEntry,
          lastSyncAt,
          skewMs
        )
        if (knowledgeChanged > 0) notifyDataChanged() // Knowledge Base refresh
      } catch (err) {
        console.error('[backup] knowledge-base pull failed:', err)
        reportBackupStep('knowledgePull', err)
      }
    }
    // BUG-189 — the objection review queue, under the transcripts toggle
    // (see the push side for why it has no toggle of its own).
    if (syncScope.transcripts) {
      try {
        const queueRows = await fetchAllRows(client, 'backup_objection_queue', userId)
        const queueMap = new Map(
          (await listObjectionQueue(objectionQueueDir(), { includeDeleted: true })).map((i) => [
            i.id,
            i
          ])
        )
        const queueChanged = await reconcileStore(
          objectionQueueDir(),
          queueRows,
          queueMap,
          (d, payload) => importObjectionQueueItem(d, payload, { onlyIfNewer: true }),
          lastSyncAt,
          skewMs
        )
        if (queueChanged > 0) notifyDataChanged()
      } catch (err) {
        console.error('[backup] objection queue restore failed:', err)
        reportBackupStep('objectionQueueRestore', err)
      }
    }
    if (syncScope.settingsPersonalization) {
      try {
        const { data, error } = await client
          .from('backup_settings')
          .select('updated_at,server_updated_at,payload')
          .eq('user_id', userId)
          .maybeSingle()
        if (error) throw new Error(error.message)
        const local = loadAppSettings()
        // Compared on the server's clock (server_updated_at), not the pushing
        // device's own updated_at — see backup-core.ts's reconcileStore for why.
        // The local side is lifted onto the server's timeline first, so a skewed
        // device clock can't make stale settings look newer than the cloud's.
        if (data && ts(data.server_updated_at) > toServerMs(local.settingsUpdatedAt, skewMs)) {
          // Keeps the cloud row's timestamp (no restamp → no multi-device
          // ping-pong) and this device's own syncScope (privacy toggles are
          // per-device, never switched on remotely). The stamp is converted
          // onto THIS device's clock first: the uploaded updated_at is already
          // server-normalised, so storing it raw would leave a server timestamp
          // in a local field that every later push/compare treats as device
          // time — subtracting the skew a second time.
          applyPulledSettings(data.payload, toDeviceIso(data.updated_at as string, skewMs))
        }
      } catch (err) {
        console.error('[backup] settings pull failed:', err)
        reportBackupStep('settingsPull', err)
      }
    }
    if (syncScope.attachments) {
      try {
        const currentCalls = await listCallsForBackup(callsDir())
        await downloadMissingAttachments(client, userId, currentCalls)
      } catch (err) {
        console.error('[backup] attachment download failed:', err)
        reportBackupStep('attachmentDownload', err)
      }
    }
    if (syncScope.salesBrain) {
      try {
        await downloadSalesBrainDb(client, userId)
      } catch (err) {
        console.error('[backup] Sales Brain DB download failed:', err)
        reportBackupStep('salesBrainDownload', err)
      }
    }
    if (syncScope.contacts) {
      try {
        const contactRows = await fetchAllRows(client, 'backup_contacts', userId)
        const contactMap = new Map(
          (await listContacts(contactsDir(), { includeDeleted: true })).map((c) => [c.id, c])
        )
        const contactsChanged = await reconcileStore(
          contactsDir(),
          contactRows,
          contactMap,
          guardedImportContact,
          lastSyncAt,
          skewMs
        )
        if (contactsChanged > 0) notifyDataChanged() // Contacts refresh
      } catch (err) {
        console.error('[backup] contacts pull failed:', err)
        reportBackupStep('contactsPull', err)
      }
      // Stage list BEFORE deals, so restored deals point at stages that exist.
      try {
        const { data, error } = await client
          .from('backup_deal_stages')
          .select('updated_at,server_updated_at,payload')
          .eq('user_id', userId)
          .maybeSingle()
        if (error) throw new Error(error.message)
        const local = loadDealStagesMeta()
        // Same server-clock comparison as backup_settings above — including
        // lifting the local side onto the server timeline. This one was missed
        // in the first pass and still compared server time against a raw device
        // stamp, which is precisely the bug being fixed.
        if (data && ts(data.server_updated_at) > toServerMs(local.updatedAt, skewMs)) {
          const payload = data.payload as { stages?: unknown } | null
          applyPulledDealStages(payload?.stages, toDeviceIso(data.updated_at as string, skewMs))
          notifyDataChanged() // pipeline board re-reads its columns
        }
      } catch (err) {
        console.error('[backup] deal-stages pull failed:', err)
        reportBackupStep('dealStagesPull', err)
      }
      try {
        const dealRows = await fetchAllRows(client, 'backup_deals', userId)
        const dealMap = new Map(
          (await listDeals(dealsDir(), { includeDeleted: true })).map((d) => [d.id, d])
        )
        const dealsChanged = await reconcileStore(
          dealsDir(),
          dealRows,
          dealMap,
          guardedImportDeal,
          lastSyncAt,
          skewMs
        )
        if (dealsChanged > 0) notifyDataChanged() // Deals refresh
      } catch (err) {
        console.error('[backup] deals pull failed:', err)
        reportBackupStep('dealsPull', err)
      }
    }

    await writeState({ lastPullError: undefined, lastPullErrorAt: undefined })
    return {
      ok: true,
      imported: { tasks: tasksChanged, events: eventsChanged, calls: callsChanged }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'pull-failed'
    await writeState({ lastPullError: msg, lastPullErrorAt: new Date().toISOString() })
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

/** Which half of a sync is currently running. A "sync" is really two very
 *  different operations back to back — pulling other devices' changes DOWN,
 *  then pushing this device's changes UP — and the Settings card used to show
 *  one undifferentiated "Syncing…" for both, so a rep watching a slow
 *  first-run restore couldn't tell it apart from a routine backup. */
export type SyncStage = 'restoring' | 'backing-up'

/** Full sync: pull + reconcile, then push. The lastSyncAt cursor (used for
 *  concurrent-edit conflict detection) only advances when BOTH succeeded, and
 *  is stamped with a time captured BEFORE the pull — a conservative cursor can
 *  only produce an extra .conflict copy, never a missed one.
 *
 *  `onStage` is observation only — it changes no behaviour and every
 *  automatic trigger omits it. */
export async function syncNow(
  onStage?: (stage: SyncStage) => void
): Promise<{ pull: RestoreResult; push: BackupResult }> {
  const startedAt = new Date().toISOString()
  onStage?.('restoring')
  const pull = await pullAll()
  onStage?.('backing-up')
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

  // A privacy toggle turned OFF locally → queue a durable cloud scrub of that
  // category (drained at the start of the next push, retried until done).
  setSyncScopeDisabledListener((keys) => queuePendingScrubs(expandDisabledScrubKeys(keys)))

  // M26 Phase 3 — the MANUAL "Sync now" button is a MAINTENANCE-lane job so
  // its progress is visible (and survives leaving Settings). Deliberately
  // NOT migrated: the three automatic syncNow triggers below (launch,
  // sign-in, every 10 minutes) and scheduleBackup()'s debounced push. Two
  // reasons — (a) they'd each mint a job entry on a timer and job history
  // is never pruned today, so a long-running app would accumulate them
  // forever; (b) they're already invisible-by-design background work, and
  // making them visible is Batch 5's "visibility for automatic operations"
  // question, not this adapter's.
  //
  // The executor still goes through enqueue(), the SAME single promise
  // chain every automatic trigger uses — that chain is what guarantees a
  // pull can never interleave with a push. Bypassing it here to "run the
  // job directly" would silently remove that guarantee for every automatic
  // trigger too, which is exactly the class of breakage the shared-code-
  // path audit exists to catch.
  getJobManager().registerType<Record<string, never>, string>({
    type: SYNC_JOB_TYPE,
    lane: 'MAINTENANCE',
    // M27 — cloud backup — Supabase upload, no AI provider, so AI quota pressure must never hold it.
    aiPurpose: NO_AI_PURPOSE,
    titleFor: () => 'Syncing with the cloud',
    // syncNow has no AbortSignal support, and adding one would mean
    // rewriting the push/pull internals — out of scope for an adapter.
    cancellable: false,
    executor: {
      kind: 'inline-async',
      run: async (_input, handle) => {
        // Honest about the wait: the chain may already be busy with an
        // automatic sync, and "Restoring…" would be a lie until it isn't.
        handle.reportProgress({
          mode: 'stages',
          stageLabel: 'Waiting for background sync to finish…'
        })
        const { pull, push } = await enqueue(() =>
          syncNow((stage) =>
            handle.reportProgress({
              mode: 'stages',
              stageLabel:
                stage === 'restoring'
                  ? 'Restoring changes from the cloud…'
                  : 'Backing up to the cloud…'
            })
          )
        )
        // Report WHICH half failed rather than a generic "sync failed" —
        // a broken restore (changes from another device missing) and a
        // broken backup (this device's changes not saved) mean completely
        // different things to the rep.
        if (!pull.ok) {
          throw Object.assign(new Error(`Restore failed: ${pull.error}`), { code: pull.error })
        }
        if (!push.ok) {
          throw Object.assign(new Error(`Backup failed: ${push.error}`), { code: push.error })
        }
        return 'Restored and backed up.'
      }
    }
  })

  // Manual triggers (the settings UI in a later step calls these).
  ipcMain.handle('backup:pushNow', () => enqueue(pushAll))
  ipcMain.handle('backup:syncNow', async (): Promise<{ ok: boolean; jobId?: string }> => {
    return { ok: true, jobId: startSyncJob() ?? undefined }
  })
  ipcMain.handle('backup:getStatus', async () => {
    const state = await readState()
    // BUG-216 — the pending list comes from the QUEUE FILE, not from whatever
    // the last drain happened to leave in state.
    //
    // pushAll returns at `if (!userId)` BEFORE drainPendingScrubs is reached,
    // so a signed-out user's scrub never runs and never writes state. Reading
    // state alone meant the card said nothing at all: the user asked for an
    // erase, signed out, and was shown "Backed up N minutes ago" forever while
    // their data sat in the account. Reading the queue is true whether or not
    // a push ever happens.
    const queued = await readPendingScrubs()
    return {
      ...state,
      pendingScrubs: queued,
      // Whether the queue CAN drain. A scrub needs a session, so signed out is
      // not "retrying" — it is stopped, and the card has to say a different
      // thing.
      signedIn: (await getSignedInUserId()) !== null,
      // Losing sides of two-device concurrent edits, kept as <id>.conflict —
      // surfaced in the Settings card so "kept" data isn't invisibly lost.
      conflictCount: await countConflictFiles(),
      // Non-blocking hint only: a badly wrong device clock no longer corrupts
      // backup ordering (that's corrected for), but it still makes every
      // locally-displayed time wrong, so it's worth telling the user.
      clockSkewWarning:
        typeof state.clockSkewMs === 'number' && Math.abs(state.clockSkewMs) > CLOCK_SKEW_WARN_MS
    }
  })
  ipcMain.handle('backup:revealConflicts', async () => {
    for (const dir of conflictDirs()) {
      try {
        const file = (await fs.readdir(dir)).find((f) => f.endsWith('.conflict'))
        if (file) {
          shell.showItemInFolder(join(dir, file))
          return { ok: true as const }
        }
      } catch {
        /* unreadable store dir — try the next one */
      }
    }
    return { ok: false as const }
  })

  getSupabaseClient()?.auth.onAuthStateChange((event, session) => {
    const uid = session?.user?.id
    // A fresh SIGN-IN is the restore moment (first run on a new machine pulls
    // everything back). Session restores are covered by the launch sync below.
    //
    // M26 Batch 5 — the ONE automatic sync that runs as a visible job. It is
    // rare (once per sign-in) and it is the slow one: on a new machine this
    // pulls down everything, and without visible progress it looks like the
    // app has hung. Exactly the case BUG-051's restore-vs-backup wording was
    // written for.
    if (event === 'SIGNED_IN' && uid) startSyncJob()
  })

  // Full sync shortly after launch (restore first, then push), then periodic.
  //
  // DELIBERATELY NOT JOBS, and not for the Batch 4 reason (unbounded history
  // — retention.ts's 500-job cap fixed that). The remaining objection is
  // noise: the 10-minute timer alone is ~144 jobs/day, which inside a
  // 500-entry cap would bury every genuinely interesting entry — a failed
  // coaching run, an interrupted import — under a wall of identical
  // "Syncing with the cloud" rows within a couple of days. These two are
  // routine heartbeats with no user decision attached, and "when did it last
  // sync / did it fail" is already answered directly by the Settings card
  // (lastSyncAt + the separate push/pull errors). Visibility here would cost
  // more than it delivers.
  //
  // They still share the SAME enqueue() chain as the job's executor, so a
  // heartbeat and a visible sync can never overlap.
  setTimeout(() => void enqueue(() => syncNow()), 3_000)
  setInterval(() => void enqueue(() => syncNow()), 10 * 60_000)
}
