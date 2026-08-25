// M29 A2 — the health-signal catalog. THE closed set of aggregate signals the
// app may emit, each one a counter or an enum, each designed against a real
// incident (the brief's test: "would this have caught BUG-080 / the Sales
// Brain native-module failure / the 1.3.0 gap within days?"). No content, no
// ids of calls/contacts/deals, no free text — everything here flows through
// record(), so it is consent-gated, token-validated, scrubbed and bounded
// before a byte can exist.
//
// Adding a signal = adding a function HERE with the incident it would catch
// written above it. Callers never invent event names.

import { record, type PropValue } from './index'

/** BUG-058 / BUG-081 / BUG-082 class — an AI purpose failing repeatedly
 *  (dead default model, rate-limit spiral, too-thin fallback tail). One
 *  event per recorded failure; rates and classes are computed server-side.
 *  `providerId` is which vendor failed — config metadata, not content; it
 *  is what makes "Groq's default model is dead for everyone" visible. */
export function signalAiPurposeFailure(props: {
  purpose: string
  failureClass: string
  code: string
  providerId?: string
}): void {
  const p: Record<string, PropValue> = {
    purpose: props.purpose,
    failureClass: props.failureClass,
    code: props.code
  }
  if (props.providerId) p.providerId = props.providerId
  record('health', 'ai.purpose.failed', p)
}

/** The other half of failure RATE: a purpose coming back after a streak.
 *  `afterConsecutiveFailures` sizes the outage without any timestamps. */
export function signalAiPurposeRecovered(props: {
  purpose: string
  afterConsecutiveFailures: number
}): void {
  record('health', 'ai.purpose.recovered', {
    purpose: props.purpose,
    afterConsecutiveFailures: props.afterConsecutiveFailures
  })
}

/** Job failure rates by type (the brief's list). Every terminal transition,
 *  succeeded included — a failure RATE needs a denominator. `jobType` is a
 *  code identifier ('summarize-call'), never a title (titles can carry
 *  names; the event model would reject them anyway — no whitespace). */
export function signalJobFinished(props: {
  jobType: string
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
  code?: string
}): void {
  const p: Record<string, PropValue> = { jobType: props.jobType, outcome: props.outcome }
  if (props.code) p.code = props.code
  record('health', 'job.finished', p)
}

/** Update success/failure (the brief's list) — is the updater itself broken
 *  in the field? 'refused' is our own gate rejecting a manifest (policy.ts):
 *  rare and always worth seeing. 'error' carries the error CLASS only. */
export function signalUpdateOutcome(props: {
  outcome: 'available' | 'refused' | 'downloaded' | 'error' | 'install-requested'
  code?: string
}): void {
  const p: Record<string, PropValue> = { outcome: props.outcome }
  if (props.code) p.code = props.code
  record('health', 'update.outcome', p)
}

/** BUG-087's lesson, generalised: cloud-backup sub-steps are best-effort by
 *  design (a push must never block local work), which means a permanently
 *  failing sub-step is SILENT by design — this is the aggregate view that
 *  makes "the sales-brain upload has failed for everyone since M25" a
 *  same-week query instead of a year-later archaeology find. */
export function signalBackupStepFailed(props: { step: string; code?: string }): void {
  const p: Record<string, PropValue> = { step: props.step }
  if (props.code) p.code = props.code
  record('health', 'backup.stepFailed', p)
}

/** The Sales-Brain-dead-on-a-clean-Windows class (be512bc): a native module
 *  that loads on every dev machine and CI runner and fails on real installs
 *  (ERROR_MOD_NOT_FOUND). One event per load attempt outcome — the first
 *  stranger's first launch makes it visible, minutes not weeks. */
const nativeLoadReported = new Set<string>()

