import { promises as fs, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeJsonAtomic } from './atomic-write'
import type { DealRiskAssessment, DealRiskLevel, DealRiskReason } from './deal-risk'

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
  /** Phase 5 Step 1 — the last AI risk assessment run on this deal, if any.
   *  Manually triggered, cached until re-run (never auto-computed). */
  riskAssessment?: DealRiskAssessment
  /** Every PAST risk assessment, oldest first — pushed here right before
   *  `riskAssessment` above gets overwritten with a fresh one, so re-running
   *  the assessment builds a timeline instead of losing the previous read.
   *  Capped at MAX_RISK_HISTORY entries. */
  riskAssessmentHistory?: DealRiskAssessment[]
  /** Tombstone: a deleted deal is kept (not erased) so the deletion can
   *  propagate to a future cloud backup. Hidden from every normal listing. */
  deleted?: boolean
  /** Every past stage transition, oldest first (current stageId isn't
   *  duplicated as the last entry) — powers the contact-timeline feature.
   *  Absent/empty on deals that haven't changed stage since this was added. */
  stageHistory?: { stageId: string; changedAt: string }[]
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

/** Like sanitizeOptionalText but PRESERVES newlines — for the multi-line
 *  notes textarea. Collapsing newlines silently flattened users' notes into
 *  one run-on line on every save AND read. Normalizes CRLF, caps blank runs. */
function sanitizeMultilineText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
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

const RISK_LEVELS = new Set<DealRiskLevel>(['low', 'medium', 'high'])
const MAX_REASONS = 4

function sanitizeRiskReasons(value: unknown): DealRiskReason[] {
  if (!Array.isArray(value)) return []
  const reasons: DealRiskReason[] = []
  for (const r of value.slice(0, MAX_REASONS)) {
    if (!r || typeof r !== 'object') continue
    const rr = r as Record<string, unknown>
    const text = sanitizeOptionalText(rr.text, 300)
    if (!text) continue
    const callId = isSafeId(rr.callId) ? rr.callId : undefined
    const callTitle = callId ? sanitizeOptionalText(rr.callTitle, 300) : undefined
    reasons.push({ text, callId, callTitle })
  }
  return reasons
}

/** Coerce an untrusted parsed object into a clean assessment, or undefined —
 *  re-run when the deal changes, this just guards against a corrupted file. */
function sanitizeRiskAssessment(value: unknown): DealRiskAssessment | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const level =
    typeof v.level === 'string' && RISK_LEVELS.has(v.level as DealRiskLevel)
      ? (v.level as DealRiskLevel)
      : undefined
  const summary = sanitizeOptionalText(v.summary, 300)
  const suggestedAction = sanitizeOptionalText(v.suggestedAction, 300)
  if (!level || !summary || !suggestedAction) return undefined
  const createdAt =
    typeof v.createdAt === 'string' && !Number.isNaN(Date.parse(v.createdAt))
      ? v.createdAt
      : new Date().toISOString()
  return {
    level,
    summary,
    reasons: sanitizeRiskReasons(v.reasons),
    suggestedAction,
    model: sanitizeOptionalText(v.model, 100) ?? 'unknown',
    createdAt
  }
}

const MAX_RISK_HISTORY = 20

function sanitizeRiskAssessmentHistory(value: unknown): DealRiskAssessment[] | undefined {
  if (!Array.isArray(value)) return undefined
  const clean = value
    .map((v) => sanitizeRiskAssessment(v))
    .filter((v): v is DealRiskAssessment => v !== undefined)
    .slice(-MAX_RISK_HISTORY)
  return clean.length ? clean : undefined
}

const MAX_STAGE_HISTORY = 200

/** Every past stage transition survives a disk round-trip only if this reads
 *  it back — without it, sanitizeDealRecord silently drops the field on every
 *  load, so `updateDealUnlocked`'s getDeal() always sees an empty history and
 *  each new transition overwrites the last instead of appending to it. */
