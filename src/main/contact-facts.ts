// M39 §8 — bi-temporal contact facts. PURE: no fs, no Electron, no clock read
// unless a caller declines to pass one, so every rule here is unit-provable
// and the store (contacts-fs.ts) is the only thing that decides WHEN.
//
// Design: docs/M39-bitemporal-contacts-design.md — decided by the founder on
// 2026-09-11 (scope: the 13 fields a buyer tells you that change; clearing
// REDACTS history; no backfill; history syncs under the contacts toggle).
//
// The flat contact fields stay authoritative for "now". One field is added,
// `factHistory`, carrying EVENT time (validFrom/validUntil — when it was true
// in the world) beside SYSTEM time (recordedAt — when the app learned it),
// with the same meaning `memory.db` gives those words: a window closes at the
// SUPERSEDER's validFrom, never at the moment of writing, and an `approx`
// date reads "around". One meaning of "valid from" in the app, not two.
import { randomUUID } from 'node:crypto'
import type { Contact } from './contacts-fs'
import type { ValidityDateSource } from './memory/types'

export type TemporalClass =
  /** Something a buyer tells you that can be true in July and false in September. */
  | 'DATED'
  /** Changes for administrative reasons, not as a fact about the deal. Current value only. */
  | 'UNDATED'
  /** About the record, not the buyer. */
  | 'RECORD'

/**
 * EXHAUSTIVE over `Required<Contact>`, the way `CONTACT_FIELD_RULES` already is
 * for egress: adding a contact field without deciding whether it is dated is a
 * COMPILE ERROR, not a stale fact in a prompt six months later.
 *
 * The founder's rule, 2026-09-11: "the ones a buyer tells you and that change —
 * company, role, and any free-text notes field that holds claims. Not name, not
 * email, not phone." Where a field was a judgement call under it (`industry`,
 * `companySize`, `communicationStyle`) it is left UNDATED.
 */
export const CONTACT_TEMPORAL_RULES = {
  id: 'RECORD',
  name: 'UNDATED',
  company: 'DATED',
  cid: 'UNDATED',
  registeredAt: 'UNDATED',
  country: 'UNDATED',
  email: 'UNDATED',
  phoneCountry: 'UNDATED',
  phone: 'UNDATED',
  phoneE164: 'UNDATED',
  notes: 'DATED',
  industry: 'UNDATED',
  companySize: 'UNDATED',
  website: 'UNDATED',
  registrationNumber: 'UNDATED',
  verificationStatus: 'UNDATED',
  title: 'DATED',
  decisionAuthority: 'DATED',
  otherStakeholders: 'DATED',
  dealValue: 'DATED',
  pipelineStage: 'UNDATED',
  leadSource: 'UNDATED',
  budgetIndication: 'DATED',
  timeline: 'DATED',
  competitors: 'DATED',
  knownObjections: 'DATED',
  currentTooling: 'DATED',
  lastContactDate: 'UNDATED',
  preferredLanguage: 'UNDATED',
  communicationStyle: 'UNDATED',
  timezone: 'UNDATED',
  personalNotes: 'DATED',
  briefingNotes: 'DATED',
  createdAt: 'RECORD',
  updatedAt: 'RECORD',
  deleted: 'RECORD',
  comments: 'RECORD',
  factHistory: 'RECORD'
} as const satisfies { [K in keyof Required<Contact>]: TemporalClass }

/** The 13 — DERIVED from the table, so the type and the runtime list cannot disagree. */
export type DatedContactField = {
  [K in keyof typeof CONTACT_TEMPORAL_RULES]: (typeof CONTACT_TEMPORAL_RULES)[K] extends 'DATED'
    ? K
    : never
}[keyof typeof CONTACT_TEMPORAL_RULES]

export const DATED_CONTACT_FIELDS: readonly DatedContactField[] = (
  Object.keys(CONTACT_TEMPORAL_RULES) as (keyof typeof CONTACT_TEMPORAL_RULES)[]
).filter((k) => CONTACT_TEMPORAL_RULES[k] === 'DATED') as DatedContactField[]

export function isDatedField(field: string): field is DatedContactField {
  return (DATED_CONTACT_FIELDS as readonly string[]).includes(field)
}

