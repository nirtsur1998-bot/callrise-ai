// The deal pipeline's configurable stage list — a small, separate JSON file
// (own file, not app-settings.ts) so it can evolve independently. Modeled on
// google.ts's sync-mode.json: plain JSON, synchronous I/O (tiny, rarely
// written), a safe default on any read failure.
import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { readFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { writeJsonAtomicSync } from './atomic-write'
import { listDealsUsingStage } from './deals-fs'
import { scheduleBackup } from './backup'

export type DealStageKind = 'open' | 'won' | 'lost'

export interface DealStage {
  id: string
  label: string
  /** 'won'/'lost' mark the pipeline's closed ends; only 'open' stages count
   *  as an active deal for the "open deal" surfacing elsewhere. */
  kind: DealStageKind
}

const MAX_LABEL = 60
const MAX_STAGES = 20
// Must match deals-fs.ts's ID_RE: a stage id that deals-fs would reject on
// createDeal/updateDeal (e.g. one with an underscore, from a hand-edited
// file) would show in the stage picker but silently fail every save into it.
const ID_RE = /^[A-Za-z0-9-]{1,64}$/

const DEFAULT_STAGES: DealStage[] = [
  { id: 'lead', label: 'Lead', kind: 'open' },
  { id: 'discovery', label: 'Discovery', kind: 'open' },
  { id: 'proposal', label: 'Proposal', kind: 'open' },
  { id: 'negotiating', label: 'Negotiating', kind: 'open' },
  { id: 'won', label: 'Won', kind: 'won' },
  { id: 'lost', label: 'Lost', kind: 'lost' }
]

function stagesPath(): string {
  return join(app.getPath('userData'), 'deal-stages.json')
}

function dealsDir(): string {
  return join(app.getPath('userData'), 'deals')
}

function sanitizeKind(value: unknown): DealStageKind {
  return value === 'won' || value === 'lost' ? value : 'open'
}

function sanitizeLabel(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, MAX_LABEL)
}

/** Coerce an untrusted parsed list into a clean stage list. May return an
 *  empty array — callers decide what "nothing usable came out of this"
 *  means for them: a disk read falls back to defaults (sanitizeStageList
 *  below), but a user-initiated setDealStages() needs to see the real empty
 *  result so it can reject the edit instead of silently substituting an
 *  unrelated default pipeline. */
function sanitizeStageListRaw(value: unknown): DealStage[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const stages: DealStage[] = []
  for (const raw of value.slice(0, MAX_STAGES)) {
    if (!raw || typeof raw !== 'object') continue
    const v = raw as Record<string, unknown>
    const label = sanitizeLabel(v.label)
    if (!label) continue
    const id = typeof v.id === 'string' && ID_RE.test(v.id) && !seen.has(v.id) ? v.id : randomUUID()
    seen.add(id)
    stages.push({ id, label, kind: sanitizeKind(v.kind) })
  }
  return stages
}

/** Same as sanitizeStageListRaw, but never returns an empty pipeline — the
 *  right behavior when reading a possibly-corrupt file or a cloud pull,
 *  where "nothing usable" must still leave the app with a working pipeline. */
function sanitizeStageList(value: unknown): DealStage[] {
  const clean = sanitizeStageListRaw(value)
  return clean.length ? clean : DEFAULT_STAGES
}

const EPOCH = '1970-01-01T00:00:00.000Z'

export function loadDealStages(): DealStage[] {
  return loadDealStagesMeta().stages
}

/** Stage list + its last-modified stamp — the "newest wins" key for the cloud
 *  backup's single-row stage sync. Files written before the stamp existed
 *  read as EPOCH (any cloud copy wins over an unstamped local default). */
export function loadDealStagesMeta(): { stages: DealStage[]; updatedAt: string } {
  try {
    const parsed = JSON.parse(readFileSync(stagesPath(), 'utf8'))
    const updatedAt =
      typeof parsed?.updatedAt === 'string' && !Number.isNaN(Date.parse(parsed.updatedAt))
        ? parsed.updatedAt
        : EPOCH
    return { stages: sanitizeStageList(parsed?.stages), updatedAt }
  } catch {
    return { stages: DEFAULT_STAGES, updatedAt: EPOCH }
  }
}

function writeStages(stages: DealStage[], updatedAt = new Date().toISOString()): void {
  mkdirSync(join(app.getPath('userData')), { recursive: true })
  // Atomic: a torn write here silently reset the pipeline to the default
  // stages on next launch, orphaning every deal sitting in a custom stage.
  writeJsonAtomicSync(stagesPath(), { stages, updatedAt })
}

/**
 * Apply a stage list pulled from the cloud backup. Two protections:
 *   - Any LOCAL stage that still has deals in it is kept (appended) even if
 *     the pulled list dropped it — a pull must never orphan local deals.
 *   - When nothing had to be appended, the cloud row's own timestamp is kept
 *     (same no-restamp rule as applyPulledSettings — restamping would make
 *     every device claim "newest" after a mere pull).
 */
export function applyPulledDealStages(pulledStages: unknown, cloudUpdatedAt: string): void {
  if (!Array.isArray(pulledStages)) return
  const next = sanitizeStageList(pulledStages)
  const nextIds = new Set(next.map((s) => s.id))
  const current = loadDealStages()
  const missing = current.filter((s) => !nextIds.has(s.id)).map((s) => s.id)
  const stillInUse =
    missing.length > 0
      ? new Set(listDealsUsingStage(dealsDir(), missing).map((d) => d.stageId))
      : new Set<string>()
  const kept = current.filter((s) => stillInUse.has(s.id))
  const merged = [...next, ...kept]
  const validStamp = typeof cloudUpdatedAt === 'string' && !Number.isNaN(Date.parse(cloudUpdatedAt))
  writeStages(merged, kept.length === 0 && validStamp ? cloudUpdatedAt : new Date().toISOString())
}

export type SetStagesResult =
  { ok: true; stages: DealStage[] } | { ok: false; error: 'empty' | 'stage-in-use' }

/**
 * Replace the whole stage list. Blocks removing a stage that still has
 * non-deleted deals sitting in it — simplest way to keep every deal pointing
 * at a real stage without a reassignment UI (Phase 3 Step 1 scope).
 */
export function setDealStages(input: unknown): SetStagesResult {
  // The raw variant here, deliberately: sanitizeStageList's defaulting is
  // right for a disk read, but silently swapping in the unrelated default
  // pipeline when a user submits an empty list would look like the app
  // ignored the edit rather than rejecting it.
  const next = sanitizeStageListRaw(input)
  if (!Array.isArray(input) || next.length === 0) return { ok: false, error: 'empty' }

  const current = loadDealStages()
  const nextIds = new Set(next.map((s) => s.id))
  const removedIds = current.filter((s) => !nextIds.has(s.id)).map((s) => s.id)
  if (removedIds.length > 0 && listDealsUsingStage(dealsDir(), removedIds).length > 0) {
    return { ok: false, error: 'stage-in-use' }
  }

  writeStages(next)
  scheduleBackup() // the stage list syncs with the Contacts & deals toggle
  return { ok: true, stages: next }
}

let registered = false

export function registerDealStages(): void {
  if (registered) return
  registered = true

  ipcMain.handle('dealStages:get', (): DealStage[] => loadDealStages())
  ipcMain.handle('dealStages:set', (_event, input: unknown): SetStagesResult =>
    setDealStages(input)
  )
}
