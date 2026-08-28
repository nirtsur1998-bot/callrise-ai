// BUG-057 Part 3 — persistence + IPC for purpose-health.ts's pure logic.
// One small JSON file, same shape as focus-skill-fs.ts: async I/O, atomic
// write, a safe empty-health default on any read failure. Kept OUT of
// app-settings.ts deliberately — this updates on every completeWithFallback()
// call (coaching-cue can fire every ~2.5s mid-call), not a rare settings
// edit, and is state the loop derives, not a preference the rep sets
// directly (same reasoning focus-skill-fs.ts's own header already states).
//
// In-memory cache, unlike focus-skill-fs.ts's load-on-every-read: at
// coaching-cue's cadence, hitting disk on every read AND every write would
// be needless I/O for state that's only ever read by a slow-polling
// Settings page and the rare app-restart case. Writes are fire-and-forget
// (never awaited by the caller, never let a persistence failure touch the
// actual AI call it's describing) — same posture as fallback-log.ts.
import { app, ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { PROVIDER_REGISTRY } from './registry'
import {
  emptyHealth,
  messageFor,
  recordFailure,
  recordSuccess,
  severityOf,
  type FailureInfo,
  type PurposeHealth,
  type PurposeSeverity,
  type SuccessInfo
} from './purpose-health'
import type { AIPurpose, AIProviderId } from './types'
import { signalAiPurposeFailure, signalAiPurposeRecovered } from '../telemetry/signals'
import { writeJsonAtomic } from '../atomic-write'
import { isSalesBrainEnabled } from '../app-settings'

const ALL_PURPOSES: AIPurpose[] = [
  'coaching-cue',
  'summary',
  'scorecard',
  'tasks',
  'other',
  'prep-brief',
  'deal-tier1',
  'deal-tier2',
  'coaching-chat',
  'memory-extract',
  'memory-consolidate',
  'memory-reflect',
  'assistant-chat'
]

type HealthMap = Record<AIPurpose, PurposeHealth>

function emptyHealthMap(): HealthMap {
  const map = {} as HealthMap
  for (const p of ALL_PURPOSES) map[p] = emptyHealth()
  return map
}

function healthPath(): string {
  return join(app.getPath('userData'), 'ai-purpose-health.json')
}

/** Rebuilds key-by-key from whatever's on disk, same convention as
 *  model-assignments.ts's sanitizeModelAssignments() — a corrupt or
 *  partial file degrades to empty health per-purpose, never a hard
 *  failure, and a 13th purpose added later gets emptyHealth() for free
 *  rather than needing a migration. */
function sanitize(value: unknown): HealthMap {
  const result = emptyHealthMap()
  if (!value || typeof value !== 'object') return result
  const raw = value as Record<string, unknown>
  for (const p of ALL_PURPOSES) {
    const entry = raw[p]
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Partial<PurposeHealth>
    result[p] = {
      consecutiveFailures: typeof e.consecutiveFailures === 'number' ? e.consecutiveFailures : 0,
      failureEpisodes: typeof e.failureEpisodes === 'number' ? e.failureEpisodes : 0,
      firstFailureAt: typeof e.firstFailureAt === 'string' ? e.firstFailureAt : null,
      lastFailureAt: typeof e.lastFailureAt === 'string' ? e.lastFailureAt : null,
      lastFailureReason: (e.lastFailureReason as PurposeHealth['lastFailureReason']) ?? null,
      lastFailureProviderId: (e.lastFailureProviderId as AIProviderId | null) ?? null,
      lastFailureDetail: typeof e.lastFailureDetail === 'string' ? e.lastFailureDetail : null,
      lastFailureClass: (e.lastFailureClass as PurposeHealth['lastFailureClass']) ?? null,
      lastFailureResetsAt: typeof e.lastFailureResetsAt === 'number' ? e.lastFailureResetsAt : null,
      lastSuccessAt: typeof e.lastSuccessAt === 'string' ? e.lastSuccessAt : null,
      lastSuccessProviderId: (e.lastSuccessProviderId as AIProviderId | null) ?? null,
      substitutingSince: typeof e.substitutingSince === 'string' ? e.substitutingSince : null,
      substituteSuccesses: typeof e.substituteSuccesses === 'number' ? e.substituteSuccesses : 0,
      substituteProviderId: (e.substituteProviderId as AIProviderId | null) ?? null
    }
  }
  return result
}

let cache: HealthMap | null = null
let loadPromise: Promise<HealthMap> | null = null

async function ensureLoaded(): Promise<HealthMap> {
  if (cache) return cache
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const raw = await fs.readFile(healthPath(), 'utf8')
        cache = sanitize(JSON.parse(raw))
      } catch {
        cache = emptyHealthMap() // no file yet, or unreadable — safe default
      }
      return cache
    })()
  }
  return loadPromise
}

