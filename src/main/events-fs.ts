import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { linkKey } from './google-sync'
import { writeJsonAtomic } from './atomic-write'

/** Lifecycle of a local event's mirror in Google (M14 two-way sync). */
export type SyncState =
  | 'local-only' // never pushed (sync off, or created while disconnected)
  | 'synced' // local matches Google as of lastPushedAt
  | 'dirty' // local changed since the last push; needs a re-push
  | 'deleted' // tombstone: file kept until Google confirms the delete
  | 'error' // last push failed for a non-transient reason (needs reconnect)

export interface EventSync {
  state: SyncState
  lastPushedAt?: string // ISO, when Google last confirmed the write
  lastError?: string // short code from the last failed attempt
}

/**
 * A calendar event stored on disk (one JSON file per event). Times are
 * absolute ISO instants so they're unambiguous across time zones. The
 * source stays 'local' even once mirrored to Google — the event is still
 * locally owned and editable; provider/externalId carry the Google link and
 * `sync` tracks the push lifecycle separately from user edits.
 */
export interface CalendarEvent {
  id: string
  title: string
  start: string // ISO datetime
  end: string // ISO datetime (always > start)
  allDay: boolean
  notes?: string
  source: 'local' // stays 'local' even once mirrored — see provider/externalId below
  provider?: string // linked calendar, e.g. 'google:you@gmail.com' or 'outlook:AAMk...'
  externalId?: string // the linked Google/Outlook event id
  /** The provider's own "last updated" timestamp at last sync — the echo-loop
   *  watermark (M14 step D). Whichever ONE provider this event is linked to
   *  (never both at once). */
  remoteUpdatedAt?: string
  sync?: EventSync // omitted = never synced (treated as local-only)
  /** Backup tombstone: a deleted event is kept (not erased) so the deletion can
   *  propagate to the cloud mirror. Distinct from sync.state='deleted', which is
   *  the TRANSIENT Google-delete state; this flag is the permanent record.
   *  Hidden from every normal listing. */
  deleted?: boolean
  /** The contact/deal this event is with, if linked from the New/Edit Event
   *  dialog — app-local metadata only, never pushed to Google/Outlook. Powers
   *  the follow-up dashboard's "next scheduled meeting" line. */
  contactId?: string
  dealId?: string
  createdAt: string
  updatedAt: string
}

/** Fields the renderer may send when creating an event. The optional link fields
 *  are set only when "adopting" a Google event (making it locally editable). */
export interface EventCreateInput {
  title?: unknown
  start?: unknown
  end?: unknown
  allDay?: unknown
  notes?: unknown
  provider?: unknown
  externalId?: unknown
  remoteUpdatedAt?: unknown
  contactId?: unknown
  dealId?: unknown
}

/** Fields the renderer may change (any absent key is left untouched). */
export interface EventUpdateInput {
  title?: unknown
  start?: unknown
  end?: unknown
  allDay?: unknown
  notes?: unknown
  contactId?: unknown
  dealId?: unknown
}

// Ids build file paths, so they must be tightly constrained (no "../", no
// slashes) to prevent path traversal.
const ID_RE = /^[A-Za-z0-9-]{1,64}$/
const MAX_TITLE = 300
const MAX_NOTES = 2000
const HOUR_MS = 60 * 60 * 1000

export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id)
}

/** Single-line text (titles): trim, collapse newlines, bound length. */
function sanitizeTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE)
  return clean ? clean : undefined
}

/** Multi-line text (notes): keep line breaks, just bound length. */
function sanitizeNotes(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value.trim().slice(0, MAX_NOTES)
  return clean ? clean : undefined
}

