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
}

const DEFAULT_SETTINGS: AppSettings = {
  allowOtherPartyRecording: true,
  personalization: EMPTY_PERSONALIZATION,
  summaryLanguage: 'auto'
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'app-settings.json')
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
      summaryLanguage: sanitizeSummaryLanguage(parsed.summaryLanguage)
    }
  } catch {
    return {
      allowOtherPartyRecording: true,
      personalization: { ...EMPTY_PERSONALIZATION },
      summaryLanguage: 'auto'
    }
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
      'summaryLanguage' in p ? sanitizeSummaryLanguage(p.summaryLanguage) : current.summaryLanguage
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
