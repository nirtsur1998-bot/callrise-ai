// M29 A1.4 — draining the queue: batch → send → ack → sent log, with backoff.
//
// Runs only when consent is on AND an anonymous id exists (both are the
// consent path's doing; neither is created here). A failed send leaves every
// event queued and backs off — 1 min, 5 min, 30 min, then 6 h — so an
// offline laptop never hammers the network and never loses a report.
//
// No Electron import; the ingest config is a getter because the env values
// it reads are back-filled after setup runs (index.ts loads .env later).

import { arch as osArch, platform as osPlatform, release as osRelease } from 'node:os'
import { readAnonId } from './anon-id'
import { readConsent } from './consent'
import type { TelemetryEnvelope } from './events'
import { ackSent, listQueued, SESSION_ID } from './index'
import { appendSent } from './sent-log'
import { getTelemetrySetup } from './setup'
import { type IngestConfig, MAX_BATCH, type SendDeps, sendBatch } from './transport'

export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 6 * 60 * 60_000] as const
export const FIRST_FLUSH_DELAY_MS = 30_000
export const FLUSH_INTERVAL_MS = 6 * 60 * 60_000

/**
 * The ONLY statuses that mean "this payload is the problem, a retry changes
 * nothing" — so the batch is dropped rather than blocking everything behind it.
 *
 * Deliberately an allowlist of four, NOT the 4xx range. See the long comment at
 * the drop site for why the range was wrong; the short version is that 404 is
 * the day-one cutover condition (the table does not exist yet) and 429 means
 * "retry later" by definition. Everything not in this set retries, including
 * statuses we do not recognise — a wrong retry costs a queue slot, a wrong drop
 * is unrecoverable.
 */
export const DROP_STATUSES: ReadonlySet<number> = new Set([
  400, // malformed / rejected by the validating trigger
  409, // conflict the server will keep rejecting
  413, // payload too large — the same bytes will always be too large
  422 // unprocessable entity
])

let ingestGetter: (() => IngestConfig) | null = null
let failures = 0
let nextAllowedAt = 0
let inFlight: Promise<FlushResult> | null = null

export function setIngestConfig(getter: () => IngestConfig): void {
  ingestGetter = getter
}

export interface FlushResult {
  attempted: boolean
  sent: number
  remaining: number
  reason?: string
}

export function buildEnvelope(anonId: string, appVersion: string): TelemetryEnvelope {
  return {
    anonId,
    sessionId: SESSION_ID,
    appVersion,
    platform: osPlatform(),
    osVersion: osRelease(),
    arch: osArch(),
    events: listQueued().slice(0, MAX_BATCH)
  }
}

export interface FlushDeps extends SendDeps {
  now?: () => number
}

/**
 * One flush attempt. Never throws. Returns what happened so Settings and
 * tests can show/assert it. Concurrent calls share the in-flight attempt.
 */