/** Parse an ISO-ish date string into a normalized ISO instant, or null. */
function toIso(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const t = Date.parse(value)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

/** Resolve a start/end pair into a valid, ordered window. */
function resolveWindow(
  startRaw: unknown,
  endRaw: unknown,
  fallbackStart: string
): { start: string; end: string } {
  const start = toIso(startRaw) ?? fallbackStart
  let end = toIso(endRaw)
  if (!end || Date.parse(end) <= Date.parse(start)) {
    end = new Date(Date.parse(start) + HOUR_MS).toISOString()
  }
  return { start, end }
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

async function writeEvent(dir: string, event: CalendarEvent): Promise<void> {
  await writeJsonAtomic(join(dir, `${event.id}.json`), event)
}

const SYNC_STATES: SyncState[] = ['local-only', 'synced', 'dirty', 'deleted', 'error']

/** Coerce an untrusted parsed sync sub-object into a clean EventSync, or undefined. */
function sanitizeSync(value: unknown): EventSync | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  if (typeof v.state !== 'string' || !SYNC_STATES.includes(v.state as SyncState)) return undefined
  return {
    state: v.state as SyncState,
    lastPushedAt: toIso(v.lastPushedAt) ?? undefined,
    lastError: typeof v.lastError === 'string' ? v.lastError.slice(0, 120) : undefined
  }
}

/** Coerce an untrusted parsed object into a clean CalendarEvent, or null. */
function sanitizeEventRecord(value: unknown): CalendarEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (!isSafeId(v.id)) return null
  const title = sanitizeTitle(v.title)
  if (!title) return null
  const now = new Date().toISOString()
  const { start, end } = resolveWindow(v.start, v.end, toIso(v.start) ?? now)
  const createdAt = toIso(v.createdAt) ?? now
  return {
    id: v.id,
    title,
    start,
    end,
    allDay: v.allDay === true,
    notes: sanitizeNotes(v.notes),
    source: 'local',
    provider: typeof v.provider === 'string' ? v.provider.slice(0, 200) : undefined,
    externalId: typeof v.externalId === 'string' ? v.externalId.slice(0, 200) : undefined,
    remoteUpdatedAt: toIso(v.remoteUpdatedAt) ?? undefined,
    sync: sanitizeSync(v.sync),
    deleted: v.deleted === true ? true : undefined, // preserve the tombstone flag
    contactId: isSafeId(v.contactId) ? v.contactId : undefined,
    dealId: isSafeId(v.dealId) ? v.dealId : undefined,
    createdAt,
    updatedAt: toIso(v.updatedAt) ?? createdAt
  }
}

function sanitizeLinkField(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value.slice(0, 200) : undefined
}

export async function createEvent(dir: string, input: EventCreateInput): Promise<CalendarEvent> {
  await ensureDir(dir)
  const now = new Date().toISOString()
  const { start, end } = resolveWindow(input?.start, input?.end, now)
  const event: CalendarEvent = {
    id: randomUUID(),
    title: sanitizeTitle(input?.title) ?? 'Untitled event',
    start,
    end,
    allDay: input?.allDay === true,
    notes: sanitizeNotes(input?.notes),
    source: 'local',
    // Present only when adopting a Google event — the link makes future edits
    // PATCH the same Google event and dedups the pulled copy.
    provider: sanitizeLinkField(input?.provider),
    externalId: sanitizeLinkField(input?.externalId),
    remoteUpdatedAt: toIso(input?.remoteUpdatedAt) ?? undefined,
    contactId: isSafeId(input?.contactId) ? input.contactId : undefined,
    dealId: isSafeId(input?.dealId) ? input.dealId : undefined,
    createdAt: now,
    updatedAt: now
  }
  await writeEvent(dir, event)
  return event
}

export async function listEvents(
  dir: string,
  opts?: { includeDeleted?: boolean }
): Promise<CalendarEvent[]> {
  await ensureDir(dir)
  let files: string[]
  try {
    files = await fs.readdir(dir)
  } catch {
    return []
  }
  const events: CalendarEvent[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const raw = await fs.readFile(join(dir, file), 'utf8')
      const event = sanitizeEventRecord(JSON.parse(raw))
      // Tombstones never render: sync.state='deleted' is the transient awaiting-
      // Google state, `deleted` is the permanent backup tombstone. The Google
      // reconcile pass and the backup read them via includeDeleted.
      const tombstoned = event?.sync?.state === 'deleted' || event?.deleted === true
      if (event && (opts?.includeDeleted || !tombstoned)) events.push(event)
    } catch {
      /* skip unreadable / corrupt file */
    }
  }
  events.sort((a, b) => a.start.localeCompare(b.start)) // earliest first
  return events
}

/** (provider, externalId) keys of locally-deleted events awaiting a confirmed
 *  Google delete. The Google read-sync uses these to hide their pulled mirror.
 *  Keyed on the PAIR (not externalId alone) so a delete on one calendar can't
 *  hide the same-id event on another. */
