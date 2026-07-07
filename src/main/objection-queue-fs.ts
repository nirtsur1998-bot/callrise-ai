// Step 3 of the Objection Library milestone: a staging area between mining
// and the real library. Mirrors knowledge-fs.ts's one-JSON-file-per-record
// pattern, but items are transient — approve/reject removes the file
// entirely (no tombstone) since this is a working queue, not a permanent
// record like Knowledge/Calls/Tasks.
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
  const objectionQuote = str(v.objectionQuote, MAX_QUOTE)
  const responseQuote = str(v.responseQuote, MAX_QUOTE)
  if (!objectionQuote || !responseQuote) return null
  const callId = str(v.callId, 128)
  if (!callId) return null
  const createdAt =
    typeof v.createdAt === 'string' && !Number.isNaN(Date.parse(v.createdAt))
      ? v.createdAt
      : new Date().toISOString()

  return {
    id: v.id,
    type: v.type as MinedObjectionType,
    objectionQuote,
    objectionSpeaker: speakerNum(v.objectionSpeaker),
    responseQuote,
    responseSpeaker: speakerNum(v.responseSpeaker),
    recoveredWell: v.recoveredWell === true,
    judgmentNote: str(v.judgmentNote, MAX_NOTE),
    callId,
    callTitle: str(v.callTitle, MAX_TITLE),
    createdAt
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
  const seen = new Set((await listQueue(dir)).map((i) => dedupeKey(i.callId, i.objectionQuote)))
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
      createdAt: now
    }
    await writeJsonAtomic(join(dir, `${item.id}.json`), item)
    items.push(item)
  }
  return items
}

export async function listQueue(dir: string): Promise<ObjectionQueueItem[]> {
  await ensureDir(dir)
  let files: string[]
  try {
    files = await fs.readdir(dir)
  } catch {
    return []
  }
  const items: ObjectionQueueItem[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const raw = await fs.readFile(join(dir, file), 'utf8')
      const item = sanitizeItem(JSON.parse(raw))
      if (item) items.push(item)
    } catch {
      /* skip unreadable / corrupt file */
    }
  }
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return items
}

export async function getQueueItem(dir: string, id: string): Promise<ObjectionQueueItem | null> {
  if (!isSafeId(id)) return null
  try {
    const raw = await fs.readFile(join(dir, `${id}.json`), 'utf8')
    return sanitizeItem(JSON.parse(raw))
  } catch {
    return null
  }
}

/** Delete every staged item mined from one call. Mirrors deleteCall's privacy
 *  guarantee: a deleted call must not retain buyer words anywhere on disk —
 *  the queue stores verbatim buyer quotes, so it must be purged with the call. */
export async function purgeQueueForCall(dir: string, callId: string): Promise<number> {
  const items = await listQueue(dir)
  let purged = 0
  for (const item of items) {
    if (item.callId !== callId) continue
    try {
      await fs.unlink(join(dir, `${item.id}.json`))
      purged++
    } catch {
      /* best-effort: an unreadable file was already skipped by listQueue */
    }
  }
  return purged
}

export async function removeFromQueue(dir: string, id: string): Promise<{ ok: boolean }> {
  if (!isSafeId(id)) return { ok: false }
  try {
    await fs.unlink(join(dir, `${id}.json`))
  } catch {
    return { ok: false }
  }
  return { ok: true }
}
