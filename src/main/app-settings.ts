// A single small JSON file for app-wide settings that the MAIN process must
// itself enforce (not just hide in the renderer) — starting with the buyer-
// recording master switch. Modeled on google.ts's sync-mode.json: plain JSON,
// synchronous I/O (the file is tiny and rarely written), a safe default on
// any read failure. Written atomically (sync variant) — a torn write used to
// silently reset EVERY setting (personalization, CRM, sync scope) to defaults.
import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { readFileSync, mkdirSync } from 'node:fs'
import { writeJsonAtomicSync } from './atomic-write'
import {
  EMPTY_PERSONALIZATION,
  sanitizePersonalization,
  mergePersonalization,
  assemblePersonalizationContext,
  type PersonalizationSettings
} from './personalization-context'
import { sanitizeSummaryLanguage, type SummaryLanguage } from './summary-language'
import {
  EMPTY_CRM_SETTINGS,
  sanitizeCrmSettings,
  mergeCrmSettings,
  type CrmSettings
} from './crm-settings'
import {
  DEFAULT_CAPTURE_POLICY_SETTINGS,
  type CapturePolicySettings,
  type CapturePolicyValue,
  type AppOverride
} from './detection/policy'

/**
 * Objection Library mining — reads call transcripts to suggest reusable
 * objection→response scripts for review. HARD RULE: `enabled` is the ONLY
 * gate. OFF (default) means no call is ever read for this — not new calls
 * as they're saved, not the manual "scan past calls" trigger. Nothing
 * mined ever becomes a real script or live-coaching cue without separate,
 * explicit approval in the review queue (a later step) — this switch only
 * controls whether mining runs at all.
 */
export interface ObjectionMiningSettings {
  enabled: boolean
}

const EMPTY_OBJECTION_MINING: ObjectionMiningSettings = { enabled: false }

function sanitizeObjectionMining(value: unknown): ObjectionMiningSettings {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return { enabled: v.enabled === true }
}

function mergeObjectionMining(
  current: ObjectionMiningSettings,
  patch: unknown
): ObjectionMiningSettings {
  if (!patch || typeof patch !== 'object') return current
  const p = patch as Record<string, unknown>
  return { enabled: 'enabled' in p ? p.enabled === true : current.enabled }
}

/**
 * Ambient call detection (M15). HARD RULE: `enabled` is the feature flag
 * (ff_ambient_detection) - off by default, so this milestone ships inert
 * until a later phase adds a Settings toggle. `capturePolicy` maps straight
 * onto detection/policy.ts's `CapturePolicySettings` - this file only
 * sanitizes/persists it, the actual full/mic-only/ask/ignore decision logic
 * lives in exactly one place (policy.ts), not duplicated here.
 */
export interface DetectionSettings {
  enabled: boolean
  capturePolicy: CapturePolicySettings
}

const EMPTY_DETECTION_SETTINGS: DetectionSettings = {
  enabled: false,
  capturePolicy: DEFAULT_CAPTURE_POLICY_SETTINGS
}

function sanitizeCapturePolicyValue(
  value: unknown,
  fallback: CapturePolicyValue
): CapturePolicyValue {
  return value === 'full' || value === 'mic-only' || value === 'ask' ? value : fallback
}

function sanitizeAppOverride(value: unknown): AppOverride | undefined {
  return value === 'full' || value === 'mic-only' || value === 'ask' || value === 'never'
    ? value
    : undefined
}

function sanitizeAppOverrides(value: unknown): Record<string, AppOverride> {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const result: Record<string, AppOverride> = {}
  for (const [appId, override] of Object.entries(v)) {
    const sanitized = sanitizeAppOverride(override)
    if (sanitized) result[appId] = sanitized
  }
  return result
}

function sanitizeCapturePolicy(value: unknown): CapturePolicySettings {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    autoCapturePolicy: sanitizeCapturePolicyValue(
      v.autoCapturePolicy,
      DEFAULT_CAPTURE_POLICY_SETTINGS.autoCapturePolicy
    ),
    appOverrides: sanitizeAppOverrides(v.appOverrides)
  }
}

function sanitizeDetectionSettings(value: unknown): DetectionSettings {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    enabled: v.enabled === true,
    capturePolicy: sanitizeCapturePolicy(v.capturePolicy)
  }
}