export async function listTombstonedKeys(dir: string): Promise<Set<string>> {
  const all = await listEvents(dir, { includeDeleted: true })
  const keys = new Set<string>()
  for (const e of all) {
    if (e.sync?.state === 'deleted' && e.provider && e.externalId) {
      keys.add(linkKey(e.provider, e.externalId))
    }
  }
  return keys
}

/** Raw read: returns the record even when it's a backup tombstone. */
async function readEventRecord(dir: string, id: string): Promise<CalendarEvent | null> {
  if (!isSafeId(id)) return null
  try {
    const raw = await fs.readFile(join(dir, `${id}.json`), 'utf8')
    return sanitizeEventRecord(JSON.parse(raw))
  } catch {
    return null
  }
}

export async function getEvent(dir: string, id: string): Promise<CalendarEvent | null> {
  const event = await readEventRecord(dir, id)
  return event && !event.deleted ? event : null // a backup tombstone reads as "gone"
}

export async function updateEvent(
  dir: string,
  id: string,
  patch: EventUpdateInput
): Promise<CalendarEvent | null> {
  const event = await getEvent(dir, id)
  if (!event) return null
  if (!patch || typeof patch !== 'object') return event

  if ('title' in patch) {
    const next = sanitizeTitle(patch.title)
    if (next) event.title = next // never blank out the title
  }
  if ('allDay' in patch) event.allDay = patch.allDay === true
  if ('notes' in patch) event.notes = sanitizeNotes(patch.notes)
  // Absent key = untouched; present-but-invalid (undefined/null/malformed) = unlinked.
  if ('contactId' in patch)
    event.contactId = isSafeId(patch.contactId) ? patch.contactId : undefined
  if ('dealId' in patch) event.dealId = isSafeId(patch.dealId) ? patch.dealId : undefined
  // Start/end are resolved together so the window always stays valid/ordered.
  if ('start' in patch || 'end' in patch) {
    const startRaw = 'start' in patch ? patch.start : event.start
    const endRaw = 'end' in patch ? patch.end : event.end
    const { start, end } = resolveWindow(startRaw, endRaw, event.start)
    event.start = start
    event.end = end
  }
  event.updatedAt = new Date().toISOString()

  try {
    await writeEvent(dir, event)
  } catch {
    return null
  }
  return event
}

/**
 * Attach/overwrite the Google link + sync state WITHOUT touching user fields or
 * `updatedAt` (a Google confirmation is never mistaken for a user edit) —
 * UNLESS `bumpUpdatedAt` is set, for state writes that ARE user actions (a
 * delete): the cloud backup's newest-wins needs a fresh timestamp to accept it.
 */
export async function setEventSync(
  dir: string,
  id: string,
  link: {
    provider?: string
    externalId?: string
    remoteUpdatedAt?: string
    sync: EventSync
    bumpUpdatedAt?: boolean
  }
): Promise<CalendarEvent | null> {
  const event = await getEvent(dir, id)
  if (!event) return null
  if (link.provider !== undefined) event.provider = link.provider
  if (link.externalId !== undefined) event.externalId = link.externalId
  if (link.remoteUpdatedAt !== undefined) event.remoteUpdatedAt = link.remoteUpdatedAt
  event.sync = link.sync
  if (link.bumpUpdatedAt) event.updatedAt = new Date().toISOString()
  try {
    await writeEvent(dir, event)
  } catch {
    return null
  }
  return event
}

/**
 * Convert an event into a permanent BACKUP tombstone (deleted=true), so the
 * deletion can propagate to the cloud mirror. Clears the Google link + sync
 * state (any Google-side delete has already been handled by the caller).
 * `updatedAt` defaults to now; a pull passes the cloud's timestamp instead so
 * applying a remote deletion doesn't look like a fresh local edit.
 */
export async function markEventDeleted(
  dir: string,
  id: string,
  opts?: { updatedAt?: string }
): Promise<{ ok: boolean }> {
  const event = await readEventRecord(dir, id) // raw: also works on tombstones
  if (!event) return { ok: false }
  event.deleted = true
  event.updatedAt = toIso(opts?.updatedAt) ?? new Date().toISOString()
  event.provider = undefined
  event.externalId = undefined
  event.remoteUpdatedAt = undefined
  event.sync = undefined
  try {
    await writeEvent(dir, event)
  } catch {
    return { ok: false }
  }
  return { ok: true }
}

