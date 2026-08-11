import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeJsonAtomic } from './atomic-write'

export type KnowledgeCategory = 'objection' | 'product' | 'playbook'

interface KnowledgeEntryBase {
  id: string
  category: KnowledgeCategory
  createdAt: string // ISO timestamp
  /** Last modification (create or any edit), ISO timestamp — the ordering key a
   *  future cloud backup would use for "newest wins". Backfilled from createdAt
   *  for entries saved before this field existed. */
  updatedAt: string
  /** Tombstone: a deleted entry is kept (not erased) so the deletion can
   *  propagate to a future cloud backup. Hidden from every normal listing. */
  deleted?: boolean
}

/** Objection-handling script: what the buyer says, and how I respond. */
export interface ObjectionEntry extends KnowledgeEntryBase {
  category: 'objection'
  trigger: string
  response: string
}

/** A free-text section: product info ("what I offer / don't offer") or a
 *  playbook section (process, pitch, discovery questions, positioning). */
export interface TextEntry extends KnowledgeEntryBase {
  category: 'product' | 'playbook'
  title: string
  body: string
}

export type KnowledgeEntry = ObjectionEntry | TextEntry

export interface KnowledgeCreateInput {
  category?: unknown
  trigger?: unknown
  response?: unknown
  title?: unknown
  body?: unknown
}

/** Fields the renderer may change. Only present keys are touched. */
export interface KnowledgeUpdateInput {
  trigger?: unknown
  response?: unknown
  title?: unknown
  body?: unknown
}

// Ids are used to build file paths, so they must be tightly constrained
// (no "../", no slashes) to prevent path traversal.
const ID_RE = /^[A-Za-z0-9-]{1,64}$/
const MAX_TRIGGER = 300
const MAX_RESPONSE = 3000
const MAX_TITLE = 200
const MAX_BODY = 20000

const CATEGORIES = new Set<KnowledgeCategory>(['objection', 'product', 'playbook'])

export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id)
}

function sanitizeCategory(value: unknown): KnowledgeCategory | null {
  return typeof value === 'string' && CATEGORIES.has(value as KnowledgeCategory)
    ? (value as KnowledgeCategory)
    : null
}

/** Trim and bound a free-text string (newlines preserved for multi-line bodies). */
function sanitizeText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, max)
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

async function writeEntry(dir: string, entry: KnowledgeEntry): Promise<void> {
  await writeJsonAtomic(join(dir, `${entry.id}.json`), entry)
}

/** Coerce an untrusted parsed object into a clean KnowledgeEntry, or null if unusable. */
function sanitizeEntryRecord(value: unknown): KnowledgeEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (!isSafeId(v.id)) return null
  const category = sanitizeCategory(v.category)
  if (!category) return null

  const createdAt =
    typeof v.createdAt === 'string' && !Number.isNaN(Date.parse(v.createdAt))
      ? v.createdAt
      : new Date().toISOString()
  // Preserve updatedAt across the read/write round-trip; backfill from createdAt
  // for entries written before this field existed.
  const updatedAt =
    typeof v.updatedAt === 'string' && !Number.isNaN(Date.parse(v.updatedAt))
      ? v.updatedAt
      : createdAt
  const deleted = v.deleted === true ? true : undefined

  if (category === 'objection') {
    const trigger = sanitizeText(v.trigger, MAX_TRIGGER)
    const response = sanitizeText(v.response, MAX_RESPONSE)
    if (!trigger && !response) return null
    return { id: v.id, category, trigger, response, createdAt, updatedAt, deleted }
  }

  const title = sanitizeText(v.title, MAX_TITLE)
  const body = sanitizeText(v.body, MAX_BODY)
  if (!title && !body) return null
  return { id: v.id, category, title, body, createdAt, updatedAt, deleted }
}

export async function createEntry(
  dir: string,
  input: KnowledgeCreateInput
): Promise<KnowledgeEntry | null> {
  const category = sanitizeCategory(input?.category)
  if (!category) return null
  await ensureDir(dir)
  const now = new Date().toISOString()
  const base = { id: randomUUID(), createdAt: now, updatedAt: now }

  const entry: KnowledgeEntry =
    category === 'objection'
      ? {
          ...base,
          category,
          trigger: sanitizeText(input?.trigger, MAX_TRIGGER),
          response: sanitizeText(input?.response, MAX_RESPONSE)
        }
      : {
          ...base,
          category,
          title: sanitizeText(input?.title, MAX_TITLE),
          body: sanitizeText(input?.body, MAX_BODY)
        }

  await writeEntry(dir, entry)
  return entry
}