function persist(): void {
  if (!cache) return
  // Fire-and-forget, deliberately: a persistence failure here must never
  // surface to (or slow down) the actual AI call that triggered it — same
  // posture as fallback-log.ts's logFallbackEvent(). The promise itself is
  // still tracked (not truly fire-and-forget) so tests can await
  // flushPendingWritesForTests() instead of guessing a settle delay -- the
  // caller-facing recordAiSuccess/recordAiFailure never await it, which is
  // what keeps it non-blocking for the real AI call in production.
  pendingWrite = (async () => {
    try {
      await fs.mkdir(app.getPath('userData'), { recursive: true })
      await writeJsonAtomic(healthPath(), cache)
    } catch {
      /* best-effort — the in-memory cache stays correct for this session either way */
    }
  })()
}

let pendingWrite: Promise<void> | null = null

/** Test-only. Every recordAiSuccess/recordAiFailure call already resolves
 *  once the in-memory update is applied — only the trailing disk write is
 *  genuinely fire-and-forget, and this is what lets a test wait for THAT
 *  specific write to land before asserting against a fresh module reload,
 *  or before the test ends (a write racing an afterEach's temp-dir cleanup
 *  is a real, previously-flaky failure mode this closes). */
export async function flushPendingWritesForTests(): Promise<void> {
  await pendingWrite
}

export async function recordAiSuccess(purpose: AIPurpose, info: SuccessInfo): Promise<void> {
  const map = await ensureLoaded()
  // M29 A2 — recovery is the other half of a failure RATE: how long was the
  // purpose down, in failures? Read BEFORE recordSuccess resets the streak.
  const priorStreak = map[purpose]?.consecutiveFailures ?? 0
  map[purpose] = recordSuccess(map[purpose], new Date().toISOString(), info)
  if (priorStreak > 0) {
    signalAiPurposeRecovered({ purpose, afterConsecutiveFailures: priorStreak })
  }
  persist()
}

export async function recordAiFailure(purpose: AIPurpose, info: FailureInfo): Promise<void> {
  const map = await ensureLoaded()
  map[purpose] = recordFailure(map[purpose], new Date().toISOString(), info)
  // M29 A2 — the aggregate signal. Deliberately NOT info.detail: that is the
  // provider's raw error prose (it can echo request fragments) and stays on
  // this machine; the signal carries only the code, the class, the vendor.
  signalAiPurposeFailure({
    purpose,
    failureClass: info.failureClass ?? 'unknown',
    code: info.reason,
    providerId: info.providerId ?? undefined
  })
  persist()
}

/** purpose-health.ts's messageFor() returns action: 'model-assignment', but
 *  the real renderer SettingsPageId for that page is 'ai-models' (confirmed
 *  by direct read of settings-nav.ts — no 'model-assignment' page id
 *  exists). Translated here, at the IPC boundary, rather than inside
 *  purpose-health.ts itself, so that already-reviewed pure-logic module
 *  never needs to know a renderer-side naming detail. */
function toSettingsPageId(
  action: 'ai-setup' | 'model-assignment' | null
): 'ai-setup' | 'ai-models' | null {
  if (action === 'model-assignment') return 'ai-models'
  return action
}

export interface PurposeHealthView {
  severity: PurposeSeverity
  message: string
  actionPageId: 'ai-setup' | 'ai-models' | null
}

async function viewFor(purpose: AIPurpose): Promise<PurposeHealthView> {
  const map = await ensureLoaded()
  const h = map[purpose]
  // Read fresh at evaluation time, never snapshotted — same fresh-read rule
  // as every other privacy/state gate in this codebase (see BUG-027,
  // BUG-056): a feature the user just disabled must not keep asserting a
  // failure streak against it forever. Only the three memory-* purposes are
  // gated by Sales Brain; everything else has no equivalent master switch.
  const featureEnabled = purpose.startsWith('memory-') ? isSalesBrainEnabled() : true
  const anyTextKeyConfigured = Object.values(PROVIDER_REGISTRY).some(
    (p) => !!process.env[p.keyEnvName]?.trim()
  )
  const severity = severityOf(h, Date.now(), { featureEnabled, anyTextKeyConfigured })
  const relevantProviderId =
    severity === 'substituting' ? h.substituteProviderId : h.lastFailureProviderId
  const providerName = relevantProviderId
    ? PROVIDER_REGISTRY[relevantProviderId].displayName
    : 'your AI provider'
  const { text, action } =
    severity === 'substituting'
      ? {
          text: `Running on ${providerName} instead of your chosen provider — resumes automatically once it's reachable again.`,
          action: null as 'ai-setup' | 'model-assignment' | null
        }
      : messageFor(h, providerName)
  return { severity, message: text, actionPageId: toSettingsPageId(action) }
}

export function registerPurposeHealthStore(): void {
  ipcMain.handle('purposeHealth:getAll', async () => {
    const result = {} as Record<AIPurpose, PurposeHealthView>
    for (const p of ALL_PURPOSES) result[p] = await viewFor(p)
    return result
  })
}

/** Test-only. */
export function resetPurposeHealthForTests(): void {
  cache = null
  loadPromise = null
}
