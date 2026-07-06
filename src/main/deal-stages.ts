// The deal pipeline's configurable stage list — a small, separate JSON file
// (own file, not app-settings.ts) so it can evolve independently. Modeled on
// google.ts's sync-mode.json: plain JSON, synchronous I/O (tiny, rarely
// written), a safe default on any read failure.
import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { listDealsUsingStage } from './deals-fs'

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

/** Coerce an untrusted parsed list into a clean, non-empty stage list. Falls
 *  back to the defaults if the input is unusable (never returns an empty pipeline). */
function sanitizeStageList(value: unknown): DealStage[] {
  if (!Array.isArray(value)) return DEFAULT_STAGES
  const seen = new Set<string>()
  const stages: DealStage[] = []
  for (const raw of value.slice(0, MAX_STAGES)) {
    if (!raw || typeof raw !== 'object') continue
    const v = raw as Record<string, unknown>
    const label = sanitizeLabel(v.label)
    if (!label) continue
    const id = typeof v.id === 'string' && v.id && !seen.has(v.id) ? v.id : randomUUID()
    seen.add(id)
    stages.push({ id, label, kind: sanitizeKind(v.kind) })
  }
  return stages.length ? stages : DEFAULT_STAGES
}

export function loadDealStages(): DealStage[] {
  try {
    const parsed = JSON.parse(readFileSync(stagesPath(), 'utf8'))
    return sanitizeStageList(parsed?.stages)
  } catch {
    return DEFAULT_STAGES
  }
}

function writeStages(stages: DealStage[]): void {
  mkdirSync(join(app.getPath('userData')), { recursive: true })
  writeFileSync(stagesPath(), JSON.stringify({ stages }), 'utf8')
}

export type SetStagesResult =
  { ok: true; stages: DealStage[] } | { ok: false; error: 'empty' | 'stage-in-use' }

/**
 * Replace the whole stage list. Blocks removing a stage that still has
 * non-deleted deals sitting in it — simplest way to keep every deal pointing
 * at a real stage without a reassignment UI (Phase 3 Step 1 scope).
 */
export function setDealStages(input: unknown): SetStagesResult {
  const next = sanitizeStageList(input)
  if (!Array.isArray(input) || next.length === 0) return { ok: false, error: 'empty' }

  const current = loadDealStages()
  const nextIds = new Set(next.map((s) => s.id))
  const removedIds = current.filter((s) => !nextIds.has(s.id)).map((s) => s.id)
  if (removedIds.length > 0 && listDealsUsingStage(dealsDir(), removedIds).length > 0) {
    return { ok: false, error: 'stage-in-use' }
  }

  writeStages(next)
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
