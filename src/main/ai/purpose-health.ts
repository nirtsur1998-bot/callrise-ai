// BUG-057 — per-purpose AI health: the state that makes "this feature has
// been failing every attempt for two days" an answerable question.
//
// Pure logic, no Electron import, same convention as objection-scan-tally.ts
// and crm-note-generator.ts. Persistence and IPC live in purpose-health-store.ts.
//
// WHY THIS EXISTS AS STATE RATHER THAN A LOG QUERY. ai-fallback-events.jsonl
// records ONLY failures — logFallbackEvent is called exclusively from catch
// blocks. Two failure events 48 hours apart are byte-identical whether zero or
// ten thousand successes happened in between, so "consecutive" is not
// computable from that file at any level of cleverness. It also can't be
// fixed by logging successes there: retention is a single global 1000-entry
// cap shared across all purposes (two backfill runs consumed 198 slots in 52
// minutes on the founder's machine), pruning is a read-modify-write after
// every append, and coaching-cue fires roughly every 2.5s mid-call. A counter
// is state — twelve purposes times a few scalars — not events.
import type { AIProviderErrorCode, AIProviderId } from './types'

/** Three separate failure occasions. Not a new number: it is
 *  objection-scan-tally.ts's CONSECUTIVE_FAILURE_LIMIT, the same "three in a
 *  row means the API is down, not a fluke" judgment this codebase already
 *  made once. Referenced rather than imported — that constant belongs to the
 *  objection scan's own run-local circuit breaker, and a cross-feature import
 *  would tie two unrelated policies together. */
export const FAILURE_EPISODE_LIMIT = 3

/** Failures closer together than this are ONE episode.
 *
 *  A batch loop makes raw failure counts meaningless: one backfill run on the
 *  founder's machine produced 99 exhausted chains in 26 seconds, so "3 in a
 *  row" would mean "one bad half-minute" — exactly the blip this threshold
 *  exists to ignore. Verified against the real 205-event log: at a 60s gap
 *  those collapse to 8 episodes, and the 3rd episode lands at the same
 *  instant as the 3rd raw failure, so this costs zero detection latency on
 *  the incident it was designed for. */
export const EPISODE_GAP_MS = 60_000

/** The streak's own DURATION, not its age.
 *
 *  A burst of failures inside a couple of minutes is a Wi-Fi handoff or a
 *  captive portal, not a broken feature, and a banner that flickers during a
 *  network blip teaches people to ignore banners. Measuring `now -
 *  firstFailureAt` instead would grow forever, which DELAYS blips into
 *  permanent alarms rather than suppressing them — a 5-minute outage that
 *  self-healed would produce an overnight banner. */
export const MIN_STREAK_SPAN_MS = 15 * 60_000

/** No recent failure means no live problem. Without this, quitting on Friday
 *  after one blip and reopening Monday asserts a three-day outage before a
 *  single AI call has been made. 72h rather than 24h so it comfortably
 *  exceeds the slowest purpose's natural cadence (memory-reflect is nightly). */
export const EVIDENCE_MAX_MS = 72 * 60 * 60_000

/** The founder's own number, and the escape hatch for rarely-fired purposes
 *  that can't reach 3 episodes quickly. Requires >= 2 episodes so a single
 *  Friday-afternoon blip can never become a Monday-morning accusation, and
 *  falls back to firstFailureAt when there has NEVER been a success — the
 *  never-worked user is the one most in need of a signal. */
export const STALE_MS = 48 * 60 * 60_000

/** Two successes on a substitute, spanning this long, before saying so. One
 *  transient substitution that worked is the system doing its job, not news. */
export const MIN_SUBSTITUTION_SPAN_MS = 30 * 60_000

export interface PurposeHealth {
  /** Whole-CALL failures in a row (chain exhausted, or no chain at all),
   *  never per failed step — otherwise "N in a row" would silently mean
   *  something different before and after Part 1 changed chain lengths. This
   *  is the honest number to SHOW ("205 attempts"); failureEpisodes is what
   *  actually trips the indicator. */
  consecutiveFailures: number
  failureEpisodes: number
  firstFailureAt: string | null
  lastFailureAt: string | null
  lastFailureReason: AIProviderErrorCode | null
  lastFailureProviderId: AIProviderId | null
  lastFailureDetail: string | null
  lastSuccessAt: string | null
  lastSuccessProviderId: AIProviderId | null
  /** When the current substitute-only run began; null while a step the user
   *  actually chose is serving. Drives the "running on a substitute" notice. */
  substitutingSince: string | null
  substituteSuccesses: number
  substituteProviderId: AIProviderId | null
}

export type PurposeSeverity = 'ok' | 'not-configured' | 'substituting' | 'failing'

export function emptyHealth(): PurposeHealth {
  return {
    consecutiveFailures: 0,
    failureEpisodes: 0,
    firstFailureAt: null,
    lastFailureAt: null,
    lastFailureReason: null,
    lastFailureProviderId: null,
    lastFailureDetail: null,
    lastSuccessAt: null,
    lastSuccessProviderId: null,
    substitutingSince: null,
    substituteSuccesses: 0,
    substituteProviderId: null
  }
}

