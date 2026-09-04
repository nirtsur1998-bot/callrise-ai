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

/**
 * M32 Stage 2 — 'went-quiet' is NEW, and it is a distinct OUTCOME, not a
 * flavour of 'lost'.
 *
 * The founder's words: *"these deals don't end, they fade."* Before this, a
 * deal that simply stopped answering had to be filed under Lost, which merges
 * two different things — "they decided no" and "it evaporated" — into one
 * bucket. That merge would have quietly poisoned every later comparison,
 * because the behaviours that precede a refusal and the behaviours that precede
 * a fade are not the same behaviours, and the whole point of Stage 2 is to
 * learn which is which.
 *
 * Recorded now even though nothing analyses it yet, precisely BECAUSE nothing
 * analyses it yet: the data has to be collected correctly before it is worth
 * collecting at all, and a distinction not captured today cannot be recovered
 * later from deals that have already closed.
 */
export type DealStageKind = 'open' | 'won' | 'lost' | 'went-quiet'

/** Every kind that means the deal is CLOSED — i.e. it has an outcome. Derived
 *  once here so a fifth kind cannot be added while some caller keeps its own
 *  hand-written list of "the closed ones" (the AI_KEY_NAMES lesson). */
export const CLOSED_STAGE_KINDS: readonly DealStageKind[] = ['won', 'lost', 'went-quiet']

export function isClosedKind(kind: DealStageKind): boolean {
  return CLOSED_STAGE_KINDS.includes(kind)
}

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
  { id: 'lost', label: 'Lost', kind: 'lost' },
  // Founder's wording, chosen over "No decision": *"that's what actually
  // happens and it's what I'd say out loud. 'No decision' sounds like a formal
  // outcome; these deals don't end, they fade."*
  { id: 'went-quiet', label: 'Went quiet', kind: 'went-quiet' }
]

function stagesPath(): string {
  return join(app.getPath('userData'), 'deal-stages.json')
}

function dealsDir(): string {
  return join(app.getPath('userData'), 'deals')
}

function sanitizeKind(value: unknown): DealStageKind {
  // Unknown/absent falls back to 'open', NOT to a closed kind. A stage file
  // written by a NEWER build (one that knows a kind this build does not) must
  // degrade to "still in play" rather than silently marking live deals closed.
  return value === 'won' || value === 'lost' || value === 'went-quiet' ? value : 'open'
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
/**
 * M32 Stage 2 — one-time migrations applied to an EXISTING saved pipeline.
 *
 * FOUND BY DRIVING THE APP, not by a test. Adding 'went-quiet' to
 * `DEFAULT_STAGES` made every unit test pass and put the column on screen for
 * **nobody**: `DEFAULT_STAGES` is only consulted when no `deal-stages.json`
 * exists, and every existing install has one. The feature was invisible to
 * exactly the people it was built for, and the suite was fully green.
 *
 * A marker per migration, not a version number: the marker records that the
 * app has OFFERED this stage once. If the founder then deletes "Went quiet"
 * because they do not want it, it must stay deleted — re-adding it on the next
 * launch would be principle 49's worst case, silently restoring something a
 * person deliberately removed.
 */
const STAGE_MIGRATIONS = ['went-quiet-v1', 'went-quiet-dedupe-v1'] as const
const MAX_MIGRATION_MARKER = 64

/**
 * BUG-183 — markers this build does NOT recognise are carried through, never
 * dropped. The first version kept only the markers it knew, which is exactly
 * how the founder's board grew four "Went quiet" columns: a v1.6.0 build (no
 * `migrations` field at all, and a `sanitizeKind` that maps the unknown
 * 'went-quiet' to 'open') rewrote the file on an ordinary stage edit, the
 * marker and the kind both vanished, and the next newer launch "migrated"
 * again — appending a fresh stage each time the two builds alternated. A
 * migration that fights itself across versions. Builds already in the field
 * cannot be fixed, so the repair below is written to survive their stripping;
 * this line stops THIS build from doing the same thing to whatever comes next.
 */
function sanitizeMigrations(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const m of value) {
    if (typeof m === 'string' && m.length > 0 && m.length <= MAX_MIGRATION_MARKER) seen.add(m)
  }
  return [...seen]
}

export function loadDealStagesMeta(): {
  stages: DealStage[]
  updatedAt: string
  migrations: string[]
} {
  try {
    const parsed = JSON.parse(readFileSync(stagesPath(), 'utf8'))
    const updatedAt =
      typeof parsed?.updatedAt === 'string' && !Number.isNaN(Date.parse(parsed.updatedAt))
        ? parsed.updatedAt
        : EPOCH
    return {
      stages: sanitizeStageList(parsed?.stages),
      updatedAt,
      migrations: sanitizeMigrations(parsed?.migrations)
    }
  } catch {
    // No file at all: the defaults already contain every stage, so every
    // migration is vacuously done. Marking them prevents a first-run install
    // from later "migrating" a pipeline that was never missing anything.
    return { stages: DEFAULT_STAGES, updatedAt: EPOCH, migrations: [...STAGE_MIGRATIONS] }
  }
}

