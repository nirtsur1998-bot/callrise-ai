// Step 3 of the Objection Library milestone: a staging area between mining
// and the real library. Mirrors knowledge-fs.ts's one-JSON-file-per-record
// pattern.
//
// BUG-189 (2026-09-05) — the queue now SYNCS (backup_objection_queue, under the
// transcripts toggle: it holds the buyer's words verbatim), so approve/reject
// and a source call's deletion write a TOMBSTONE instead of unlinking the file:
// `{ id, callId, deleted: true, updatedAt }` with every quote dropped. Without
// one, a rejected candidate would come straight back from the cloud on the
// next pull — the exact caveat backup_rise_conversations carries. listQueue
// hides tombstones; the backup reads them with includeDeleted.
//
// WHY IT MAY SYNC AT ALL (the founder's condition): an item is mined from the
// SAVED call record — calls.ts's mineCallIntoQueue reads getCall() and feeds
// speechSegments(call.segments) to the miner — and applyConsentRetention has
// already stripped every other-party segment from a call whose consent does
// not permit recording them. The queue therefore cannot hold words the consent
// gate would strip. Measured on the founder's data before this shipped: 95 of
// 95 items from consented calls, 0 strip cases. Pinned by
// objection-queue-backup.test.ts.
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeJsonAtomic } from './atomic-write'
import type { MinedObjectionCandidate, MinedObjectionType } from './objection-mining'

export interface ObjectionQueueItem {
  id: string
  type: MinedObjectionType
  objectionQuote: string
  objectionSpeaker: number
  responseQuote: string
  responseSpeaker: number
  /** The model's suggestion, not a verified fact — carried through from mining. */
  recoveredWell: boolean
  judgmentNote: string
  /** Where this came from, so the reviewer can open the source call. */
  callId: string
  callTitle: string
  createdAt: string
  /** BUG-189 — bumped on tombstoning; equals createdAt for a live item. The
   *  backup's reconcile keys on it. Older files without one read as createdAt. */
  updatedAt: string
  /** BUG-189 — a rejected/approved item, or one whose source call was deleted.
   *  Quotes are dropped on the way in; the record exists only to propagate. */
  deleted?: true
}

const ID_RE = /^[A-Za-z0-9-]{1,64}$/
const MAX_QUOTE = 500
const MAX_NOTE = 500
const MAX_TITLE = 300
const TYPES = new Set<MinedObjectionType>([
  'price',
  'timing',
  'competitor',
  'approval',
  'trust',
  'other'
])

function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id)
}

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function speakerNum(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

function sanitizeItem(value: unknown): ObjectionQueueItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (!isSafeId(v.id)) return null
  if (typeof v.type !== 'string' || !TYPES.has(v.type as MinedObjectionType)) return null
  const deleted = v.deleted === true
  const objectionQuote = deleted ? '' : str(v.objectionQuote, MAX_QUOTE)
  const responseQuote = deleted ? '' : str(v.responseQuote, MAX_QUOTE)
  // A live item without both quotes is not an item; a tombstone never has them.
  if (!deleted && (!objectionQuote || !responseQuote)) return null
  const callId = str(v.callId, 128)
  if (!callId) return null
  const createdAt =
    typeof v.createdAt === 'string' && !Number.isNaN(Date.parse(v.createdAt))
      ? v.createdAt
      : new Date().toISOString()
  const updatedAt =
    typeof v.updatedAt === 'string' && !Number.isNaN(Date.parse(v.updatedAt))
      ? v.updatedAt
      : createdAt

  const item: ObjectionQueueItem = {
    id: v.id,
    type: v.type as MinedObjectionType,
    objectionQuote,
    objectionSpeaker: speakerNum(v.objectionSpeaker),
    responseQuote,
    responseSpeaker: speakerNum(v.responseSpeaker),
    recoveredWell: v.recoveredWell === true,
    // A tombstone keeps NO words — the note is model prose about the quotes.
    judgmentNote: deleted ? '' : str(v.judgmentNote, MAX_NOTE),
    callId,
    callTitle: deleted ? '' : str(v.callTitle, MAX_TITLE),
    createdAt,
    updatedAt
  }
  if (deleted) item.deleted = true
  return item
}

/** The tombstone a removed item leaves behind: identity and a timestamp, no
 *  words. `type` is kept only because the record shape requires one. */
function tombstoneOf(item: Pick<ObjectionQueueItem, 'id' | 'type' | 'callId' | 'createdAt'>): ObjectionQueueItem {
  return {
    id: item.id,
    type: item.type,
    objectionQuote: '',
    objectionSpeaker: 0,
    responseQuote: '',
    responseSpeaker: 0,
    recoveredWell: false,
    judgmentNote: '',
    callId: item.callId,
    callTitle: '',
    createdAt: item.createdAt,
    updatedAt: new Date().toISOString(),
    deleted: true
  }
}

/** Defensively re-validate candidates coming back over IPC from the renderer
 *  (they originated from mineObjections, but never trust a renderer payload
 *  blindly) before they're allowed onto disk. */
function sanitizeCandidate(value: unknown): MinedObjectionCandidate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  const objectionQuote = str(v.objectionQuote, MAX_QUOTE)
  const responseQuote = str(v.responseQuote, MAX_QUOTE)
  if (!objectionQuote || !responseQuote) return null
  return {
    type:
      typeof v.type === 'string' && TYPES.has(v.type as MinedObjectionType)
        ? (v.type as MinedObjectionType)
        : 'other',
    objectionQuote,
    objectionSpeaker: speakerNum(v.objectionSpeaker),
    objectionVerified: v.objectionVerified === true,
    responseQuote,
    responseSpeaker: speakerNum(v.responseSpeaker),
    responseVerified: v.responseVerified === true,
    recoveredWell: v.recoveredWell === true,
    judgmentNote: str(v.judgmentNote, MAX_NOTE)
  }
}

