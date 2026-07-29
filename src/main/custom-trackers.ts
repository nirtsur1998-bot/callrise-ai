// Persistence for custom trackers (§4.8) — a small, rarely-written file, same
// shape as sync-mode.json / app-settings.json: one JSON blob, atomic writes,
// a safe empty default on any read failure. Not one-file-per-entry like the
// Knowledge Base, because there are only ever a handful of these and they are
// always read together (the whole list feeds the live BattlecardMatcher).
//
// The BOUNDARY this file sits on: `Trigger`/`Battlecard`/`BattlecardCategory`
// are renderer types (features/live/battlecards/match.ts) because that is
// where they are actually used — matched against the live transcript inside
// the renderer's BattlecardMatcher. Main never matches anything; it only
// stores what the renderer already validated with sanitizeGeneratedTrigger
// and hands back on request. So this file keeps its OWN minimal copy of the
// shape rather than importing the renderer's, the same direction every other
// cross-boundary type in this app goes (main owns the canonical storage shape;
// the renderer mirrors it) — except here the renderer is upstream of main,
// which is why this file re-validates on read regardless of who wrote it.
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { writeJsonAtomic } from './atomic-write'

export type StoredTrackerCategory = 'objection' | 'competitor' | 'pricing' | 'process'

export interface StoredTracker {
  id: string
  patterns: string[]
  card: {
    id: string
    label: string
    say: string
    category: StoredTrackerCategory
  }
}

const CATEGORIES = new Set<StoredTrackerCategory>(['objection', 'competitor', 'pricing', 'process'])
const MAX_TRACKERS = 50
const ID_RE = /^[A-Za-z0-9-]{1,64}$/

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value)
}

/** Re-validates on read as well as write — a hand-edited or corrupted file
 *  must not hand the live matcher a tracker whose `patterns` array is empty
 *  (fires on everything) or whose category isn't one CueControls/the rail
 *  knows how to render. */
function sanitizeStoredTracker(value: unknown): StoredTracker | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (!isSafeId(v.id)) return null
  const patterns = (Array.isArray(v.patterns) ? v.patterns : [])
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .slice(0, 8)
  if (patterns.length === 0) return null
  const card = v.card as Record<string, unknown> | undefined
  if (!card || !isSafeId(card.id)) return null
  const label = typeof card.label === 'string' ? card.label.trim().slice(0, 24) : ''
  const say = typeof card.say === 'string' ? card.say.trim().slice(0, 90) : ''
  if (!label || !say) return null
  const category = card.category
  if (typeof category !== 'string' || !CATEGORIES.has(category as StoredTrackerCategory)) {
    return null
  }
  return {
    id: v.id,
    patterns,
    card: { id: card.id, label, say, category: category as StoredTrackerCategory }
  }
}

function sanitizeStoredTrackers(value: unknown): StoredTracker[] {
  const list = Array.isArray(value) ? value : []
  const out: StoredTracker[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const clean = sanitizeStoredTracker(item)
    if (!clean || seen.has(clean.id)) continue
    seen.add(clean.id)
    out.push(clean)
    if (out.length >= MAX_TRACKERS) break
  }
  return out
}

function filePath(dir: string): string {
  return join(dir, 'custom-trackers.json')
}

export async function listCustomTrackers(dir: string): Promise<StoredTracker[]> {
  try {
    const raw = await fs.readFile(filePath(dir), 'utf-8')
    return sanitizeStoredTrackers(JSON.parse(raw))
  } catch {
    return [] // missing file, unreadable, or corrupt — no trackers, not a crash
  }
}

/** Replaces the whole list — the renderer always sends the full set it wants
 *  persisted (it already holds the authoritative in-memory list for the
 *  matcher), so there is no separate add/remove RPC to keep in sync. */
export async function saveCustomTrackers(dir: string, trackers: unknown): Promise<StoredTracker[]> {
  const clean = sanitizeStoredTrackers(trackers)
  await fs.mkdir(dir, { recursive: true })
  await writeJsonAtomic(filePath(dir), clean)
  return clean
}