/**
 * ID-PRESERVING importer for restore. Writes a cloud payload as a local event,
 * keeping its original id (so re-pulls are idempotent and can't duplicate) and
 * re-running the full sanitizer (so a tampered cloud payload can't plant an
 * unsafe id/path or malformed fields). NEVER used by normal create/update.
 *
 * `onlyIfNewer` re-reads the CURRENT on-disk record at write time and skips
 * unless the incoming version is strictly newer — so a user edit or delete that
 * lands while a restore is running can never be clobbered by stale cloud data.
 *
 * Cloud payloads carry NO Google-link fields (stripped at push — they're
 * machine-specific), so an import MERGES the existing record's link back in:
 * - content import onto a linked event keeps the link and marks it `dirty`, so
 *   the Google sync PATCHes the same Google event (never a duplicate insert);
 * - a cloud TOMBSTONE onto a still-linked event becomes the TRANSIENT Google
 *   tombstone (sync.state='deleted', link kept) so the Google copy is deleted
 *   too; unlinked events become plain backup tombstones.
 */
export async function importEvent(
  dir: string,
  payload: unknown,
  opts?: { onlyIfNewer?: boolean }
): Promise<CalendarEvent | null> {
  const event = sanitizeEventRecord(payload)
  if (!event) return null
  const current = await readEventRecord(dir, event.id) // raw: tombstones included
  if (
    opts?.onlyIfNewer &&
    current &&
    Date.parse(current.updatedAt) >= Date.parse(event.updatedAt)
  ) {
    return null
  }
  if (current) {
    // Preserve THIS machine's Google link — it's authoritative for the sync
    // STATE (the cloud payload carries the Google identity but never state).
    event.provider = current.provider
    event.externalId = current.externalId
    event.remoteUpdatedAt = current.remoteUpdatedAt
    event.sync = current.sync
  } else if (!event.deleted && event.externalId) {
    // FRESH machine restoring a Google-linked event: adopt the account-level
    // identity the payload carries and mark it 'synced', so (a) the pulled
    // green chip dedupes away instead of the event showing twice, and (b) an
    // edit here PATCHes the same Google event rather than inserting a copy.
    event.sync = { state: 'synced' }
  }
  if (event.deleted) {
    // Still linked = there is a Google copy to remove — INCLUDING a record whose
    // Google delete is already pending (sync.state='deleted'): downgrading that
    // to a plain tombstone would abandon the pending Google delete and leave the
    // event alive on Google. (A prior backup tombstone has no externalId after
    // the merge, so it stays on the plain branch.)
    // Requires a CURRENT local record: on a fresh machine, a linked tombstone
    // means the SOURCE machine already handled (or is handling) the Google
    // delete — importing it as another pending Google delete would race it.
    const stillLinked = Boolean(event.externalId) && !!current && current.deleted !== true
    if (stillLinked) {
      // Deleted elsewhere but linked HERE: route through the Google delete flow
      // (the M14 reconcile pass drains it), so the Google copy is removed too.
      event.deleted = undefined
      event.sync = { state: 'deleted' }
    } else {
      // Plain backup tombstone — mirror markEventDeleted's shape.
      event.provider = undefined
      event.externalId = undefined
      event.remoteUpdatedAt = undefined
      event.sync = undefined
    }
  } else if (current && current.sync?.state === 'deleted') {
    // Live content NEWER than a pending local delete → the edit wins: RESURRECT.
    // Keeping sync='deleted' here would let the Google drain delete the event and
    // then re-tombstone it with a fresh timestamp, destroying the newer edit on
    // every machine. Linked → 'dirty' (the drain re-PATCHes, or re-creates via
    // the 404 path if Google already deleted it); unlinked → plain local.
    event.sync = event.externalId ? { state: 'dirty' } : undefined
  } else if (current && event.externalId && current.sync?.state === 'synced') {
    // The restored content differs from what Google holds — mark dirty so the
    // Google sync re-PATCHes the SAME event (never inserts a duplicate).
    event.sync = { state: 'dirty' }
  }
  await ensureDir(dir)
  try {
    await writeEvent(dir, event)
  } catch {
    return null
  }
  return event
}