export async function listEntries(
  dir: string,
  opts?: { includeDeleted?: boolean }
): Promise<KnowledgeEntry[]> {
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
      .map(async (file): Promise<KnowledgeEntry | null> => {
        try {
          const raw = await fs.readFile(join(dir, file), 'utf8')
          const entry = sanitizeEntryRecord(JSON.parse(raw))
          // Tombstones stay hidden from the app; a future backup reads them via includeDeleted.
          return entry && (opts?.includeDeleted || !entry.deleted) ? entry : null
        } catch {
          return null // skip unreadable / corrupt file
        }
      })
  )
  const entries = results.filter((e): e is KnowledgeEntry => e !== null)
  // Newest first as a stable default; the renderer applies its own ordering.
  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return entries
}

export async function getEntry(dir: string, id: string): Promise<KnowledgeEntry | null> {
  if (!isSafeId(id)) return null
  try {
    const raw = await fs.readFile(join(dir, `${id}.json`), 'utf8')
    const entry = sanitizeEntryRecord(JSON.parse(raw))
    return entry && !entry.deleted ? entry : null // a tombstone reads as "gone"
  } catch {
    return null
  }
}

// ── Per-entry write lock ─────────────────────────────────────────────────────
// updateEntry/deleteEntry are read-then-write (getEntry → mutate → writeEntry),
// so two concurrent IPC calls for the SAME entry id could each read the old
// record and the second write would silently drop the first's changes. This
// chains all mutations for a given id so each one runs after the previous
// settles. (Deliberately duplicated from tasks-fs.ts to keep this file
// self-contained.)
const entryLocks = new Map<string, Promise<unknown>>()

function withEntryLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = entryLocks.get(id) ?? Promise.resolve()
  const result = prev.then(fn, fn) // run after prev settles, regardless of its outcome
  const gate = result.then(
    () => {},
    () => {}
  )
  entryLocks.set(id, gate)
  void gate.finally(() => {
    if (entryLocks.get(id) === gate) entryLocks.delete(id) // drop only if we're still the tail
  })
  return result
}

export function updateEntry(
  dir: string,
  id: string,
  patch: KnowledgeUpdateInput
): Promise<KnowledgeEntry | null> {
  if (!isSafeId(id)) return Promise.resolve(null)
  return withEntryLock(id, () => updateEntryUnlocked(dir, id, patch))
}

async function updateEntryUnlocked(
  dir: string,
  id: string,
  patch: KnowledgeUpdateInput
): Promise<KnowledgeEntry | null> {
  const entry = await getEntry(dir, id)
  if (!entry) return null
  if (!patch || typeof patch !== 'object') return entry

  if (entry.category === 'objection') {
    if ('trigger' in patch) entry.trigger = sanitizeText(patch.trigger, MAX_TRIGGER)
    if ('response' in patch) entry.response = sanitizeText(patch.response, MAX_RESPONSE)
  } else {
    if ('title' in patch) entry.title = sanitizeText(patch.title, MAX_TITLE)
    if ('body' in patch) entry.body = sanitizeText(patch.body, MAX_BODY)
  }

  entry.updatedAt = new Date().toISOString() // mark modified (future backup ordering key)

  try {
    await writeEntry(dir, entry)
  } catch {
    return null
  }
  return entry
}

export function deleteEntry(dir: string, id: string): Promise<{ ok: boolean }> {
  if (!isSafeId(id)) return Promise.resolve({ ok: false })
  return withEntryLock(id, () => deleteEntryUnlocked(dir, id))
}

async function deleteEntryUnlocked(dir: string, id: string): Promise<{ ok: boolean }> {
  const entry = await getEntry(dir, id)
  if (!entry) return { ok: false } // missing or already a tombstone
  // Tombstone instead of erase, so the deletion can propagate to a future backup.
  entry.deleted = true
  entry.updatedAt = new Date().toISOString()
  try {
    await writeEntry(dir, entry)
  } catch {
    return { ok: false }
  }
  return { ok: true }
}

/**
 * ID-PRESERVING importer for cloud-backup restore, mirroring importTask in
 * tasks-fs.ts. Keeps the original id (idempotent re-pulls), re-sanitizes
 * fully (a tampered cloud payload can't plant an unsafe id/path or malformed
 * fields), and — with `onlyIfNewer` — re-reads the CURRENT on-disk record at
 * write time so a local edit/delete landing mid-restore can't be clobbered.
 */
export async function importEntry(
  dir: string,
  payload: unknown,
  opts?: { onlyIfNewer?: boolean }
): Promise<KnowledgeEntry | null> {
  const entry = sanitizeEntryRecord(payload)
  if (!entry) return null
  if (opts?.onlyIfNewer) {
    try {
      const raw = await fs.readFile(join(dir, `${entry.id}.json`), 'utf8')
      const current = sanitizeEntryRecord(JSON.parse(raw))
      if (current && Date.parse(current.updatedAt) >= Date.parse(entry.updatedAt)) return null
    } catch {
      /* no current record (or unreadable) — proceed with the import */
    }
  }
  await ensureDir(dir)
  try {
    await writeEntry(dir, entry)
  } catch {
    return null
  }
  return entry
}