export type FactSource =
  /** The rep typed it on the Contact page (or an assistant did on their behalf). */
  | 'user'
  /** The rep accepted an AI suggestion that came from a call. */
  | 'ai-accepted'
  /** Synthesised on import to explain a flat value an OLDER build wrote without a fact. */
  | 'import'

export interface ContactFact {
  /** uuid — the merge key across devices */
  id: string
  field: DatedContactField
  /** null = the rep cleared the field (and every earlier value is redacted). */
  value: string | number | null
  // EVENT time — when it was true in the world
  validFrom: string
  validFromSource: ValidityDateSource
  /** The superseder's validFrom; absent = still true. DERIVED, never trusted from disk. */
  validUntil?: string
  // SYSTEM time — when the app knew
  recordedAt: string
  /** id of the fact that closed this one. DERIVED, never trusted from disk. */
  supersededBy?: string
  source: FactSource
  /** The call an accepted fact came from. */
  callId?: string
  /** Decision 2: the words are gone, the dates and the source stay. */
  redacted?: true
}

export type FactValue = string | number | null

/** Where a fact came from, when the writer knows: the call and its moment. */
export interface FactEvidence {
  callId: string
  /** The call's createdAt — a budget heard in July is dated to July even if the chip is clicked in September. */
  at: string
}

/** Unbounded history on a field edited weekly grows forever. The oldest CLOSED
 *  fact goes first; an open fact is never dropped. */
export const MAX_FACTS_PER_FIELD = 20

const ID_RE = /^[A-Za-z0-9-]{1,64}$/
const isSafeId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v)
const isIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v))
const SOURCES: readonly FactSource[] = ['user', 'ai-accepted', 'import']
const DATE_SOURCES: readonly ValidityDateSource[] = ['call', 'stated', 'approx']

/** Order within a field: by validFrom, then by recordedAt (the later-learned of
 *  two facts dated to the same instant is the later fact), then id — a total
 *  order, so two devices derive the SAME windows from the same set. */
function byWindow(a: ContactFact, b: ContactFact): number {
  return (
    a.validFrom.localeCompare(b.validFrom) ||
    a.recordedAt.localeCompare(b.recordedAt) ||
    a.id.localeCompare(b.id)
  )
}

/**
 * Re-derive every window from the set of facts alone. `validUntil` and
 * `supersededBy` are functions of the set, never stored truth: each fact is
 * closed by the next fact of the same field in `byWindow` order, and the last
 * one is open. Follows `invalidateMemory` to the letter — the old fact's
 * validUntil is the NEW fact's validFrom, not the moment of writing.
 *
 * Output is sorted (field, then window order) and capped, so the same set
 * serialises to the same bytes on every device.
 */
export function rederiveWindows(history: readonly ContactFact[]): ContactFact[] {
  const out: ContactFact[] = []
  for (const field of DATED_CONTACT_FIELDS) {
    const mine = history.filter((f) => f.field === field).sort(byWindow)
    const kept = capField(mine)
    kept.forEach((f, i) => {
      const next = kept[i + 1]
      const { validUntil: _u, supersededBy: _s, ...rest } = f
      void _u
      void _s
      out.push(next ? { ...rest, validUntil: next.validFrom, supersededBy: next.id } : { ...rest })
    })
  }
  return out
}

/** Cap one field's (window-ordered) facts: drop the oldest first, never the last (open) one. */
function capField(sorted: ContactFact[]): ContactFact[] {
  if (sorted.length <= MAX_FACTS_PER_FIELD) return sorted
  return sorted.slice(sorted.length - MAX_FACTS_PER_FIELD)
}

/** The open fact for a field — the one whose window has no end — or null. */
export function currentFact(
  history: readonly ContactFact[] | undefined,
  field: DatedContactField
): ContactFact | null {
  if (!history?.length) return null
  const mine = history.filter((f) => f.field === field)
  if (!mine.length) return null
  return mine.sort(byWindow)[mine.length - 1] ?? null
}

