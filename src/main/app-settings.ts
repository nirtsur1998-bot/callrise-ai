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
import type { AIProviderId } from './ai/types'
import {
  DEFAULT_MODEL_ASSIGNMENTS,
  sanitizeModelAssignments,
  mergeModelAssignments,
  type ModelAssignments
} from './ai/model-assignments'
import { SALES_METHODOLOGIES, type SalesMethodology } from './calls-fs'

/**
 * M23 Workstream A — Coach 2.0 (benchmark engine, skill graph, methodology
 * picker, Focus Skill loop). HARD RULE: `enabled` is the ONLY gate for every
 * bit of new behavior this milestone adds to coach.ts — off (default) means
 * the post-call scorecard behaves EXACTLY as it did before M23 (six
 * dimensions, no skills/benchmarks/methodology field on the saved report).
 * `methodology: 'blended'` (default) keeps today's existing behavior too —
 * coach.ts already lets the AI pick whichever lens best fits a given call;
 * a specific methodology only forces that ONE lens once explicitly chosen.
 */
export interface Coach2Settings {
  enabled: boolean
  methodology: SalesMethodology
}

const EMPTY_COACH2: Coach2Settings = { enabled: false, methodology: 'blended' }

function sanitizeMethodology(value: unknown): SalesMethodology {
  return SALES_METHODOLOGIES.includes(value as SalesMethodology)
    ? (value as SalesMethodology)
    : 'blended'
}

function sanitizeCoach2(value: unknown): Coach2Settings {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return { enabled: v.enabled === true, methodology: sanitizeMethodology(v.methodology) }
}

function mergeCoach2(current: Coach2Settings, patch: unknown): Coach2Settings {
  if (!patch || typeof patch !== 'object') return current
  const p = patch as Record<string, unknown>
  return {
    enabled: 'enabled' in p ? p.enabled === true : current.enabled,
    methodology: 'methodology' in p ? sanitizeMethodology(p.methodology) : current.methodology
  }
}

/**
 * M26 Phase 4.5.2 — Deal Intelligence (M24 beta) and live coaching cues
 * (M9) enable/sensitivity/etc. settings, moved out of renderer-only
 * localStorage (useDealIntelligenceSettings.ts / useCueSettings.ts) so main
 * can read them once the engines themselves move into main (4.5.3/4.5.4) —
 * main cannot gate its own AI-call cadence on a value that only ever
 * existed inside a React hook. The renderer Settings UI is unchanged; it
 * now reads/writes through this file's existing settings:get/update IPC
 * instead of localStorage directly. Defaults below match the two hooks'
 * previous localStorage defaults exactly, so an existing install sees no
 * behavior change from this migration alone.
 */
export type DealIntelligenceSensitivity = 'quiet' | 'balanced' | 'aggressive'
export type AnalysisFrequency = 'frequent' | 'balanced' | 'infrequent'

export interface EnabledNudgeTypes {
  risk: boolean
  opportunity: boolean
  tactical: boolean
}

export interface DealIntelligenceSettings {
  enabled: boolean
  sensitivity: DealIntelligenceSensitivity
  enabledTypes: EnabledNudgeTypes
  frequency: AnalysisFrequency
}

const EMPTY_ENABLED_TYPES: EnabledNudgeTypes = { risk: true, opportunity: true, tactical: true }

const EMPTY_DEAL_INTELLIGENCE: DealIntelligenceSettings = {
  enabled: false, // Beta — off by default, same as the hook it replaces
  sensitivity: 'balanced',
  enabledTypes: EMPTY_ENABLED_TYPES,
  frequency: 'balanced'
}

const DEAL_INTELLIGENCE_SENSITIVITIES: DealIntelligenceSensitivity[] = [
  'quiet',
  'balanced',
  'aggressive'
]
const ANALYSIS_FREQUENCIES: AnalysisFrequency[] = ['frequent', 'balanced', 'infrequent']

function sanitizeDealIntelligenceSensitivity(value: unknown): DealIntelligenceSensitivity {
  return DEAL_INTELLIGENCE_SENSITIVITIES.includes(value as DealIntelligenceSensitivity)
    ? (value as DealIntelligenceSensitivity)
    : 'balanced'
}

function sanitizeAnalysisFrequency(value: unknown): AnalysisFrequency {
  return ANALYSIS_FREQUENCIES.includes(value as AnalysisFrequency)
    ? (value as AnalysisFrequency)
    : 'balanced'
}

function sanitizeEnabledTypes(value: unknown): EnabledNudgeTypes {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    risk: typeof v.risk === 'boolean' ? v.risk : true,
    opportunity: typeof v.opportunity === 'boolean' ? v.opportunity : true,
    tactical: typeof v.tactical === 'boolean' ? v.tactical : true
  }
}

function sanitizeDealIntelligence(value: unknown): DealIntelligenceSettings {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    enabled: v.enabled === true,
    sensitivity: sanitizeDealIntelligenceSensitivity(v.sensitivity),
    enabledTypes: sanitizeEnabledTypes(v.enabledTypes),
    frequency: sanitizeAnalysisFrequency(v.frequency)
  }
}