/** Dedupe key: same source call + same objection wording (case/whitespace
 *  insensitive) is the same suggestion, whatever id it was staged under. */
function dedupeKey(callId: string, objectionQuote: string): string {
  return `${callId}\n${objectionQuote.toLowerCase().replace(/\s+/g, ' ').trim()}`
}

export async function addToQueue(
  dir: string,
  candidates: unknown[],
  callId: string,
  callTitle: string
): Promise<ObjectionQueueItem[]> {
  await ensureDir(dir)
  // Belt-and-braces against double mining (auto-mine racing a scan, a re-run
  // after a cloud restore wiped the mined flag, …): a candidate whose quote is
  // already staged from the same call never lands in the queue twice.
  // Tombstones count too: an item the rep already rejected must not come back
  // because a re-mine (a cleared objectionsMined flag after a restore) proposed
  // the same words again. Their quotes are empty, so they never match a real
  // candidate here; the per-id dedupe below is what protects against that.
  const all = await listQueue(dir, { includeDeleted: true })
  const seen = new Set(all.filter((i) => !i.deleted).map((i) => dedupeKey(i.callId, i.objectionQuote)))
  const now = new Date().toISOString()
  const items: ObjectionQueueItem[] = []
  for (const raw of candidates) {
    const c = sanitizeCandidate(raw)
    // Only quotes verified against the transcript at mining time may enter
    // the queue — an ungrounded suggestion is worse than none.
    if (!c || !c.objectionVerified || !c.responseVerified) continue
    const key = dedupeKey(str(callId, 128), c.objectionQuote)
    if (seen.has(key)) continue
    seen.add(key)
    const item: ObjectionQueueItem = {
      id: randomUUID(),
      type: c.type,
      objectionQuote: c.objectionQuote,
      objectionSpeaker: c.objectionSpeaker,
      responseQuote: c.responseQuote,
      responseSpeaker: c.responseSpeaker,
      recoveredWell: c.recoveredWell,
      judgmentNote: c.judgmentNote,
      callId: str(callId, 128),
      callTitle: str(callTitle, MAX_TITLE),
      createdAt: now,
      updatedAt: now
    }
    await writeJsonAtomic(join(dir, `${item.id}.json`), item)
    items.push(item)
  }
  return items
}

export async function listQueue(
  dir: string,
  opts?: { includeDeleted?: boolean }
): Promise<ObjectionQueueItem[]> {
  await ensureDir(dir)
  let files: string[]
  try {
    files = await fs.readdir(dir)
  } catch {
    return []
  }
  const results = await Promise.all(
    files
      .filter((file) => file.endsWith('.json'))
      .map(async (file): Promise<ObjectionQueueItem | null> => {
        try {
          const raw = await fs.readFile(join(dir, file), 'utf8')
          return sanitizeItem(JSON.parse(raw))
        } catch {
          return null // skip unreadable / corrupt file
        }
      })
  )
  const items = results.filter(
    (i): i is ObjectionQueueItem => i !== null && (opts?.includeDeleted === true || !i.deleted)
  )
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return items
}

/**
 * BUG-189 — a record arriving from the cloud backup. Same contract as
 * importEntry/importConversation: sanitized through the one record parser,
 * `onlyIfNewer` keeps a local copy that is same-or-newer (the reconcile has
 * already decided on the server's clock; this is the on-disk re-check). A
 * tombstone imports as a tombstone — that is how a rejection on one machine
 * reaches the other.
 */
export async function importQueueItem(
  dir: string,
  payload: unknown,
  opts?: { onlyIfNewer?: boolean }
): Promise<ObjectionQueueItem | null> {
  const item = sanitizeItem(payload)
  if (!item) return null
  await ensureDir(dir)
  if (opts?.onlyIfNewer) {
    const existing = await getQueueItem(dir, item.id, { includeDeleted: true })
    if (existing && Date.parse(existing.updatedAt) >= Date.parse(item.updatedAt)) return existing
  }
  await writeJsonAtomic(join(dir, `${item.id}.json`), item)
  return item
}

export async function getQueueItem(
  dir: string,
  id: string,
  opts?: { includeDeleted?: boolean }
): Promise<ObjectionQueueItem | null> {
  if (!isSafeId(id)) return null
  try {
    const raw = await fs.readFile(join(dir, `${id}.json`), 'utf8')
    const item = sanitizeItem(JSON.parse(raw))
    if (item?.deleted && !opts?.includeDeleted) return null
    return item
  } catch {
    return null
  }
}

/** Tombstone every staged item mined from one call. Mirrors deleteCall's
 *  privacy guarantee: a deleted call must not retain buyer words anywhere on
 *  disk — the tombstone keeps the id and callId and drops every quote, and
 *  (BUG-189) carries the deletion to the other machine through the backup. */
export async function purgeQueueForCall(dir: string, callId: string): Promise<number> {
  const items = await listQueue(dir)
  let purged = 0
  for (const item of items) {
    if (item.callId !== callId) continue
    try {
      await writeJsonAtomic(join(dir, `${item.id}.json`), tombstoneOf(item))
      purged++
    } catch {
      /* best-effort: an unreadable file was already skipped by listQueue */
    }
  }
  return purged
}

/** Approve/reject. A tombstone, not an unlink — see the file header. */
export async function removeFromQueue(dir: string, id: string): Promise<{ ok: boolean }> {
  if (!isSafeId(id)) return { ok: false }
  const item = await getQueueItem(dir, id)
  if (!item) return { ok: false }
  try {
    await writeJsonAtomic(join(dir, `${id}.json`), tombstoneOf(item))
  } catch {
    return { ok: false }
  }
  return { ok: true }
}