function mergeCapturePolicy(current: CapturePolicySettings, patch: unknown): CapturePolicySettings {
  if (!patch || typeof patch !== 'object') return current
  const p = patch as Record<string, unknown>
  return {
    autoCapturePolicy:
      'autoCapturePolicy' in p
        ? sanitizeCapturePolicyValue(p.autoCapturePolicy, current.autoCapturePolicy)
        : current.autoCapturePolicy,
    appOverrides: 'appOverrides' in p ? sanitizeAppOverrides(p.appOverrides) : current.appOverrides
  }
}

function mergeDetectionSettings(current: DetectionSettings, patch: unknown): DetectionSettings {
  if (!patch || typeof patch !== 'object') return current
  const p = patch as Record<string, unknown>
  return {
    enabled: 'enabled' in p ? p.enabled === true : current.enabled,
    capturePolicy:
      'capturePolicy' in p
        ? mergeCapturePolicy(current.capturePolicy, p.capturePolicy)
        : current.capturePolicy
  }
}

/** Which optional categories back up to the cloud, on top of the always-on
 *  Tasks/Calendar events/Call metadata. All default OFF — opt-in only. */
export interface BackupSyncScope {
  /** Buyer transcripts + coaching evidence quotes (normally stripped before backup). */
  transcripts: boolean
  /** Attached document blobs (Supabase Storage), not just their metadata. */
  attachments: boolean
  knowledgeBase: boolean
  settingsPersonalization: boolean
  contacts: boolean
}

const EMPTY_SYNC_SCOPE: BackupSyncScope = {
  transcripts: false,
  attachments: false,
  knowledgeBase: false,
  settingsPersonalization: false,
  contacts: false
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
  /** Same non-secret marker as googleCalendarConnected, for Outlook Calendar. */
  outlookCalendarConnected: boolean
  /** CRM Phase 1 — calendar-match sensitivity/kill-switch, default country,
   *  and auto-numbered customer IDs. */
  crm: CrmSettings
  /** Objection Library mining master switch. Defaults OFF. */
  objectionMining: ObjectionMiningSettings
  /** Ambient call detection (M15) - feature flag + capture policy. Defaults OFF. */
  detection: DetectionSettings
}

const EPOCH = new Date(0).toISOString()

const DEFAULT_SETTINGS: AppSettings = {
  allowOtherPartyRecording: true,
  personalization: EMPTY_PERSONALIZATION,
  summaryLanguage: 'auto',
  syncScope: EMPTY_SYNC_SCOPE,
  settingsUpdatedAt: EPOCH,
  googleCalendarConnected: false,
  outlookCalendarConnected: false,
  crm: EMPTY_CRM_SETTINGS,
  objectionMining: EMPTY_OBJECTION_MINING,
  detection: EMPTY_DETECTION_SETTINGS
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
    settingsPersonalization: v.settingsPersonalization === true,
    contacts: v.contacts === true
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
        : current.settingsPersonalization,
    contacts: 'contacts' in p ? p.contacts === true : current.contacts
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
      googleCalendarConnected: parsed.googleCalendarConnected === true,
      outlookCalendarConnected: parsed.outlookCalendarConnected === true,
      crm: sanitizeCrmSettings(parsed.crm),
      objectionMining: sanitizeObjectionMining(parsed.objectionMining),
      detection: sanitizeDetectionSettings(parsed.detection)
    }
  } catch {
    return {
      ...DEFAULT_SETTINGS,
      personalization: { ...EMPTY_PERSONALIZATION },
      crm: { ...EMPTY_CRM_SETTINGS },
      objectionMining: { ...EMPTY_OBJECTION_MINING },
      detection: { ...EMPTY_DETECTION_SETTINGS }
    }
  }
}

function mergeSettings(current: AppSettings, patch: unknown): AppSettings {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>
  return {
    allowOtherPartyRecording:
      typeof p.allowOtherPartyRecording === 'boolean'
        ? p.allowOtherPartyRecording
        : current.allowOtherPartyRecording,
    personalization: mergePersonalization(current.personalization, p.personalization),
    summaryLanguage:
      'summaryLanguage' in p ? sanitizeSummaryLanguage(p.summaryLanguage) : current.summaryLanguage,
    syncScope: mergeSyncScope(current.syncScope, p.syncScope),
    settingsUpdatedAt: current.settingsUpdatedAt,
    googleCalendarConnected:
      'googleCalendarConnected' in p
        ? p.googleCalendarConnected === true
        : current.googleCalendarConnected,
    outlookCalendarConnected:
      'outlookCalendarConnected' in p
        ? p.outlookCalendarConnected === true
        : current.outlookCalendarConnected,
    crm: mergeCrmSettings(current.crm, p.crm),
    objectionMining: mergeObjectionMining(current.objectionMining, p.objectionMining),
    detection: mergeDetectionSettings(current.detection, p.detection)
  }
}