function sanitizeStageHistory(
  value: unknown
): { stageId: string; changedAt: string }[] | undefined {
  if (!Array.isArray(value)) return undefined
  const clean: { stageId: string; changedAt: string }[] = []
  for (const item of value.slice(-MAX_STAGE_HISTORY)) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    if (!isSafeId(r.stageId)) continue
    if (typeof r.changedAt !== 'string' || Number.isNaN(Date.parse(r.changedAt))) continue
    clean.push({ stageId: r.stageId, changedAt: r.changedAt })
  }
  return clean.length ? clean : undefined
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
    notes: sanitizeMultilineText(v.notes, MAX_NOTES),
    createdAt,
    updatedAt,
    riskAssessment: sanitizeRiskAssessment(v.riskAssessment),
    riskAssessmentHistory: sanitizeRiskAssessmentHistory(v.riskAssessmentHistory),
    stageHistory: sanitizeStageHistory(v.stageHistory),
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
    notes: sanitizeMultilineText(input?.notes, MAX_NOTES),
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

/**
 * ID-PRESERVING importer for cloud-backup restore, mirroring importContact in
 * contacts-fs.ts. Keeps the original id (idempotent re-pulls), re-sanitizes
 * fully (a tampered cloud payload can't plant an unsafe id/path or malformed
 * fields), runs under the per-deal lock, and — with `onlyIfNewer` — re-reads
 * the CURRENT on-disk record at write time so a local edit/delete landing
 * mid-restore can't be clobbered.
 */
export async function importDeal(
  dir: string,
  payload: unknown,
  opts?: { onlyIfNewer?: boolean }
): Promise<Deal | null> {
  const deal = sanitizeDealRecord(payload)
  if (!deal) return null
  return withDealLock(deal.id, async () => {
    if (opts?.onlyIfNewer) {
      try {
        const raw = await fs.readFile(join(dir, `${deal.id}.json`), 'utf8')
        const current = sanitizeDealRecord(JSON.parse(raw))
        if (current && Date.parse(current.updatedAt) >= Date.parse(deal.updatedAt)) return null
      } catch {
        /* no current record (or unreadable) — proceed with the import */
      }
    }
    await ensureDir(dir)
    try {
      await writeDeal(dir, deal)
    } catch {
      return null
    }
    return deal
  })
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
  if ('stageId' in patch && isSafeId(patch.stageId) && patch.stageId !== deal.stageId) {
    deal.stageHistory = [
      ...(deal.stageHistory ?? []),
      { stageId: deal.stageId, changedAt: new Date().toISOString() }
    ]
    deal.stageId = patch.stageId
  }
  if ('value' in patch) deal.value = sanitizeValue(patch.value)
  if ('expectedCloseDate' in patch)
    deal.expectedCloseDate = sanitizeDateOnly(patch.expectedCloseDate)
  if ('notes' in patch) deal.notes = sanitizeMultilineText(patch.notes, MAX_NOTES)

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

/** Save a fresh AI risk assessment onto a deal (Phase 5 Step 1) — replaces
 *  any previous one; cached until the next manual re-run. */
export function setDealRiskAssessment(
  dir: string,
  id: string,
  assessment: DealRiskAssessment
): Promise<Deal | null> {
  return withDealLock(id, () => setDealRiskAssessmentUnlocked(dir, id, assessment))
}

async function setDealRiskAssessmentUnlocked(
  dir: string,
  id: string,
  assessment: DealRiskAssessment
): Promise<Deal | null> {
  const deal = await getDeal(dir, id)
  if (!deal) return null
  const clean = sanitizeRiskAssessment(assessment)
  if (!clean) return null
  if (deal.riskAssessment) {
    deal.riskAssessmentHistory = [...(deal.riskAssessmentHistory ?? []), deal.riskAssessment].slice(
      -MAX_RISK_HISTORY
    )
  }
  deal.riskAssessment = clean
  deal.updatedAt = new Date().toISOString()
  try {
    await writeDeal(dir, deal)
  } catch {
    return null
  }
  return deal
}
