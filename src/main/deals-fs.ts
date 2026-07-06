import { promises as fs, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeJsonAtomic } from './atomic-write'

/** A saved deal (what's stored on disk: one JSON file per deal). Company is
 *  deliberately NOT stored here — it's derived from the linked contact at
 *  display time, so it can never drift out of sync. */
export interface Deal {
  id: string
  title: string
  /** The contact this deal belongs to — required (every deal has one owner). */
  contactId: string
  /** References a DealStage.id from deal-stages.ts. */
  stageId: string
  /** Estimated value, a plain currency amount (no multi-currency yet). */
  value?: number
  /** Date-only ISO string (yyyy-mm-dd). */
  expectedCloseDate?: string
  notes?: string
  createdAt: string
  /** Last modification (create or edit); a future backup's "newest wins" key. */
  updatedAt: string
  /** Tombstone: a deleted deal is kept (not erased) so the deletion can
   *  propagate to a future cloud backup. Hidden from every normal listing. */
  deleted?: boolean
}

export interface DealCreateInput {
  title?: unknown
  contactId?: unknown
  stageId?: unknown
  value?: unknown
  expectedCloseDate?: unknown
  notes?: unknown
}

/** Fields the renderer may change. A key present with `null` clears that
 *  optional field; a key that's absent leaves the existing value untouched. */
export interface DealUpdateInput {
  title?: unknown
  contactId?: unknown
  stageId?: unknown
  value?: unknown
  expectedCloseDate?: unknown
  notes?: unknown
}

// Ids are used to build file paths, so they must be tightly constrained
// (no "../", no slashes) to prevent path traversal. Also used to validate
// referenced contactId/stageId shapes.
const ID_RE = /^[A-Za-z0-9-]{1,64}$/
const MAX_TITLE = 300
const MAX_NOTES = 2000
const MAX_VALUE = 1_000_000_000 // a generous ceiling against fat-finger/garbage input

export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id)
}

/** Trim, collapse newlines, and bound a free-text string. Empty -> undefined. */
function sanitizeOptionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, max)
  return clean ? clean : undefined
}

/** A non-negative currency amount, rounded to cents. Anything invalid -> undefined. */
function sanitizeValue(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.round(Math.min(n, MAX_VALUE) * 100) / 100
}

/** Accept a date-only ISO string (yyyy-mm-dd); anything unparseable becomes undefined. */
function sanitizeDateOnly(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const t = Date.parse(value)
  if (Number.isNaN(t)) return undefined
  return new Date(t).toISOString().slice(0, 10)
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

async function writeDeal(dir: string, deal: Deal): Promise<void> {
  await writeJsonAtomic(join(dir, `${deal.id}.json`), deal)
}

/** Coerce an untrusted parsed object into a clean Deal, or null if unusable. */
function sanitizeDealRecord(value: unknown): Deal | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (!isSafeId(v.id)) return null
  const title = sanitizeOptionalText(v.title, MAX_TITLE)
  if (!title) return null
  if (!isSafeId(v.contactId)) return null
  if (!isSafeId(v.stageId)) return null
  const createdAt =
    typeof v.createdAt === 'string' && !Number.isNaN(Date.parse(v.createdAt))
      ? v.createdAt
      : new Date().toISOString()
  const updatedAt =
    typeof v.updatedAt === 'string' && !Number.isNaN(Date.parse(v.updatedAt))
      ? v.updatedAt
      : createdAt
  return {
    id: v.id,
    title,
    contactId: v.contactId,
    stageId: v.stageId,
    value: sanitizeValue(v.value),
    expectedCloseDate: sanitizeDateOnly(v.expectedCloseDate),
    notes: sanitizeOptionalText(v.notes, MAX_NOTES),
    createdAt,
    updatedAt,
    deleted: v.deleted === true ? true : undefined
  }
}

/**
 * Create a deal. Returns null if title/contactId/stageId are missing or
 * malformed — the caller (deals.ts) is expected to have already validated
 * stageId against the current stage list before calling this.
 */
export async function createDeal(dir: string, input: DealCreateInput): Promise<Deal | null> {
  const title = sanitizeOptionalText(input?.title, MAX_TITLE)
  if (!title) return null
  if (!isSafeId(input?.contactId)) return null
  if (!isSafeId(input?.stageId)) return null
  await ensureDir(dir)
  const now = new Date().toISOString()
  const deal: Deal = {
    id: randomUUID(),
    title,
    contactId: input.contactId,
    stageId: input.stageId,
    value: sanitizeValue(input?.value),
    expectedCloseDate: sanitizeDateOnly(input?.expectedCloseDate),
    notes: sanitizeOptionalText(input?.notes, MAX_NOTES),
    createdAt: now,
    updatedAt: now
  }
  await writeDeal(dir, deal)
  return deal
}