export function signalNativeLoad(props: {
  module: string
  ok: boolean
  errorClass?: string
}): void {
  // Once per module per process: loads repeat (every openMemoryDb call, every
  // isSupported() poll) but the OUTCOME is a per-launch fact. First one wins.
  if (nativeLoadReported.has(props.module)) return
  nativeLoadReported.add(props.module)
  const p: Record<string, PropValue> = { module: props.module, ok: props.ok }
  if (props.errorClass) p.errorClass = props.errorClass
  record('health', 'native.load', p)
}

/** Test hook — the once-guard is process-wide state. */
export function resetNativeLoadSignalForTests(): void {
  nativeLoadReported.clear()
}

const lastTier1Key = { value: '' }

/** The 1.3.0 Tier 1 class: engine silently absent (engineAvailable false for
 *  every Windows install — the missing extraResources block), and the
 *  df_create silent-passthrough (engine up, pipe connected, nothing
 *  denoised). Emitted on CHANGE of the state tuple only, so polling never
 *  floods the queue. */
export function signalTier1State(props: {
  engineAvailable: boolean
  engineRunning: boolean
  denoisingActive: boolean | null
}): void {
  // The enabled PREF lives in renderer localStorage where main can't read it
  // honestly; engineRunning already means "the user has it on and started".
  const key = `${props.engineAvailable}|${props.engineRunning}|${String(props.denoisingActive)}`
  if (key === lastTier1Key.value) return
  lastTier1Key.value = key
  record('health', 'tier1.state', {
    engineAvailable: props.engineAvailable,
    engineRunning: props.engineRunning,
    // null = engine not running / unknown; encode as a 3-state token.
    denoising: props.denoisingActive === null ? 'unknown' : String(props.denoisingActive)
  })
}

/** Test hook — the change-only guard is process-wide state. */
export function resetTier1SignalForTests(): void {
  lastTier1Key.value = ''
}

/** THE BUG-080 detector: question-scoped retrieval returning nothing. A 100%
 *  zero-result rate across installs that HAVE memories is the 0/14-recall
 *  bug as a dashboard row within days of a release, instead of a harness
 *  find nine days later. Counts only — never the query, never the results.
 *
 *  WIRING NOTE: the one-line call belongs at the end of retrieval in
 *  src/main/memory/rag.ts — deliberately NOT wired yet, because rag.ts is
 *  an M28-shared file (M28 rebuilt retrieval as
 *  retrieveRelevantMemoriesStructured) and shared-file changes are
 *  coordinated through the founder. Add the call after the M28 merge. */
export function signalRetrievalQuery(props: { resultCount: number }): void {
  record('health', 'retrieval.query', {
    resultCount: props.resultCount,
    zero: props.resultCount === 0
  })
}

/** A3 — feature usage, coarse (the brief: counts only, no content, no
 *  timings tied to identifiable patterns). One event per section OPEN at the
 *  navigation level; what the user does inside is not tracked (job.finished
 *  already counts AI actions by type). The allowlist is the NavId union —
 *  main validates, so a compromised or drifted renderer cannot invent event
 *  vocabulary. Feeds Workstream B's "know what's used before pricing it". */
export const FEATURE_IDS = new Set([
  'home',
  'live-calls',
  'past-calls',
  'tasks',
  'crm',
  'calendar',
  'coaching',
  'analytics',
  'team',
  'knowledge',
  'settings'
])

export function signalFeatureOpened(feature: unknown): boolean {
  if (typeof feature !== 'string' || !FEATURE_IDS.has(feature)) return false
  record('usage', 'feature.opened', { feature })
  return true
}

/** Consent-flow errors (the brief's list): a consent WRITE failing is
 *  fail-closed and correct but today invisible (audit §1.5) — a spike of
 *  these in the field means people are being denied a capability they said
 *  yes to, or a disk/profile problem is eating the gate's state. Never the
 *  call id, never the method, never who. */
export function signalConsentFlowError(props: {
  op: 'write' | 'read' | 'clear'
  code?: string
}): void {
  const p: Record<string, PropValue> = { op: props.op }
  if (props.code) p.code = props.code
  record('health', 'consent.flowError', p)
}