/** Mirrors useDealIntelligenceSettings.ts's setTypeEnabled guard: never let
 *  a patch disable every nudge type at once — that's functionally the same
 *  as the master `enabled` switch, but silently, from a control that
 *  doesn't say "off." A patch that would leave all three false is rejected
 *  wholesale rather than partially applied. */
function mergeEnabledTypes(current: EnabledNudgeTypes, patch: unknown): EnabledNudgeTypes {
  if (!patch || typeof patch !== 'object') return current
  const p = patch as Record<string, unknown>
  const next: EnabledNudgeTypes = {
    risk: 'risk' in p ? p.risk === true : current.risk,
    opportunity: 'opportunity' in p ? p.opportunity === true : current.opportunity,
    tactical: 'tactical' in p ? p.tactical === true : current.tactical
  }
  if (!next.risk && !next.opportunity && !next.tactical) return current
  return next
}

function mergeDealIntelligence(
  current: DealIntelligenceSettings,
  patch: unknown
): DealIntelligenceSettings {
  if (!patch || typeof patch !== 'object') return current
  const p = patch as Record<string, unknown>
  return {
    enabled: 'enabled' in p ? p.enabled === true : current.enabled,
    sensitivity:
      'sensitivity' in p ? sanitizeDealIntelligenceSensitivity(p.sensitivity) : current.sensitivity,
    enabledTypes: mergeEnabledTypes(current.enabledTypes, p.enabledTypes),
    frequency: 'frequency' in p ? sanitizeAnalysisFrequency(p.frequency) : current.frequency
  }
}

export type CueSensitivity = 'low' | 'medium' | 'high'

export interface LiveCueSettings {
  enabled: boolean
  sensitivity: CueSensitivity
}

const EMPTY_LIVE_CUES: LiveCueSettings = {
  enabled: true, // default ON — same as the hook it replaces
  sensitivity: 'low'
}

const CUE_SENSITIVITIES: CueSensitivity[] = ['low', 'medium', 'high']

function sanitizeCueSensitivity(value: unknown): CueSensitivity {
  return CUE_SENSITIVITIES.includes(value as CueSensitivity) ? (value as CueSensitivity) : 'low'
}

function sanitizeLiveCues(value: unknown): LiveCueSettings {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : EMPTY_LIVE_CUES.enabled,
    sensitivity: sanitizeCueSensitivity(v.sensitivity)
  }
}

function mergeLiveCues(current: LiveCueSettings, patch: unknown): LiveCueSettings {
  if (!patch || typeof patch !== 'object') return current
  const p = patch as Record<string, unknown>
  return {
    enabled: 'enabled' in p ? p.enabled === true : current.enabled,
    sensitivity: 'sensitivity' in p ? sanitizeCueSensitivity(p.sensitivity) : current.sensitivity
  }
}

/**
 * M26 Phase 5 — per-lane job concurrency, user-adjustable. JobManager's own
 * DEFAULT_LANE_CONFIG (jobs/types.ts) hardcodes INTERACTIVE:2/BATCH:1/
 * MAINTENANCE:1 (LIVE stays fixed at unbounded — never exposed here, since
 * a live call must never wait behind anything, by the milestone's own
 * design). This is just the persisted override JobManager.configureLanes()
 * already accepts; nothing here duplicates the queueing logic itself.
 * Clamped to [1, 10] on every read — 0 would deadlock that lane forever
 * (nothing could ever start), and an absurd value is more likely a typo
 * than a deliberate choice.
 */
export interface JobConcurrencySettings {
  interactive: number
  batch: number
  maintenance: number
}

const EMPTY_JOB_CONCURRENCY: JobConcurrencySettings = { interactive: 2, batch: 1, maintenance: 1 }

function clampConcurrency(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(10, Math.round(value)))
    : fallback
}

function sanitizeJobConcurrency(value: unknown): JobConcurrencySettings {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    interactive: clampConcurrency(v.interactive, EMPTY_JOB_CONCURRENCY.interactive),
    batch: clampConcurrency(v.batch, EMPTY_JOB_CONCURRENCY.batch),
    maintenance: clampConcurrency(v.maintenance, EMPTY_JOB_CONCURRENCY.maintenance)
  }
}

function mergeJobConcurrency(
  current: JobConcurrencySettings,
  patch: unknown
): JobConcurrencySettings {
  if (!patch || typeof patch !== 'object') return current
  const p = patch as Record<string, unknown>
  return {
    interactive:
      'interactive' in p
        ? clampConcurrency(p.interactive, current.interactive)
        : current.interactive,
    batch: 'batch' in p ? clampConcurrency(p.batch, current.batch) : current.batch,
    maintenance:
      'maintenance' in p
        ? clampConcurrency(p.maintenance, current.maintenance)
        : current.maintenance
  }
}