export async function listDeals(dir: string, opts?: { includeDeleted?: boolean }): Promise<Deal[]> {
  await ensureDir(dir)
  let files: string[]
  try {
    files = await fs.readdir(dir)
  } catch {
    return []
  }
  const deals: Deal[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const raw = await fs.readFile(join(dir, file), 'utf8')
      const deal = sanitizeDealRecord(JSON.parse(raw))
      if (deal && (opts?.includeDeleted || !deal.deleted)) deals.push(deal)
    } catch {
      /* skip unreadable / corrupt file */
    }
  }
  // Newest first as a stable default; the pipeline board applies its own ordering.
  deals.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return deals
}

/**
 * SYNCHRONOUS scan used only by deal-stages.ts's "can't remove a stage that's
 * still in use" guard — stage edits are rare and the deal count is small, so
 * a blocking read here keeps that check simple (no async plumbing needed in
 * a synchronous settings-style module).
 */
export function listDealsUsingStage(dir: string, stageIds: string[]): Deal[] {
  const wanted = new Set(stageIds)
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return []
  }
  const matches: Deal[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const deal = sanitizeDealRecord(JSON.parse(readFileSync(join(dir, file), 'utf8')))
      if (deal && !deal.deleted && wanted.has(deal.stageId)) matches.push(deal)
    } catch {
      /* skip unreadable / corrupt file */
    }
  }
  return matches
}

export async function getDeal(dir: string, id: string): Promise<Deal | null> {
  if (!isSafeId(id)) return null
  try {
    const raw = await fs.readFile(join(dir, `${id}.json`), 'utf8')
    const deal = sanitizeDealRecord(JSON.parse(raw))
    return deal && !deal.deleted ? deal : null // a tombstone reads as "gone"
  } catch {
    return null
  }
}

// ── Per-deal write lock ───────────────────────────────────────────────────
const dealLocks = new Map<string, Promise<unknown>>()

function withDealLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = dealLocks.get(id) ?? Promise.resolve()
  const result = prev.then(fn, fn)
  const gate = result.then(
    () => {},
    () => {}
  )
  dealLocks.set(id, gate)
  void gate.finally(() => {
    if (dealLocks.get(id) === gate) dealLocks.delete(id)
  })
  return result
}

export function updateDeal(dir: string, id: string, patch: DealUpdateInput): Promise<Deal | null> {
  if (!isSafeId(id)) return Promise.resolve(null)
  return withDealLock(id, () => updateDealUnlocked(dir, id, patch))
}

async function updateDealUnlocked(
  dir: string,
  id: string,
  patch: DealUpdateInput
): Promise<Deal | null> {
  const deal = await getDeal(dir, id)
  if (!deal) return null
  if (!patch || typeof patch !== 'object') return deal

  if ('title' in patch) {
    const next = sanitizeOptionalText(patch.title, MAX_TITLE)
    if (next) deal.title = next // never blank out the title
  }
  if ('contactId' in patch && isSafeId(patch.contactId)) deal.contactId = patch.contactId
  if ('stageId' in patch && isSafeId(patch.stageId)) deal.stageId = patch.stageId
  if ('value' in patch) deal.value = sanitizeValue(patch.value)
  if ('expectedCloseDate' in patch)
    deal.expectedCloseDate = sanitizeDateOnly(patch.expectedCloseDate)
  if ('notes' in patch) deal.notes = sanitizeOptionalText(patch.notes, MAX_NOTES)

  deal.updatedAt = new Date().toISOString()

  try {
    await writeDeal(dir, deal)
  } catch {
    return null
  }
  return deal
}

export function deleteDeal(dir: string, id: string): Promise<{ ok: boolean }> {
  if (!isSafeId(id)) return Promise.resolve({ ok: false })
  return withDealLock(id, () => deleteDealUnlocked(dir, id))
}

async function deleteDealUnlocked(dir: string, id: string): Promise<{ ok: boolean }> {
  const deal = await getDeal(dir, id)
  if (!deal) return { ok: false }
  deal.deleted = true
  deal.updatedAt = new Date().toISOString()
  try {
    await writeDeal(dir, deal)
  } catch {
    return { ok: false }
  }
  return { ok: true }
}