export interface RecordFactInput {
  field: DatedContactField
  /** null = cleared. */
  value: FactValue
  validFrom: string
  validFromSource: ValidityDateSource
  source: FactSource
  callId?: string
  /** SYSTEM time. Defaults to now — the one clock read in this module, and only when a caller declines to pass one. */
  recordedAt?: string
}

/**
 * Append one fact and return the new history.
 *
 * - The previous open fact for the field is closed at the NEW fact's validFrom
 *   (via rederiveWindows), so a July fact superseded by a September call closes
 *   in September.
 * - A fact dated EARLIER than the current open one enters history already
 *   superseded — it must not overwrite what the rep just typed. The current
 *   flat value is the open fact with the latest validFrom, not the latest write.
 * - Clearing (value null) REDACTS every fact of that field, the new one
 *   included: dates and sources stay, the words go — "if I delete something I
 *   mean it gone, not archived". Redaction survives sync (see merge).
 */
export function recordFact(
  history: readonly ContactFact[] | undefined,
  input: RecordFactInput
): ContactFact[] {
  const recordedAt = input.recordedAt ?? new Date().toISOString()
  const fact: ContactFact = {
    id: randomUUID(),
    field: input.field,
    value: input.value,
    validFrom: input.validFrom,
    validFromSource: input.validFromSource,
    recordedAt,
    source: input.source,
    ...(input.callId ? { callId: input.callId } : {}),
    ...(input.value === null ? { redacted: true as const } : {})
  }
  let next = [...(history ?? []), fact]
  if (input.value === null) {
    next = next.map((f) => (f.field === input.field ? redact(f) : f))
  }
  return rederiveWindows(next)
}

function redact(f: ContactFact): ContactFact {
  return { ...f, value: null, redacted: true }
}

/** The dated fields of a contact, as far as this module needs them. */
export type DatedValues = Partial<Record<DatedContactField, string | number | undefined>>

/** Set every dated field that HAS an open fact from that fact; leave fields
 *  without history alone (a pre-release value stays whatever it is — the 29
 *  undated values on the founder's profile are never blanked by this). */
export function applyHistoryToFlat<T extends DatedValues>(
  contact: T,
  history: readonly ContactFact[] | undefined
): T {
  if (!history?.length) return contact
  const out: DatedValues = { ...contact }
  for (const field of DATED_CONTACT_FIELDS) {
    const open = currentFact(history, field)
    if (!open) continue
    if (open.value === null) delete out[field]
    else out[field] = open.value
  }
  return out as T
}

export interface FactAsOf {
  value: string | number
  /** null = undated (a pre-release value, or nothing in history covers the moment) */
  validFrom: string | null
  validFromSource: ValidityDateSource | null
  source: FactSource | null
}

/**
 * What was true AS OF a moment, per dated field: the fact whose
 * [validFrom, validUntil) contains `asOf` (ties by latest recordedAt); failing
 * that, the flat value as undated; failing that, null. A REDACTED fact covering
 * the moment yields null — the words are gone, so nothing is known.
 */
export function factsAsOf(
  contact: DatedValues & { factHistory?: readonly ContactFact[] },
  asOf: string
): Record<DatedContactField, FactAsOf | null> {
  const out = {} as Record<DatedContactField, FactAsOf | null>
  for (const field of DATED_CONTACT_FIELDS) {
    const covering = (contact.factHistory ?? [])
      .filter(
        (f) =>
          f.field === field &&
          f.validFrom <= asOf &&
          (f.validUntil === undefined || asOf < f.validUntil)
      )
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0]
    if (covering) {
      out[field] =
        covering.value === null
          ? null
          : {
              value: covering.value,
              validFrom: covering.validFrom,
              validFromSource: covering.validFromSource,
              source: covering.source
            }
      continue
    }
    const flat = contact[field]
    out[field] =
      flat === undefined || flat === '' || flat === null
        ? null
        : { value: flat, validFrom: null, validFromSource: null, source: null }
  }
  return out
}

/** The one-clause suffix the dossier prints. Absolute ISO days only — never
 *  "3 weeks ago" — so the cached prompt prefix stays byte-identical. An
 *  `approx` date reads "noted", a stated one "since", a call "since …, from a call". */