/**
 * Add "Went quiet" to a saved pipeline that predates it — ONCE.
 *
 * Deliberately conservative in three ways:
 *   - runs only if the marker is absent, so a deliberate deletion sticks;
 *   - skips if the pipeline ALREADY has a stage of this kind under any label,
 *     because the user may have made their own and a second one is clutter;
 *   - marks itself done even when it adds nothing, so the check does not
 *     re-run forever on installs that never needed it.
 *
 * Returns whether the stage list changed, so the caller can avoid a pointless
 * write (and a pointless `updatedAt` bump, which would make this device claim
 * "newest" against the cloud for a change nobody made).
 */
const WENT_QUIET_LABEL = 'Went quiet'
const normaliseLabel = (label: string): string => label.trim().toLowerCase()

export function migrateDealStages(): boolean {
  const meta = loadDealStagesMeta()
  let stages = meta.stages
  const migrations = [...meta.migrations]
  let changed = false

  if (!migrations.includes('went-quiet-v1')) {
    // BUG-183 — REPAIR BEFORE APPENDING. An older build that rewrote the file
    // has turned our stage's kind into 'open' and dropped this marker; the
    // stage itself is still there under its id or its label. Appending a
    // second one is what produced four columns. So: no stage of this kind →
    // look for OUR stage by id, then by label, and put its kind back; only
    // when neither exists is a stage actually missing.
    if (!stages.some((s) => s.kind === 'went-quiet')) {
      const ours =
        stages.find((s) => s.id === 'went-quiet') ??
        stages.find((s) => normaliseLabel(s.label) === normaliseLabel(WENT_QUIET_LABEL))
      stages = ours
        ? stages.map((s) => (s === ours ? { ...s, kind: 'went-quiet' as const } : s))
        : [...stages, { id: 'went-quiet', label: WENT_QUIET_LABEL, kind: 'went-quiet' as const }]
      changed = true
    }
    migrations.push('went-quiet-v1')
  }

  if (!migrations.includes('went-quiet-dedupe-v1')) {
    // BUG-183 — the clean-up for boards that already grew the duplicates.
    // A clone is a stage labelled like ours whose kind is 'open' (that is the
    // coerced shape, and it is also why a card dragged into one records the
    // WRONG outcome) while a real 'went-quiet' stage exists. Removed only when
    // EMPTY: a clone holding deals is left alone rather than orphaning them,
    // and the marker is set regardless so this never re-runs on its own.
    const real = stages.find((s) => s.kind === 'went-quiet')
    if (real) {
      const clones = stages.filter(
        (s) =>
          s !== real &&
          s.kind === 'open' &&
          normaliseLabel(s.label) === normaliseLabel(WENT_QUIET_LABEL)
      )
      if (clones.length > 0) {
        const inUse = new Set(
          listDealsUsingStage(
            dealsDir(),
            clones.map((c) => c.id)
          ).map((d) => d.stageId)
        )
        const removable = new Set(clones.filter((c) => !inUse.has(c.id)).map((c) => c.id))
        if (removable.size > 0) {
          stages = stages.filter((s) => !removable.has(s.id))
          changed = true
        }
      }
    }
    migrations.push('went-quiet-dedupe-v1')
  }

  if (!changed && migrations.length === meta.migrations.length) return false
  writeStagesWithMigrations(stages, migrations, meta.updatedAt, !changed)
  return changed
}

function writeStages(stages: DealStage[], updatedAt = new Date().toISOString()): void {
  mkdirSync(join(app.getPath('userData')), { recursive: true })
  // Atomic: a torn write here silently reset the pipeline to the default
  // stages on next launch, orphaning every deal sitting in a custom stage.
  // Migrations are carried through so an ordinary edit cannot drop the markers
  // and cause a deleted stage to be re-added on the next launch.
  writeJsonAtomicSync(stagesPath(), {
    stages,
    updatedAt,
    migrations: loadDealStagesMeta().migrations
  })
}

/** Used only by the migration, which must control the stamp itself. */
function writeStagesWithMigrations(
  stages: DealStage[],
  migrations: string[],
  previousUpdatedAt: string,
  unchanged: boolean
): void {
  mkdirSync(join(app.getPath('userData')), { recursive: true })
  // KEEP the old stamp when nothing actually changed. Restamping would make
  // this device claim "newest" in the cloud's newest-wins comparison for a
  // migration that added nothing — the same no-restamp rule
  // applyPulledDealStages already follows.
  writeJsonAtomicSync(stagesPath(), {
    stages,
    updatedAt: unchanged ? previousUpdatedAt : new Date().toISOString(),
    migrations
  })
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

  // M32 Stage 2 — run the one-time pipeline migration BEFORE the first
  // `dealStages:get` can be served, so the renderer's very first read already
  // includes "Went quiet". Wrapped: a migration failure must never stop the
  // deal stages registering at all, which would take the whole Pipeline down
  // over a config nicety.
  try {
    if (migrateDealStages()) console.log('[deal-stages] repaired the saved pipeline ("Went quiet" added, restored, or de-duplicated)')
  } catch (e) {
    console.error('[deal-stages] migration failed, continuing with the saved pipeline:', e)
  }

  ipcMain.handle('dealStages:get', (): DealStage[] => loadDealStages())
  ipcMain.handle('dealStages:set', (_event, input: unknown): SetStagesResult =>
    setDealStages(input)
  )
}