function persistSettings(next: AppSettings): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeJsonAtomicSync(settingsPath(), next)
}

/**
 * Called with the list of sync-scope keys a LOCAL edit just turned OFF —
 * backup.ts registers a scrub here (delete that category's cloud rows/blobs).
 * A callback registration instead of an import, because backup.ts already
 * imports this module (no cycle). Deliberately NOT fired by
 * applyPulledSettings: pulls preserve this device's scope, and a remote
 * device must never trigger a scrub of this account's cloud data anyway —
 * only an explicit local toggle-off does.
 */
type SyncScopeKey = keyof BackupSyncScope
let onSyncScopeDisabled: ((keys: SyncScopeKey[]) => void) | null = null
export function setSyncScopeDisabledListener(fn: (keys: SyncScopeKey[]) => void): void {
  onSyncScopeDisabled = fn
}

/**
 * Called whenever a save flips `detection.enabled` - detection-service.ts
 * registers this so toggling the Settings switch starts/stops the live
 * CallDetector immediately, instead of only taking effect on next launch.
 * Same callback-registration shape as onSyncScopeDisabled, for the same
 * reason (detection-service.ts already imports this module - no cycle).
 */
let onDetectionEnabledChanged: (() => void) | null = null
export function setDetectionEnabledChangedListener(fn: () => void): void {
  onDetectionEnabledChanged = fn
}

export function saveAppSettings(patch: unknown): AppSettings {
  const current = loadAppSettings()
  const next = mergeSettings(current, patch)
  next.settingsUpdatedAt = new Date().toISOString() // bump on every LOCAL edit
  persistSettings(next)
  const disabled = (Object.keys(next.syncScope) as SyncScopeKey[]).filter(
    (k) => current.syncScope[k] && !next.syncScope[k]
  )
  if (disabled.length && onSyncScopeDisabled) {
    try {
      onSyncScopeDisabled(disabled)
    } catch {
      /* a scrub failure must never fail the settings save */
    }
  }
  if (current.detection.enabled !== next.detection.enabled && onDetectionEnabledChanged) {
    try {
      onDetectionEnabledChanged()
    } catch {
      /* never fail the settings save over this */
    }
  }
  return next
}

/**
 * Apply a settings payload pulled from the cloud. Two deliberate differences
 * from saveAppSettings:
 *   - The cloud row's own timestamp is KEPT, not restamped — restamping made
 *     every device claim "newest" after a mere pull, so devices ping-ponged
 *     the settings row at each other forever (and with clock skew a real edit
 *     could lose to a pull).
 *   - THIS device's syncScope is preserved. What may leave this machine
 *     (transcripts, contacts, attachments, …) is a per-device privacy
 *     decision — another device turning a toggle on must never make this one
 *     silently start uploading local-only data.
 */
export function applyPulledSettings(payload: unknown, cloudUpdatedAt: string): AppSettings {
  const current = loadAppSettings()
  const next = mergeSettings(current, payload)
  next.syncScope = current.syncScope
  next.settingsUpdatedAt =
    typeof cloudUpdatedAt === 'string' && !Number.isNaN(Date.parse(cloudUpdatedAt))
      ? cloudUpdatedAt
      : current.settingsUpdatedAt
  persistSettings(next)
  return next
}

/**
 * The single gate future mining code (new-call hook, "scan past calls")
 * must check before reading any transcript. Synchronous, like the rest of
 * this file's settings — a missing/corrupt file collapses to OFF, never ON.
 */
export function isObjectionMiningEnabled(): boolean {
  return loadAppSettings().objectionMining.enabled
}

/** The ff_ambient_detection gate - detection-service.ts must check this before starting any adapter. */
export function isAmbientDetectionEnabled(): boolean {
  return loadAppSettings().detection.enabled
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
