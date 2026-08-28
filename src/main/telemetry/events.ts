// M29 A1.1 — the telemetry event model. Pure: no Electron, no fs.
//
// THE SHAPE IS THE PRIVACY POLICY. An event's `props` can hold only strings,
// numbers and booleans — never an object, never an array, never free text
// longer than a short label (the one exception, `stack`, is capped and
// scrubbed). There is no field in which a transcript, a memory, a contact, a
// deal, a key or a file's contents could travel even if a future caller
// tried. Anything that doesn't fit is REJECTED here with a reason, never
// coerced, never thrown — a telemetry call must never break the feature it
// is describing.
//
// Every string value passes through the scrubber (docs/M29-audit.md §1.4:
// the Windows username leaks through every path) before it is accepted.

import { randomUUID } from 'node:crypto'
import { scrub as defaultScrub, type Scrubber } from './scrub'

export type TelemetryKind = 'crash' | 'error' | 'health' | 'usage'

export const TELEMETRY_KINDS: ReadonlyArray<TelemetryKind> = ['crash', 'error', 'health', 'usage']

export type PropValue = string | number | boolean

export interface TelemetryEvent {
  /** Event id — generated here, never user-derived. */
  id: string
  /** Client clock, ISO. The server stamps its own `received_at`. */
  ts: string
  kind: TelemetryKind
  /** Dotted, lower-case, e.g. `main.uncaughtException`, `ai.purpose.failed`, `feature.rise.opened`. */
  name: string
  props: Record<string, PropValue>
}

/** What actually leaves the machine: one envelope per batch. */
export interface TelemetryEnvelope {
  /** Random per-install UUID from `telemetry-id`. NEVER the account id, NEVER `.updaterId`. */
  anonId: string
  /** Random per-launch UUID — lets "crash-free sessions" be computed without any identity. */
  sessionId: string
  appVersion: string
  platform: string
  osVersion: string
  arch: string
  events: TelemetryEvent[]
}

export const LIMITS = {
  /** `name` must match this: dotted identifiers, e.g. `main.uncaughtException`. No spaces, no prose. */
  NAME: /^[a-z][a-zA-Z0-9]*(?:[.-][a-zA-Z0-9]+){0,7}$/,
  NAME_MAX: 64,
  /** Prop keys: identifier-shaped, short. */
  KEY: /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/,
  MAX_PROPS: 24,
  /**
   * Ordinary string props are TOKENS — enums, class names, codes, scopes,
   * versions — never prose. No whitespace is allowed, by construction: a
   * transcript, a note, a name, a message all contain spaces and are
   * therefore unrepresentable here. (Found by the privacy red-check suite:
   * the scrubber removes identifiers, it cannot recognise prose, so the
   * shape has to make prose impossible.)
   */
  TOKEN: /^[A-Za-z0-9_.:/@+-]{1,128}$/,
  /**
   * The one free-text field, for crash/error events. Reduced to its
   * `    at …` frame lines HERE — never the first line, which is the message
   * — then scrubbed and capped. A caller passing a whole stack, a message,
   * or prose under this key gets the frames or nothing.
   */
  STACK_MAX: 4096,
  STACK_KEYS: new Set(['stack']),
  MAX_FRAMES: 30
} as const

/** Only the `    at …` lines of a stack — never the first line, which is the message. */
export function stackFrames(stack: unknown): string {
  if (typeof stack !== 'string') return ''
  return stack
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => /^\s+at\s/.test(l))
    .slice(0, LIMITS.MAX_FRAMES)
    .join('\n')
}

export function isTelemetryKind(value: string): value is TelemetryKind {
  return (TELEMETRY_KINDS as ReadonlyArray<string>).includes(value)
}

export type BuildResult = { ok: true; event: TelemetryEvent } | { ok: false; reason: string }

export interface BuildDeps {
  scrub?: Scrubber
  now?: () => Date
  id?: () => string
}

/**
 * Validate + scrub + assemble. Returns a reason instead of throwing so a
 * caller can log "dropped: <reason>" and carry on.
 */
export function buildEvent(
  kind: unknown,
  name: unknown,
  props: unknown,
  deps: BuildDeps = {}
): BuildResult {
  const scrub = deps.scrub ?? defaultScrub
  if (typeof kind !== 'string' || !isTelemetryKind(kind)) {
    return { ok: false, reason: `unknown kind: ${String(kind)}` }
  }
  if (typeof name !== 'string' || name.length > LIMITS.NAME_MAX || !LIMITS.NAME.test(name)) {
    return { ok: false, reason: `bad name: ${String(name).slice(0, 80)}` }
  }
  if (props === undefined || props === null) props = {}
  if (typeof props !== 'object' || Array.isArray(props)) {
    return { ok: false, reason: 'props must be a plain object' }
  }
  const entries = Object.entries(props as Record<string, unknown>)
  if (entries.length > LIMITS.MAX_PROPS) {
    return { ok: false, reason: `too many props (${entries.length} > ${LIMITS.MAX_PROPS})` }
  }
  const clean: Record<string, PropValue> = {}
  for (const [key, value] of entries) {
    if (!LIMITS.KEY.test(key)) return { ok: false, reason: `bad prop key: ${key.slice(0, 40)}` }
    if (typeof value === 'boolean') {
      clean[key] = value
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) return { ok: false, reason: `non-finite number in ${key}` }
      clean[key] = value
    } else if (typeof value === 'string') {
      if (LIMITS.STACK_KEYS.has(key)) {
        const frames = scrub(stackFrames(value))
        if (frames.length === 0) continue // a message with no frames contributes nothing
        clean[key] =
          frames.length > LIMITS.STACK_MAX ? `${frames.slice(0, LIMITS.STACK_MAX)}…` : frames
      } else {
        const scrubbed = scrub(value)
        if (!LIMITS.TOKEN.test(scrubbed)) {
          return { ok: false, reason: `prop ${key} is not a token (no whitespace, max 128 chars)` }
        }
        clean[key] = scrubbed
      }
    } else {
      // objects, arrays, null, undefined, bigint, symbol, functions: there is
      // deliberately no way to put structure in an event.
      return {
        ok: false,
        reason: `prop ${key} has unsupported type ${value === null ? 'null' : typeof value}`
      }
    }
  }
  return {
    ok: true,
    event: {
      id: (deps.id ?? randomUUID)(),
      ts: (deps.now ?? (() => new Date()))().toISOString(),
      kind,
      name,
      props: clean
    }
  }
}

/** Runtime check for something read back from disk — the queue file is user-writable. */
export function isTelemetryEvent(value: unknown): value is TelemetryEvent {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || typeof v.ts !== 'string') return false
  if (typeof v.kind !== 'string' || !isTelemetryKind(v.kind)) return false
  if (typeof v.name !== 'string' || !LIMITS.NAME.test(v.name)) return false
  if (!v.props || typeof v.props !== 'object' || Array.isArray(v.props)) return false
  for (const [k, p] of Object.entries(v.props as Record<string, unknown>)) {
    if (!LIMITS.KEY.test(k)) return false
    if (typeof p === 'string') {
      if (LIMITS.STACK_KEYS.has(k)) {
        if (p.length > LIMITS.STACK_MAX + 1) return false
      } else if (!LIMITS.TOKEN.test(p)) return false
    } else if (typeof p !== 'number' && typeof p !== 'boolean') return false
  }
  return true
}