/**
 * M26 Phase 5 — job-completion notification preferences. The in-app toast +
 * Activity Center badge (ActivityCenter.tsx) stay on unconditionally — that
 * IS the "persistent indicator in the app chrome" CLAUDE.md's spec actually
 * requires, and it's zero-friction (a rep who never looks never sees it).
 * This one dial controls only the OS-level popup (jobs/activity.ts's
 * showNativeNotification call, already gated to completions-only and
 * window-unfocused-only) — the layer that can genuinely interrupt whatever
 * ELSE the rep is doing on their machine. On by default, matching today's
 * unconditional behavior; this is the first time it's been optional at all.
 */
export interface JobNotificationSettings {
  nativeEnabled: boolean
}

const EMPTY_JOB_NOTIFICATIONS: JobNotificationSettings = { nativeEnabled: true }

function sanitizeJobNotifications(value: unknown): JobNotificationSettings {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    nativeEnabled:
      typeof v.nativeEnabled === 'boolean' ? v.nativeEnabled : EMPTY_JOB_NOTIFICATIONS.nativeEnabled
  }
}

function mergeJobNotifications(
  current: JobNotificationSettings,
  patch: unknown
): JobNotificationSettings {
  if (!patch || typeof patch !== 'object') return current
  const p = patch as Record<string, unknown>
  return {
    nativeEnabled: 'nativeEnabled' in p ? p.nativeEnabled === true : current.nativeEnabled
  }
}

/**
 * M23 Workstream D — Contact Intelligence. One dial controlling how
 * proactively the app surfaces/creates contacts from a call using whatever
 * identity signal is available (calendar match, resolved speaker identity,
 * or a post-hoc self-intro scan of the transcript):
 *   'off'       (default) — none of Workstream D's new behavior runs. The
 *                pre-existing calendar-match banner/auto-link (CrmSettings,
 *                unaffected by this flag) keeps working exactly as before.
 *   'suggest'   — the rep can click "Detect who this was" to run the
 *                post-hoc scan, and gets a dismissible "Create contact for
 *                X?" banner when a name is known — never automatic.
 *   'full-auto' — the detection scan runs proactively (once per call) with
 *                no click needed, but contact CREATION still always
 *                requires a click. This intentionally never crosses the
 *                "never auto-creates a contact" line that CrmSettings'
 *                autoLinkUnambiguous already draws (crm-settings.ts) —
 *                full-auto here means auto-DETECT, not auto-CREATE.
 */
export type ContactIntelligenceMode = 'off' | 'suggest' | 'full-auto'

export interface ContactIntelligenceSettings {
  mode: ContactIntelligenceMode
}

const EMPTY_CONTACT_INTELLIGENCE: ContactIntelligenceSettings = { mode: 'off' }

const CONTACT_INTELLIGENCE_MODES: ContactIntelligenceMode[] = ['off', 'suggest', 'full-auto']

function sanitizeContactIntelligenceMode(value: unknown): ContactIntelligenceMode {
  return CONTACT_INTELLIGENCE_MODES.includes(value as ContactIntelligenceMode)
    ? (value as ContactIntelligenceMode)
    : 'off'
}

function sanitizeContactIntelligence(value: unknown): ContactIntelligenceSettings {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return { mode: sanitizeContactIntelligenceMode(v.mode) }
}

function mergeContactIntelligence(
  current: ContactIntelligenceSettings,
  patch: unknown
): ContactIntelligenceSettings {
  if (!patch || typeof patch !== 'object') return current
  const p = patch as Record<string, unknown>
  return { mode: 'mode' in p ? sanitizeContactIntelligenceMode(p.mode) : current.mode }
}

/**
 * M25 — Sales Brain (Beta) master switch. Off by default, same pattern as
 * every other milestone's opt-in flag in this file. When off, NOTHING in
 * the memory module runs — no extraction, no consolidation, no DB writes —
 * this is the single gate every memory-touching call site checks first
 * (see memory-ipc.ts's isSalesBrainEnabled() re-export). Deliberately a
 * plain boolean, not a mode enum like ContactIntelligenceSettings — the
 * whole feature ships as one Beta unit, not staged suggest/full-auto tiers,
 * since (unlike Contact Intelligence) there's no "still requires a click"
 * middle ground here worth exposing yet.
 */
export interface SalesBrainSettings {
  enabled: boolean
}

const EMPTY_SALES_BRAIN: SalesBrainSettings = { enabled: false }

function sanitizeSalesBrain(value: unknown): SalesBrainSettings {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return { enabled: v.enabled === true }
}