export function flushTelemetry(deps: FlushDeps = {}): Promise<FlushResult> {
  if (inFlight) return inFlight
  inFlight = flushOnce(deps).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function flushOnce(deps: FlushDeps): Promise<FlushResult> {
  const now = deps.now ?? Date.now
  const setup = getTelemetrySetup()
  if (!setup) return { attempted: false, sent: 0, remaining: 0, reason: 'not set up' }
  // Consent is read fresh here too — a user who turned it off between the
  // schedule firing and now gets nothing sent.
  if (readConsent(setup.userDataDir).consent !== 'on') {
    return { attempted: false, sent: 0, remaining: 0, reason: 'consent off' }
  }
  const anonId = readAnonId(setup.userDataDir)
  if (!anonId) return { attempted: false, sent: 0, remaining: listQueued().length, reason: 'no id' }
  if (now() < nextAllowedAt) {
    return { attempted: false, sent: 0, remaining: listQueued().length, reason: 'backing off' }
  }
  const cfg = ingestGetter?.()
  if (!cfg || !cfg.url || !cfg.anonKey) {
    return {
      attempted: false,
      sent: 0,
      remaining: listQueued().length,
      reason: 'ingest not configured'
    }
  }
  const envelope = buildEnvelope(anonId, setup.appVersion)
  if (envelope.events.length === 0)
    return { attempted: false, sent: 0, remaining: 0, reason: 'nothing queued' }

  const result = await sendBatch(cfg, envelope, deps)
  // THE IN-FLIGHT WINDOW (M29 sweep item 8). Consent was read before the
  // await and a send can take up to SEND_TIMEOUT_MS. If the user revoked
  // during that window the bytes are already gone — nothing can undo that —
  // but we must NOT then write the sent log, because that would CREATE a
  // telemetry file AFTER revocation, on a device the user has just switched
  // off. (The sweep found exactly this: opt out mid-send, and
  // telemetry-sent.jsonl reappears carrying the anon id that opt-out deleted.)
  // Re-read and bail before any bookkeeping.
  if (readConsent(setup.userDataDir).consent !== 'on') {
    return {
      attempted: true,
      sent: 0,
      remaining: listQueued().length,
      reason: 'consent revoked mid-send'
    }
  }
  if (result.ok) {
    failures = 0
    nextAllowedAt = 0
    ackSent(new Set(envelope.events.map((e) => e.id)))
    appendSent(setup.userDataDir, {
      sentAt: new Date(now()).toISOString(),
      status: result.status,
      count: result.sent,
      body: result.body
    })
    return { attempted: true, sent: result.sent, remaining: listQueued().length }
  }
  // BUG-090 (found by the species-24 activation audit, before this code ever
  // met a real server): a batch the server will NEVER accept must be dropped —
  // retrying it is not persistence, it is a head-of-line block on all
  // telemetry behind it. Losing a telemetry batch beats a wedged pipeline;
  // telemetry is lossy by design (queue caps) and must never become precious.
  //
  // BUT "any 4xx" is NOT that set, and the first version of this fix assumed
  // it was. The M29 sweep found the hole: the day-one cutover condition is a
  // 404 — `telemetry_events` does not exist until the SQL is applied, and
  // PostgREST also 404s transiently while reloading its schema cache after any
  // DDL. Dropping on 404 would silently delete every event from the exact week
  // the cutover most needs data; 429 would make telemetry degrade WORST under
  // adoption. So the classification is by MEANING, not by range:
  //
  //   RETRY (deployment state or transient — these CAN succeed later):
  //     404 table not deployed yet · 408 proxy timeout · 425 too early
  //     429 throttled · 401/403 key not deployed / rotated · 5xx · network
  //   DROP (this PAYLOAD is the problem — see DROP_STATUSES):
  //     400 · 409 · 413 · 422
  if (result.status !== null && DROP_STATUSES.has(result.status)) {
    ackSent(new Set(envelope.events.map((e) => e.id)))
    console.warn(
      `[telemetry] server rejected a batch (HTTP ${result.status}); dropped ${envelope.events.length} events to keep the queue moving`
    )
    return {
      attempted: true,
      sent: 0,
      remaining: listQueued().length,
      reason: `dropped: HTTP ${result.status}`
    }
  }
  const step = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]
  failures += 1
  nextAllowedAt = now() + step
  return { attempted: true, sent: 0, remaining: listQueued().length, reason: result.reason }
}

/** Test hook: forget backoff state. */
export function resetFlushState(): void {
  failures = 0
  nextAllowedAt = 0
  inFlight = null
}

let firstTimer: ReturnType<typeof setTimeout> | null = null
let interval: ReturnType<typeof setInterval> | null = null

/** 30 s after launch, then every 6 h. Each tick is a no-op unless consent is on. */
export function startTelemetrySchedule(): void {
  stopTelemetrySchedule()
  firstTimer = setTimeout(() => {
    firstTimer = null
    void flushTelemetry()
  }, FIRST_FLUSH_DELAY_MS)
  interval = setInterval(() => void flushTelemetry(), FLUSH_INTERVAL_MS)
  // Never keep the process alive just to send telemetry.
  firstTimer.unref?.()
  interval.unref?.()
}

export function stopTelemetrySchedule(): void {
  if (firstTimer) clearTimeout(firstTimer)
  if (interval) clearInterval(interval)
  firstTimer = null
  interval = null
}
