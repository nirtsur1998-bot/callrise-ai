// M20: local-only fallback-event log. No telemetry/analytics pipeline
// exists anywhere in this codebase (verified — no PostHog/Sentry/Mixpanel/
// track()/event table; see docs/ai-providers.md's M20 addendum) — the
// milestone brief's "log to the existing telemetry" assumption doesn't
// hold, so this is the substitute: append-only, local-only, metadata-only
// (never transcript content or buyer speech), consistent with this
// codebase's existing opt-in-by-default posture for every optional
// cloud-sync category (app-settings.ts's BackupSyncScope). Capped at the
// last 1000 entries via prune-on-write — no rotation library exists here
// and an unbounded log fed by the live-coaching path would otherwise grow
// forever.
import { app, ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { AIPurpose } from './types'
import { catalogEntry } from './model-catalog'

export interface FallbackEvent {
  ts: string
  purpose: AIPurpose
  fromCatalogId: string
  toCatalogId: string | null // null = chain exhausted, nothing left to advance to
  reason: string
}

const MAX_ENTRIES = 1000

function logPath(): string {
  return join(app.getPath('userData'), 'ai-fallback-events.jsonl')
}

export async function logFallbackEvent(event: FallbackEvent): Promise<void> {
  try {
    await fs.appendFile(logPath(), `${JSON.stringify(event)}\n`, 'utf8')
    await pruneIfNeeded()
  } catch {
    // A logging failure must never break the actual AI call it's describing.
  }
}

async function pruneIfNeeded(): Promise<void> {
  try {
    const raw = await fs.readFile(logPath(), 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    if (lines.length <= MAX_ENTRIES) return
    const kept = lines.slice(lines.length - MAX_ENTRIES)
    await fs.writeFile(logPath(), `${kept.join('\n')}\n`, 'utf8')
  } catch {
    /* best-effort - a failed prune just means the file grows a bit more */
  }
}

/** Most-recent-first, for Settings → Model Assignment's read-only "recent
 *  fallback activity" list. */
export async function readRecentFallbackEvents(limit = 20): Promise<FallbackEvent[]> {
  try {
    const raw = await fs.readFile(logPath(), 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    return lines
      .slice(Math.max(0, lines.length - limit))
      .reverse()
      .map((line) => JSON.parse(line) as FallbackEvent)
  } catch {
    return []
  }
}

export function registerFallbackLog(): void {
  ipcMain.handle('aiFallback:recentEvents', async () => {
    const events = await readRecentFallbackEvents(20)
    // Resolve display names here (main process has the catalog) so the
    // renderer never needs its own copy of MODEL_CATALOG just to label a
    // log line.
    return events.map((e) => ({
      ...e,
      fromDisplayName: catalogEntry(e.fromCatalogId)?.displayName ?? e.fromCatalogId,
      toDisplayName: e.toCatalogId ? (catalogEntry(e.toCatalogId)?.displayName ?? e.toCatalogId) : null
    }))
  })
}