function mergeSalesBrain(current: SalesBrainSettings, patch: unknown): SalesBrainSettings {
  if (!patch || typeof patch !== 'object') return current
  const p = patch as Record<string, unknown>
  return { enabled: 'enabled' in p ? p.enabled === true : current.enabled }
}

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
 * Speaker identification (M19 Task 2) — auto-resolving real names for
 * transcript speakers. Three independent switches with different risk
 * profiles, so one privacy-sensitive step being off never silently disables
 * the safe ones:
 *
 * - `enabled`: the cascade itself (user profile / calendar attendee / contact
 *   match / fallback "Speaker N") — none of these send anything to an LLM or
 *   a third party, so this defaults ON (the headline "resolved automatically"
 *   behavior).
 * - `allowSelfIntroExtraction`: extends the EXISTING M9 live-coaching LLM call
 *   (which already reads the transcript to find the REP's self-intro) to also
 *   extract the BUYER's name from their own self-intro. Off by default — this
 *   is buyer speech reaching a third-party LLM, which M11's consent framing
 *   never explicitly covered; ship it opt-in until that copy is reviewed.
 * - `voiceProfileMatching`: biometric voice-embedding matching across calls.
 *   Real regulatory weight (GDPR, BIPA) — off by default, and the matching
 *   engine itself is schema-only in this milestone (see voice-profile.ts).
 */
export interface SpeakerIdSettings {
  enabled: boolean
  allowSelfIntroExtraction: boolean
  voiceProfileMatching: boolean
}

const EMPTY_SPEAKER_ID: SpeakerIdSettings = {
  enabled: true,
  allowSelfIntroExtraction: false,
  voiceProfileMatching: false
}

function sanitizeSpeakerId(value: unknown): SpeakerIdSettings {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : EMPTY_SPEAKER_ID.enabled,
    allowSelfIntroExtraction: v.allowSelfIntroExtraction === true,
    voiceProfileMatching: v.voiceProfileMatching === true
  }
}

