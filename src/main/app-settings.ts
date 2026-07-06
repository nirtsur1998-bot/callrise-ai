// A single small JSON file for app-wide settings that the MAIN process must
// itself enforce (not just hide in the renderer) — starting with the buyer-
// recording master switch. Modeled on google.ts's sync-mode.json: plain JSON,
// synchronous I/O (the file is tiny and rarely written), a safe default on
// any read failure. Not atomic-write like calls/tasks/knowledge — a torn
// write here just falls back to the default, which is today's current
// behavior, never a more-permissive one.
import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import {
  EMPTY_PERSONALIZATION,
  sanitizePersonalization,
  mergePersonalization,
  assemblePersonalizationContext,
  type PersonalizationSettings
} from './personalization-context'
import { sanitizeSummaryLanguage, type SummaryLanguage } from './summary-language'

/** Which optional categories back up to the cloud, on top of the always-on
 *  Tasks/Calendar events/Call metadata. All default OFF — opt-in only. */
export interface BackupSyncScope {
  /** Buyer transcripts + coaching evidence quotes (normally stripped before backup). */
  transcripts: boolean
  /** Attached document blobs (Supabase Storage), not just their metadata. */
  attachments: boolean
  knowledgeBase: boolean
  settingsPersonalization: boolean
}

const EMPTY_SYNC_SCOPE: BackupSyncScope = {
  transcripts: false,
  attachments: false,
  knowledgeBase: false,
  settingsPersonalization: false
}

export interface AppSettings {
  /**
   * Master switch for buyer/other-party recording. HARD RULE: this can only
   * REMOVE capability, never grant it — turning it ON does not itself record
   * anything; per-call consent (calls-fs.ts's sanitizeConsent invariant,
   * `recordOtherParty` only ever true when `status === 'consented'`) still
   * fully governs actual recording. Defaults to true (today's behavior).
   */
  allowOtherPartyRecording: boolean
  /** Who the rep is — fed into summary/coaching prompts. Empty by default. */
  personalization: PersonalizationSettings
  /** Language for AI summaries. 'auto' = same language as the source content. */
  summaryLanguage: SummaryLanguage
  /** Optional cloud-backup categories (Privacy & data), all off by default. */
  syncScope: BackupSyncScope
  /** Bumped on every save — the "newest wins" cursor when this whole object
   *  itself is synced to the cloud (backup_settings), same discipline as
   *  every other record's updatedAt. */
  settingsUpdatedAt: string
  /** Non-secret marker: has Google Calendar been connected on ANY device for
   *  this account? Never the token itself — just enough to show a "reconnect
   *  Google Calendar" nudge on a fresh device instead of syncing the actual
   *  OAuth refresh token to the cloud. */
  googleCalendarConnected: boolean
}

const EPOCH = new Date(0).toISOString()

const DEFAULT_SETTINGS: AppSettings = {
  allowOtherPartyRecording: true,
  personalization: EMPTY_PERSONALIZATION,
  summaryLanguage: 'auto',
  syncScope: EMPTY_SYNC_SCOPE,
  settingsUpdatedAt: EPOCH,
  googleCalendarConnected: false
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'app-settings.json')
}

function sanitizeSyncScope(value: unknown): BackupSyncScope {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    transcripts: v.transcripts === true,
    attachments: v.attachments === true,
    knowledgeBase: v.knowledgeBase === true,
    settingsPersonalization: v.settingsPersonalization === true
  }
}

function mergeSyncScope(current: BackupSyncScope, patch: unknown): BackupSyncScope {
  if (!patch || typeof patch !== 'object') return current
  const p = patch as Record<string, unknown>
  return {
    transcripts: 'transcripts' in p ? p.transcripts === true : current.transcripts,
    attachments: 'attachments' in p ? p.attachments === true : current.attachments,
    knowledgeBase: 'knowledgeBase' in p ? p.knowledgeBase === true : current.knowledgeBase,
    settingsPersonalization:
      'settingsPersonalization' in p
        ? p.settingsPersonalization === true
        : current.settingsPersonalization
  }
}

/**
 * Synchronous by design: the loopback capture gate (loopback.ts) must check
 * this in the same tick as a synchronous IPC call, right before
 * getDisplayMedia — an async read would race the arm/request. Any missing or
 * corrupt file collapses to the safe default (true, current behavior), never
 * to a more-permissive value.
 */
export function loadAppSettings(): AppSettings {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<AppSettings>
    return {
      allowOtherPartyRecording:
        typeof parsed.allowOtherPartyRecording === 'boolean'
          ? parsed.allowOtherPartyRecording
          : DEFAULT_SETTINGS.allowOtherPartyRecording,
      personalization: sanitizePersonalization(parsed.personalization),
      summaryLanguage: sanitizeSummaryLanguage(parsed.summaryLanguage),
      syncScope: sanitizeSyncScope(parsed.syncScope),
      settingsUpdatedAt:
        typeof parsed.settingsUpdatedAt === 'string' &&
        !Number.isNaN(Date.parse(parsed.settingsUpdatedAt))
          ? parsed.settingsUpdatedAt
          : EPOCH,
      googleCalendarConnected: parsed.googleCalendarConnected === true
    }
  } catch {
    return { ...DEFAULT_SETTINGS, personalization: { ...EMPTY_PERSONALIZATION } }
  }
}

export function saveAppSettings(patch: unknown): AppSettings {
  const current = loadAppSettings()
  const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>
  const next: AppSettings = {
    allowOtherPartyRecording:
      typeof p.allowOtherPartyRecording === 'boolean'
        ? p.allowOtherPartyRecording
        : current.allowOtherPartyRecording,
    personalization: mergePersonalization(current.personalization, p.personalization),
    summaryLanguage:
      'summaryLanguage' in p ? sanitizeSummaryLanguage(p.summaryLanguage) : current.summaryLanguage,
    syncScope: mergeSyncScope(current.syncScope, p.syncScope),
    settingsUpdatedAt: new Date().toISOString(), // bump on every save
    googleCalendarConnected:
      'googleCalendarConnected' in p
        ? p.googleCalendarConnected === true
        : current.googleCalendarConnected
  }
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify(next), 'utf8')
  return next
}

let registered = false

export function registerAppSettings(): void {
  if (registered) return
  registered = true
  ipcMain.handle('settings:get', (): AppSettings => loadAppSettings())
  ipcMain.handle('settings:update', (_event, patch: unknown): AppSettings => saveAppSettings(patch))
  // Shows exactly what text the AI would be given about the rep, so
  // Personalization isn't a black box (same idea as knowledge:preview).
  ipcMain.handle('settings:previewPersonalization', (): { text: string; charCount: number } => {
    const text = assemblePersonalizationContext(loadAppSettings().personalization)
    return { text, charCount: text.length }
  })
}