const ms = (iso: string | null): number => (iso ? Date.parse(iso) : 0)

export interface SuccessInfo {
  providerId: AIProviderId
  /** True when the model that served this call was one the app appended
   *  behind the user's chosen provider (Part 1's implicit tail) — NOT merely
   *  "not the first entry", which is also true of a chain the user authored
   *  themselves and would make this notice fire constantly and wrongly. */
  fromImplicitTail: boolean
}

export function recordSuccess(h: PurposeHealth, at: string, info: SuccessInfo): PurposeHealth {
  const next: PurposeHealth = {
    ...h,
    // Any success clears the streak entirely — the indicator clears itself,
    // so it never needs dismissing.
    consecutiveFailures: 0,
    failureEpisodes: 0,
    firstFailureAt: null,
    lastSuccessAt: at,
    lastSuccessProviderId: info.providerId
  }
  if (info.fromImplicitTail) {
    next.substitutingSince = h.substitutingSince ?? at
    next.substituteSuccesses = h.substituteSuccesses + 1
    next.substituteProviderId = info.providerId
  } else {
    // A model the user actually chose is serving again — nothing to report.
    next.substitutingSince = null
    next.substituteSuccesses = 0
    next.substituteProviderId = null
  }
  return next
}

export interface FailureInfo {
  reason: AIProviderErrorCode
  providerId: AIProviderId | null
  detail?: string
}

export function recordFailure(h: PurposeHealth, at: string, info: FailureInfo): PurposeHealth {
  const gap = h.lastFailureAt === null ? Infinity : ms(at) - ms(h.lastFailureAt)
  const startsNewEpisode = gap > EPISODE_GAP_MS
  return {
    ...h,
    consecutiveFailures: h.consecutiveFailures + 1,
    failureEpisodes: h.failureEpisodes + (startsNewEpisode ? 1 : 0),
    firstFailureAt: h.firstFailureAt ?? at,
    lastFailureAt: at,
    lastFailureReason: info.reason,
    lastFailureProviderId: info.providerId,
    lastFailureDetail: info.detail ?? null
  }
}

export interface SeverityContext {
  /** Read FRESH at evaluation time, never snapshotted. Turning Sales Brain
   *  off stops all memory-extract calls outright (memory-hooks.ts returns
   *  early), so the streak could never reset — without this the banner would
   *  latch forever on a feature the user deliberately disabled. */
  featureEnabled: boolean
  /** Whether ANY text-AI key exists. A no-key streak on a machine with no
   *  keys at all is a setup state, not a breakage, and must not compete with
   *  the existing missing-key surface. */
  anyTextKeyConfigured: boolean
}

function substitutionTier(h: PurposeHealth, now: number): PurposeSeverity {
  if (h.substitutingSince === null) return 'ok'
  if (h.substituteSuccesses < 2) return 'ok'
  return now - ms(h.substitutingSince) >= MIN_SUBSTITUTION_SPAN_MS ? 'substituting' : 'ok'
}

export function severityOf(
  h: PurposeHealth,
  now: number,
  ctx: SeverityContext
): PurposeSeverity {
  if (!ctx.featureEnabled) return 'ok'
  if (h.consecutiveFailures === 0) return substitutionTier(h, now)
  if (h.lastFailureReason === 'no-key' && !ctx.anyTextKeyConfigured) return 'not-configured'
  if (now - ms(h.lastFailureAt) > EVIDENCE_MAX_MS) return 'ok'

  const span = ms(h.lastFailureAt) - ms(h.firstFailureAt)
  const countTrip = h.failureEpisodes >= FAILURE_EPISODE_LIMIT && span >= MIN_STREAK_SPAN_MS
  const staleTrip =
    h.failureEpisodes >= 2 && now - ms(h.lastSuccessAt ?? h.firstFailureAt) >= STALE_MS
  return countTrip || staleTrip ? 'failing' : 'ok'
}

/** What to actually tell the user, per cause. An indicator that says
 *  "something's wrong" with no next step is the weak version of this feature. */
export function messageFor(
  h: PurposeHealth,
  providerName: string
): { text: string; action: 'ai-setup' | 'model-assignment' | null } {
  switch (h.lastFailureReason) {
    case 'auth':
      return {
        text: `Your ${providerName} key was rejected — it may have been revoked or mistyped.`,
        action: 'ai-setup'
      }
    case 'rate-limit':
      return {
        text: `${providerName} is rate-limiting your key. Adding a second provider's key lets this fall back instead of failing.`,
        action: 'ai-setup'
      }
    case 'model-not-found':
      return {
        text: `${providerName} no longer offers the model assigned to this job.`,
        action: 'model-assignment'
      }
    case 'network':
    case 'timeout':
      return { text: `Couldn't reach ${providerName} — check your connection.`, action: null }
    case 'no-key':
      return { text: 'No AI provider is set up for this yet.', action: 'ai-setup' }
    default:
      return {
        text: h.lastFailureDetail
          ? `${providerName} failed: ${h.lastFailureDetail}`
          : `${providerName} is failing on every attempt.`,
        action: 'model-assignment'
      }
  }
}
