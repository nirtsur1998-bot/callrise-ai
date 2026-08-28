// M29 A1.1 — the telemetry front door. The ONLY thing the rest of the app
// imports: `record(kind, name, props)`.
//
// OFF MEANS OFF, FROM THE FIRST COMMIT. Until `configureTelemetry` is called
// with an `isEnabled` that returns true, `record()` writes nothing — not to
// the queue, not to memory. 'unasked' is indistinguishable from 'off'. The
// consent wiring (A1.3) is the only thing that can flip it, and the red-check
// suite proves zero bytes are written while it is off.
//
// No Electron import here either: the userData directory is injected, so the
// whole module runs under plain vitest and in any process.

import { randomUUID } from 'node:crypto'
import { buildEvent, type PropValue, type TelemetryEvent, type TelemetryKind } from './events'
import { TelemetryQueue } from './queue'

export type { PropValue, TelemetryEvent, TelemetryKind } from './events'

export interface TelemetryConfig {
  userDataDir: string
  /** Consent gate. Read fresh on EVERY record — never cached — so opt-out is immediate. */
  isEnabled: () => boolean
}

export type RecordResult = { ok: true; event: TelemetryEvent } | { ok: false; reason: string }

/** Random per-launch id for "crash-free sessions". Not persisted, not derived from anything. */
export const SESSION_ID = randomUUID()

let config: TelemetryConfig | null = null
let queue: TelemetryQueue | null = null

export function configureTelemetry(next: TelemetryConfig): void {
  config = next
  queue = new TelemetryQueue(next.userDataDir)
}

/** Test/shutdown hook: forget the configuration (back to disabled). */
export function resetTelemetry(): void {
  config = null
  queue = null
}

export function isTelemetryEnabled(): boolean {
  try {
    return config !== null && config.isEnabled() === true
  } catch {
    return false
  }
}

/**
 * Record one event. Never throws; never blocks; never writes when disabled.
 * `props` values must be string | number | boolean — anything else is
 * rejected with a reason (see events.ts: the shape is the privacy policy).
 */
export function record(
  kind: TelemetryKind,
  name: string,
  props: Record<string, PropValue> = {}
): RecordResult {
  if (!isTelemetryEnabled() || !queue) return { ok: false, reason: 'disabled' }
  const built = buildEvent(kind, name, props)
  if (!built.ok) return built
  return queue.append(built.event)
    ? { ok: true, event: built.event }
    : { ok: false, reason: 'queue write failed' }
}

/** Everything waiting to be sent, oldest first — what the Settings screen shows. */
export function listQueued(): TelemetryEvent[] {
  return queue ? queue.list() : []
}

/** The user's "delete my telemetry queue" — also called on opt-out. */
export function clearQueued(): void {
  queue?.clear()
}

/** For the transport (A1.4): remove events that were successfully sent. */
export function ackSent(ids: ReadonlySet<string>): void {
  queue?.ack(ids)
}