function mergeSpeakerId(current: SpeakerIdSettings, patch: unknown): SpeakerIdSettings {
  if (!patch || typeof patch !== 'object') return current
  const p = patch as Record<string, unknown>
  return {
    enabled: 'enabled' in p ? p.enabled === true : current.enabled,
    allowSelfIntroExtraction:
      'allowSelfIntroExtraction' in p
        ? p.allowSelfIntroExtraction === true
        : current.allowSelfIntroExtraction,
    voiceProfileMatching:
      'voiceProfileMatching' in p ? p.voiceProfileMatching === true : current.voiceProfileMatching
  }
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

/**
 * Merges appOverrides KEY BY KEY (send just the one changed {appId: value}),
 * not by replacing the whole map. A caller sending a full-map replacement
 * built from its own possibly-stale copy of the current overrides (e.g. two
 * quick per-app changes racing their own IPC round-trips) used to silently
 * drop whichever change's response came back first, once the second one's
 * save replaced the entire map with a map that never saw the first change.
 * `'default'` (or `null`) removes an override rather than setting one.
 */
function mergeAppOverridesPatch(
  current: Record<string, AppOverride>,
  patch: unknown
): Record<string, AppOverride> {
  if (!patch || typeof patch !== 'object') return current
  const p = patch as Record<string, unknown>
  const next = { ...current }
  for (const [appId, value] of Object.entries(p)) {
    if (value === 'default' || value === null) {
      delete next[appId]
      continue
    }
    const sanitized = sanitizeAppOverride(value)
    if (sanitized) next[appId] = sanitized
  }
  return next
}

function mergeCapturePolicy(current: CapturePolicySettings, patch: unknown): CapturePolicySettings {
  if (!patch || typeof patch !== 'object') return current
  const p = patch as Record<string, unknown>
  return {
    autoCapturePolicy:
      'autoCapturePolicy' in p
        ? sanitizeCapturePolicyValue(p.autoCapturePolicy, current.autoCapturePolicy)
        : current.autoCapturePolicy,
    appOverrides:
      'appOverrides' in p
        ? mergeAppOverridesPatch(current.appOverrides, p.appOverrides)
        : current.appOverrides
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
  /** M25 — the whole memory.db file, uploaded as one blob (Supabase
   *  Storage, same mechanism as attachments — see uploadSalesBrainDb() in
   *  backup.ts for the full reasoning). Off by default, same as every
   *  other opt-in category here: this is local-first data (the whole point
   *  of the feature — "your sales brain never leaves your device"), cloud
   *  backup is disaster recovery, not the default. Whole-file blob is a
   *  deliberately simpler v1 than the row-per-record sync every OTHER
   *  category here uses — correct today because memory is single-machine-
   *  scoped, and the known upgrade path if multi-device support ever ships
   *  (see docs/M25-sales-brain.md) is to switch this to row-level sync like
   *  everything else, not to redesign from scratch. */
  salesBrain: boolean
}

const EMPTY_SYNC_SCOPE: BackupSyncScope = {
  transcripts: false,
  attachments: false,
  knowledgeBase: false,
  settingsPersonalization: false,
  contacts: false,
  salesBrain: false
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
  /**
   * Standing consent: treat every call as already consented for buyer-side
   * capture, so the rep never clicks through the per-call consent step.
   *
   * This does NOT bypass consent — it RECORDS one. Each call still gets a real
   * ConsentRecord (status 'consented', method 'pre-agreed', timestamped), so
   * the sanitizeConsent invariant is untouched and the audit trail stays
   * honest about how consent was obtained. It is gated on
   * `allowOtherPartyRecording`, so the master switch still removes capability.
   *
   * Off by default: it is only defensible when the rep genuinely has a
   * standing basis (a recorded-line notice, a contract, or a one-party
   * jurisdiction), which only they can know.
   */
  alwaysRecordOtherParty: boolean
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
  /** Speaker identification (M19 Task 2) - auto-name-resolution cascade +
   *  two separate privacy-sensitive opt-ins. See SpeakerIdSettings. */
  speakerId: SpeakerIdSettings
  /** Which text-AI provider coaching/summaries/tasks/etc. use when a
   *  purpose has no aiModelAssignments chain configured - see src/main/ai/.
   *  Defaults to 'anthropic' (unchanged behavior for every existing
   *  install). The actual API key lives separately, encrypted, in
   *  ai-keys.ts - this is just which one is active, not a secret. */
  aiProvider: AIProviderId
  /** M20 - ordered per-job (AIPurpose) model-fallback chains, catalog-entry
   *  IDs. Empty chain for a purpose means "no explicit assignment" -
   *  completeWithFallback()'s resolution rule falls back to `aiProvider`
   *  above (if configured) before ever reaching the bundled default catalog
   *  chain, so an existing M16 install sees zero behavior change unless it
   *  opts into the new Settings → Model Assignment page. See
   *  ai/model-assignments.ts and ai/complete-with-fallback.ts. */
  aiModelAssignments: ModelAssignments
  /** M23 — when true, the updater downloads a newly available version
   *  automatically (no click needed) and installs it on the app's next
   *  natural quit, instead of requiring Download + Restart to be clicked
   *  manually. ON by default since 1.3.4 (M29, founder decision 2026-08-24):
   *  the 1.2.5/1.2.6 consent-leak hotfixes never reached installs whose
   *  users never clicked "Check for updates" — an updater that is off by
   *  default makes the app's own privacy fixes optional. Downloads happen in
   *  the background; the install only ever happens on a natural quit, never
   *  mid-session. Manual Check/Download/Install buttons keep working
   *  regardless of this, and turning it off is one toggle. */
  autoUpdateEnabled: boolean
  /** M29 one-time migration marker. Existing installs all have
   *  `autoUpdateEnabled: false` PERSISTED (the whole settings object is
   *  written), so flipping the default alone would reach nobody. While this
   *  marker is absent the load path overrides the stored value to ON —
   *  once, visibly (see autoUpdateNoticePending) — and records the marker,
   *  after which the user's own choice is never overridden again. */
  autoUpdateMigratedToDefaultOn: boolean
  /** Show the one-time "CallRise now keeps itself up to date" Home notice.
   *  Set by the migration (and for brand-new installs, whose users weren't
   *  asked either); cleared when the user dismisses the card. */
  autoUpdateNoticePending: boolean
  /** M23 Workstream A — Coach 2.0 master switch + methodology picker. Off by
   *  default; see Coach2Settings for the exact behavior change. */
  coach2: Coach2Settings
  /** M23 Workstream D — Contact Intelligence mode. Off by default; see
   *  ContactIntelligenceSettings for the exact behavior per mode. */
  contactIntelligence: ContactIntelligenceSettings
  /** M25 — Sales Brain (Beta) master switch. Off by default; see
   *  SalesBrainSettings for what this gates. */
  salesBrain: SalesBrainSettings
  /** M26 Phase 4.5.2 — Deal Intelligence (M24 beta) enable/sensitivity/
   *  per-type/frequency. Off by default; see DealIntelligenceSettings. */
  dealIntelligence: DealIntelligenceSettings
  /** M26 Phase 4.5.2 — live coaching cues (M9) enable/sensitivity. On by
   *  default; see LiveCueSettings. */
  liveCues: LiveCueSettings
  /** M26 Phase 5 — per-lane job concurrency override. See
   *  JobConcurrencySettings for defaults/bounds. */
  jobConcurrency: JobConcurrencySettings
  /** M26 Phase 5 — job-completion notification preferences. On by default;
   *  see JobNotificationSettings for exactly what this gates. */
  jobNotifications: JobNotificationSettings
}

// AIProviderId is re-exported here (not re-declared) so existing importers
// of app-settings.ts's AIProviderId keep working unchanged - the type now
// lives in src/main/ai/types.ts, the single source of truth (M20; this
// module used to hand-duplicate a 2-value union here, which was already a
// silent-drift risk at 2 providers and would have been worse at 8).
export type { AIProviderId } from './ai/types'

function sanitizeAIProvider(value: unknown): AIProviderId {
  const valid: AIProviderId[] = [
    'anthropic',
    'openai',
    'groq',
    'openrouter',
    'google',
    'nvidia',
    'cerebras',
    'mistral'
  ]
  return valid.includes(value as AIProviderId) ? (value as AIProviderId) : 'anthropic'
}

const EPOCH = new Date(0).toISOString()

const DEFAULT_SETTINGS: AppSettings = {
  allowOtherPartyRecording: true,
  alwaysRecordOtherParty: false,
  personalization: EMPTY_PERSONALIZATION,
  summaryLanguage: 'auto',
  syncScope: EMPTY_SYNC_SCOPE,
  settingsUpdatedAt: EPOCH,
  googleCalendarConnected: false,
  outlookCalendarConnected: false,
  crm: EMPTY_CRM_SETTINGS,
  objectionMining: EMPTY_OBJECTION_MINING,
  detection: EMPTY_DETECTION_SETTINGS,
  speakerId: EMPTY_SPEAKER_ID,
  aiProvider: 'anthropic',
  aiModelAssignments: DEFAULT_MODEL_ASSIGNMENTS,
  autoUpdateEnabled: true,
  autoUpdateMigratedToDefaultOn: true,
  // A fresh install wasn't asked either — it gets the same one-time notice.
  autoUpdateNoticePending: true,
  coach2: EMPTY_COACH2,
  contactIntelligence: EMPTY_CONTACT_INTELLIGENCE,
  salesBrain: EMPTY_SALES_BRAIN,
  dealIntelligence: EMPTY_DEAL_INTELLIGENCE,
  liveCues: EMPTY_LIVE_CUES,
  jobConcurrency: EMPTY_JOB_CONCURRENCY,
  jobNotifications: EMPTY_JOB_NOTIFICATIONS
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
    contacts: v.contacts === true,
    salesBrain: v.salesBrain === true
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
    contacts: 'contacts' in p ? p.contacts === true : current.contacts,
    salesBrain: 'salesBrain' in p ? p.salesBrain === true : current.salesBrain
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
      alwaysRecordOtherParty:
        typeof parsed.alwaysRecordOtherParty === 'boolean'
          ? parsed.alwaysRecordOtherParty
          : DEFAULT_SETTINGS.alwaysRecordOtherParty,
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
      detection: sanitizeDetectionSettings(parsed.detection),
      speakerId: sanitizeSpeakerId(parsed.speakerId),
      aiProvider: sanitizeAIProvider(parsed.aiProvider),
      aiModelAssignments: sanitizeModelAssignments(parsed.aiModelAssignments),
      // M29 migration (see the interface docs): until the marker is present,
      // the stored value is pre-decision data and is overridden to ON, with
      // the notice queued so the change is visible, not silent. After the
      // marker, the stored value is the user's own choice and always wins.
      autoUpdateEnabled:
        parsed.autoUpdateMigratedToDefaultOn === true ? parsed.autoUpdateEnabled === true : true,
      autoUpdateMigratedToDefaultOn: true,
      autoUpdateNoticePending:
        parsed.autoUpdateMigratedToDefaultOn === true
          ? parsed.autoUpdateNoticePending === true
          : true,
      coach2: sanitizeCoach2(parsed.coach2),
      contactIntelligence: sanitizeContactIntelligence(parsed.contactIntelligence),
      salesBrain: sanitizeSalesBrain(parsed.salesBrain),
      dealIntelligence: sanitizeDealIntelligence(parsed.dealIntelligence),
      liveCues: sanitizeLiveCues(parsed.liveCues),
      jobConcurrency: sanitizeJobConcurrency(parsed.jobConcurrency),
      jobNotifications: sanitizeJobNotifications(parsed.jobNotifications)
    }
  } catch {
    return {
      ...DEFAULT_SETTINGS,
      personalization: { ...EMPTY_PERSONALIZATION },
      crm: { ...EMPTY_CRM_SETTINGS },
      objectionMining: { ...EMPTY_OBJECTION_MINING },
      detection: { ...EMPTY_DETECTION_SETTINGS },
      speakerId: { ...EMPTY_SPEAKER_ID },
      aiModelAssignments: { ...DEFAULT_MODEL_ASSIGNMENTS },
      coach2: { ...EMPTY_COACH2 },
      contactIntelligence: { ...EMPTY_CONTACT_INTELLIGENCE },
      salesBrain: { ...EMPTY_SALES_BRAIN },
      dealIntelligence: { ...EMPTY_DEAL_INTELLIGENCE, enabledTypes: { ...EMPTY_ENABLED_TYPES } },
      liveCues: { ...EMPTY_LIVE_CUES },
      jobConcurrency: { ...EMPTY_JOB_CONCURRENCY },
      jobNotifications: { ...EMPTY_JOB_NOTIFICATIONS }
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
    alwaysRecordOtherParty:
      typeof p.alwaysRecordOtherParty === 'boolean'
        ? p.alwaysRecordOtherParty
        : current.alwaysRecordOtherParty,
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
    detection: mergeDetectionSettings(current.detection, p.detection),
    speakerId: mergeSpeakerId(current.speakerId, p.speakerId),
    aiProvider: 'aiProvider' in p ? sanitizeAIProvider(p.aiProvider) : current.aiProvider,
    aiModelAssignments: mergeModelAssignments(current.aiModelAssignments, p.aiModelAssignments),
    autoUpdateEnabled:
      'autoUpdateEnabled' in p ? p.autoUpdateEnabled === true : current.autoUpdateEnabled,
    // The marker only ever moves forward; a pre-migration payload (e.g. a
    // cloud-settings pull from an old install) cannot un-migrate a device.
    autoUpdateMigratedToDefaultOn:
      current.autoUpdateMigratedToDefaultOn || p.autoUpdateMigratedToDefaultOn === true,
    autoUpdateNoticePending:
      'autoUpdateNoticePending' in p
        ? p.autoUpdateNoticePending === true
        : current.autoUpdateNoticePending,
    coach2: mergeCoach2(current.coach2, p.coach2),
    contactIntelligence: mergeContactIntelligence(
      current.contactIntelligence,
      p.contactIntelligence
    ),
    salesBrain: mergeSalesBrain(current.salesBrain, p.salesBrain),
    dealIntelligence: mergeDealIntelligence(current.dealIntelligence, p.dealIntelligence),
    liveCues: mergeLiveCues(current.liveCues, p.liveCues),
    jobConcurrency: mergeJobConcurrency(current.jobConcurrency, p.jobConcurrency),
    jobNotifications: mergeJobNotifications(current.jobNotifications, p.jobNotifications)
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

/**
 * Called whenever a save flips `autoUpdateEnabled` — updater/index.ts
 * registers this so toggling the Settings switch starts/stops the periodic
 * background check immediately, instead of only taking effect on next
 * launch. Same callback-registration shape as onDetectionEnabledChanged.
 */
let onAutoUpdateEnabledChanged: (() => void) | null = null
export function setAutoUpdateEnabledChangedListener(fn: () => void): void {
  onAutoUpdateEnabledChanged = fn
}

/**
 * M26 Phase 5 — called whenever a save changes `jobConcurrency`, so a
 * mid-session Settings edit calls JobManager.configureLanes() immediately
 * instead of only taking effect on next launch. Registered from index.ts
 * (not a dedicated service module — JobManager is constructed and owned
 * directly in index.ts, unlike detection/updater which have their own
 * registerXxx() files). Same callback-registration shape as
 * onDetectionEnabledChanged.
 */
let onJobConcurrencyChanged: (() => void) | null = null
export function setJobConcurrencyChangedListener(fn: () => void): void {
  onJobConcurrencyChanged = fn
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
  if (current.autoUpdateEnabled !== next.autoUpdateEnabled && onAutoUpdateEnabledChanged) {
    try {
      onAutoUpdateEnabledChanged()
    } catch {
      /* never fail the settings save over this */
    }
  }
  if (
    JSON.stringify(current.jobConcurrency) !== JSON.stringify(next.jobConcurrency) &&
    onJobConcurrencyChanged
  ) {
    try {
      onJobConcurrencyChanged()
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
 *   - THIS device's autoUpdateEnabled is preserved, for the same reason
 *     (M29 sweep item 5). Whether this machine downloads and executes new
 *     software is a per-device decision in exactly the sense syncScope is:
 *     a laptop on metered tethering may say no while the desktop says yes.
 *     Before this, the pref fell through the generic merge, and because the
 *     pushed payload is the WHOLE settings object it always carried a value —
 *     so one unrelated edit on device B silently re-enabled auto-update on
 *     device A and started its background check on the spot. That is the
 *     "overridden exactly once, ever" promise broken by a side door: the
 *     forward-only migration marker guards the pre-migration case, and
 *     nobody guarded the simpler post-migration one.
 */
export function applyPulledSettings(payload: unknown, cloudUpdatedAt: string): AppSettings {
  const current = loadAppSettings()
  const next = mergeSettings(current, payload)
  next.syncScope = current.syncScope
  next.autoUpdateEnabled = current.autoUpdateEnabled
  next.autoUpdateMigratedToDefaultOn = current.autoUpdateMigratedToDefaultOn
  next.settingsUpdatedAt =
    typeof cloudUpdatedAt === 'string' && !Number.isNaN(Date.parse(cloudUpdatedAt))
      ? cloudUpdatedAt
      : current.settingsUpdatedAt
  persistSettings(next)
  // A cloud-pulled change to detection.enabled must take effect on this
  // device immediately too, same as a local edit (saveAppSettings, above) -
  // otherwise a pulled "on" (or "off") sits correctly on disk and in the
  // Settings UI while the live CallDetector silently keeps its old
  // running/stopped state until the app is next restarted.
  if (current.detection.enabled !== next.detection.enabled && onDetectionEnabledChanged) {
    try {
      onDetectionEnabledChanged()
    } catch {
      /* never fail the pull over this */
    }
  }
  if (current.autoUpdateEnabled !== next.autoUpdateEnabled && onAutoUpdateEnabledChanged) {
    try {
      onAutoUpdateEnabledChanged()
    } catch {
      /* never fail the pull over this */
    }
  }
  if (
    JSON.stringify(current.jobConcurrency) !== JSON.stringify(next.jobConcurrency) &&
    onJobConcurrencyChanged
  ) {
    try {
      onJobConcurrencyChanged()
    } catch {
      /* never fail the pull over this */
    }
  }
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

/** M19 Task 2's cascade gate — calendar/contact/fallback resolution only. */
export function isSpeakerIdEnabled(): boolean {
  return loadAppSettings().speakerId.enabled
}

/** The gate updater/index.ts checks before enabling autoDownload/
 *  autoInstallOnAppQuit and starting its periodic background check. */
export function isAutoUpdateEnabled(): boolean {
  return loadAppSettings().autoUpdateEnabled
}

/** The specific gate live-cue.ts must check before asking the LLM to extract
 *  the BUYER's name from their self-intro — buyer speech reaching a
 *  third-party LLM, opt-in only. */
export function isSelfIntroExtractionAllowed(): boolean {
  const s = loadAppSettings().speakerId
  return s.enabled && s.allowSelfIntroExtraction
}

/** The single gate coach.ts must check before computing/storing anything
 *  from Workstream A (skills, benchmarks, methodology adherence). Off means
 *  the post-call scorecard is byte-for-byte the pre-M23 shape. */
export function isCoach2Enabled(): boolean {
  return loadAppSettings().coach2.enabled
}

/** M23 Workstream C — the gate crm-note-generator-ipc.ts checks before
 *  drafting a note or harvesting KYC facts. Off means the standalone
 *  generator is fully inert, not just hidden in the renderer. */
export function isNoteGeneratorEnabled(): boolean {
  return loadAppSettings().crm.noteGeneratorEnabled
}

/** M23 Workstream D — the gate contact-intelligence-ipc.ts checks before
 *  running the post-hoc self-intro scan. 'off' means it's fully inert, not
 *  just hidden in the renderer. */
export function getContactIntelligenceMode(): ContactIntelligenceMode {
  return loadAppSettings().contactIntelligence.mode
}

/** M25 — the single gate every Sales Brain call site checks first (memory
 *  extraction, consolidation, retrieval, injection). Off means the memory
 *  module does nothing at all — no DB writes, no AI calls, no injected
 *  context anywhere else in the app. Also independently gated at startup
 *  (index.ts only opens/migrates memory.db at all if this is true — see
 *  that module's own comment), so a user who never opts in never even pays
 *  the cost of the DB file existing. */
export function isSalesBrainEnabled(): boolean {
  return loadAppSettings().salesBrain.enabled
}

/** M26 Phase 4.5.2 — the single source of truth the main-owned Deal
 *  Intelligence engine (4.5.3) reads its enable/sensitivity/enabledTypes/
 *  frequency settings from, replacing the renderer-local
 *  useDealIntelligenceSettings.ts hook. Read fresh on every call, same
 *  discipline as every other settings gate in this file — a rep who just
 *  disabled the feature must not have a stale main-side copy keep acting on
 *  the old value. */
export function getDealIntelligenceSettings(): DealIntelligenceSettings {
  return loadAppSettings().dealIntelligence
}

/** M26 Phase 4.5.2 — same role as getDealIntelligenceSettings(), for the
 *  main-owned cue engine (4.5.4), replacing useCueSettings.ts. */
export function getLiveCueSettings(): LiveCueSettings {
  return loadAppSettings().liveCues
}

/** M26 Phase 5 — the gate index.ts reads at startup (applied via
 *  JobManager.configureLanes()) and again on every live change via
 *  setJobConcurrencyChangedListener. */
export function getJobConcurrencySettings(): JobConcurrencySettings {
  return loadAppSettings().jobConcurrency
}

/** M26 Phase 5 — the gate jobs/activity.ts checks before showing an OS-level
 *  notification for a finished job. Read fresh on every event, not cached
 *  at wiring time, so a mid-session toggle takes effect on the very next
 *  completion rather than needing a restart. */
export function isJobNativeNotificationsEnabled(): boolean {
  return loadAppSettings().jobNotifications.nativeEnabled
}

let registered = false

export function registerAppSettings(): void {
  if (registered) return
  registered = true
  ipcMain.handle('settings:get', (): AppSettings => loadAppSettings())
  ipcMain.handle('settings:update', async (_event, patch: unknown): Promise<AppSettings> => {
    const wasEnabled = loadAppSettings().salesBrain.enabled
    const next = saveAppSettings(patch)
    if (!wasEnabled && next.salesBrain.enabled) {
      // memory.db is normally only ever opened once, at app startup, gated
      // on this same flag (see memory-runtime.ts's initSalesBrain doc
      // comment) - which means flipping this toggle on mid-session, without
      // restarting the app, left getMemoryDb() returning null for the rest
      // of the session. Every Sales Brain IPC handler already treats a null
      // DB as "not ready" and fails soft, so nothing crashed - it just did
      // nothing, silently, for the whole session. Dynamic import to avoid a
      // circular dependency (memory-runtime.ts imports isSalesBrainEnabled
      // from this file).
      const { initSalesBrain } = await import('./memory/memory-runtime')
      await initSalesBrain().catch((err) => {
        console.error('[sales-brain] live init on enable failed:', err)
      })
    }
    return next
  })
  // Shows exactly what text the AI would be given about the rep, so
  // Personalization isn't a black box (same idea as knowledge:preview).
  ipcMain.handle('settings:previewPersonalization', (): { text: string; charCount: number } => {
    const text = assemblePersonalizationContext(loadAppSettings().personalization)
    return { text, charCount: text.length }
  })
}