export function describeFactDate(f: FactAsOf): string {
  if (!f.validFrom) return ''
  const day = f.validFrom.slice(0, 10)
  if (f.validFromSource === 'call') return ` (since ${day}, from a call)`
  if (f.validFromSource === 'approx') return ` (noted ${day})`
  return ` (since ${day})`
}

export interface MergeResult {
  merged: ContactFact[]
  /** Local held fact ids the incoming row lacked — the cloud copy is missing
   *  history and the next push must beat the server's newest-wins trigger. */
  restoredFromLocal: boolean
}

/**
 * Two-device union BY FACT ID — never drop a fact present on either side.
 * For a shared id, REDACTION WINS in either direction (decision 2 would fail
 * silently otherwise: A clears a field, B still holds the words under the same
 * ids, and B's union must not resurrect them). Windows and the cap are
 * re-derived from the union.
 */
export function mergeFactHistories(
  local: readonly ContactFact[] | undefined,
  incoming: readonly ContactFact[] | undefined
): MergeResult {
  const byId = new Map<string, ContactFact>()
  for (const f of incoming ?? []) byId.set(f.id, f)
  let restoredFromLocal = false
  for (const f of local ?? []) {
    const other = byId.get(f.id)
    if (!other) {
      byId.set(f.id, f)
      restoredFromLocal = true
    } else if (f.redacted && !other.redacted) {
      byId.set(f.id, redact(other))
    }
  }
  // A field cleared on one side redacts that field's facts from the other
  // side too, even ones the clearing device never saw: the rep meant it gone.
  const redactedFields = new Set<DatedContactField>()
  for (const f of byId.values()) if (f.redacted) redactedFields.add(f.field)
  const union = [...byId.values()].map((f) =>
    redactedFields.has(f.field) && !f.redacted && isClearedAfter(f, byId) ? redact(f) : f
  )
  return { merged: rederiveWindows(union), restoredFromLocal }
}

/** A fact is covered by a clearing when some redacted fact of the same field
 *  is dated at or after it — a value entered AFTER the clearing is a new claim
 *  and keeps its words. */
function isClearedAfter(f: ContactFact, all: Map<string, ContactFact>): boolean {
  for (const g of all.values()) {
    if (g.field === f.field && g.redacted && g.value === null && byWindow(g, f) >= 0) return true
  }
  return false
}

/**
 * Coerce an untrusted `factHistory` (off disk, off the cloud) element by
 * element, like `sanitizeComments`: a malformed entry is dropped, never let
 * through. `sanitizeValue` is the STORE's own per-field sanitizer (max length,
 * numeric dealValue), so a tampered payload cannot plant a fact on `email` or
 * a 50 kB value on `title`. Windows are re-derived, never trusted.
 */
export function sanitizeFactHistory(
  value: unknown,
  sanitizeValue: (field: DatedContactField, raw: unknown) => string | number | undefined
): ContactFact[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: ContactFact[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const f = raw as Record<string, unknown>
    if (!isSafeId(f.id)) continue
    if (typeof f.field !== 'string' || !isDatedField(f.field)) continue
    if (!isIso(f.validFrom)) continue
    const validFrom = new Date(Date.parse(f.validFrom)).toISOString()
    const recordedAt = isIso(f.recordedAt)
      ? new Date(Date.parse(f.recordedAt)).toISOString()
      : validFrom
    const cleared = f.value === null || f.redacted === true
    const clean = cleared ? undefined : sanitizeValue(f.field, f.value)
    if (!cleared && clean === undefined) continue // a fact with no value is not a fact
    out.push({
      id: f.id,
      field: f.field,
      value: cleared ? null : (clean as string | number),
      validFrom,
      validFromSource: (DATE_SOURCES as readonly string[]).includes(String(f.validFromSource))
        ? (f.validFromSource as ValidityDateSource)
        : 'approx',
      recordedAt,
      source: (SOURCES as readonly string[]).includes(String(f.source))
        ? (f.source as FactSource)
        : 'import',
      ...(isSafeId(f.callId) ? { callId: f.callId } : {}),
      ...(cleared ? { redacted: true as const } : {})
    })
  }
  if (!out.length) return undefined
  return rederiveWindows(out)
}
