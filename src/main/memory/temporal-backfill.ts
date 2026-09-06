// M36 Stage 3 item 5, step 1 — THE BACKFILL. The founder called this the
// risky step and set the terms (2026-09-06):
//
//   "Tell me what you're using as the source — the learning time, or the
//    evidence call's date? ... If existing rows can't recover the event time,
//    say so and backfill with the learning time explicitly marked as
//    approximate rather than silently. A dated fact whose date is wrong is
//    worse than an undated one. Measure the counts before and after."
//
// THE SOURCE, in order, per row:
//   1. 'call'   — the EARLIEST start time among the row's transcript-evidence
//                 calls that still exist in the calls store (a call record's
//                 createdAt IS its start: saveCall builds it from the
//                 renderer's startedAt). This is event time.
//   2. 'stated' — no call resolved, but the user stated or confirmed the fact
//                 themselves (onboarding, a chat "remember this"); the moment
//                 they said it is exact by definition, so created_at is used
//                 and is NOT approximate.
//   3. 'approx' — nothing recovered (imported contact fields, a call since
//                 deleted, chat evidence). created_at — the LEARNING time —
//                 stands in and is marked so.
//
// valid_until, for rows already invalidated: the superseding memory's
// valid_from and ITS source (a fact stopped being true when the newer fact
// became true, not when we noticed). Superseder gone: invalidated_at, marked
// 'approx'. Never guessed further.
//
// Runs ONCE: its record — the counts — lives in memory_meta under
// TEMPORAL_BACKFILL_META_KEY, and a second call returns that record without
// touching a row. Never in the migration itself (the calls store is outside
// memory.db); called from memory-runtime after a successful migrate.
import type Database from 'better-sqlite3'
import { listCalls } from '../calls-fs'
import { getMeta, setMeta, setValidity } from './memories-store'
import type { MemoryEvidence, ValidityDateSource } from './types'

export const TEMPORAL_BACKFILL_META_KEY = 'temporal_backfill'

export interface TemporalBackfillCounts {
  ranAt: string
  /** rows in the store when the job ran */
  total: number
  /** rows that ALREADY had a valid_from before the job (inserted after
   *  migration 6 by the new insert rule) — the "before" count */
  datedBefore: number
  /** rows this job dated, by where the date came from */
  validFrom: Record<ValidityDateSource, number>
  /** invalidated rows this job closed, by where the close date came from;
   *  `none` = superseded but nothing to date the close with */
  validUntil: Record<ValidityDateSource | 'none', number>
  /** distinct evidence call ids seen / found in the calls store */
  callsReferenced: number
  callsResolved: number
}

interface BackfillRow {
  id: string
  evidence: string
  source: string
  status: string
  created_at: string
  invalidated_by: string | null
  invalidated_at: string | null
  valid_from: string | null
  valid_from_source: string | null
  valid_until: string | null
}

/** The calls store as id → start time, one directory read. Tombstones are
 *  included on purpose: a deleted call's memories were forgotten with it
 *  (forgetCallContribution), so any that remain reference a date we still
 *  hold, and that date is real. */
export async function loadCallStartTimes(callsDir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const calls = await listCalls(callsDir, { includeDeleted: true })
  for (const c of calls) {
    if (typeof c.createdAt === 'string' && !Number.isNaN(Date.parse(c.createdAt))) out.set(c.id, c.createdAt)
  }
  return out
}

export function temporalBackfillRecord(db: Database.Database): TemporalBackfillCounts | null {
  const raw = getMeta(db, TEMPORAL_BACKFILL_META_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as TemporalBackfillCounts
  } catch {
    return null
  }
}

function evidenceCallIds(evidenceJson: string): string[] {
  try {
    const list = JSON.parse(evidenceJson) as MemoryEvidence[]
    return list.flatMap((e) => (e.type === 'transcript' && e.callId ? [e.callId] : []))
  } catch {
    return []
  }
}

/**
 * Dates every undated row, then closes every invalidated row's window, in
 * one transaction; records the counts; returns them. Idempotent: a second
 * call returns the stored record and changes nothing.
 */
export function runTemporalBackfill(
  db: Database.Database,
  callStartTimes: ReadonlyMap<string, string>
): TemporalBackfillCounts {
  const existing = temporalBackfillRecord(db)
  if (existing) return existing

  const rows = db
    .prepare(
      'SELECT id, evidence, source, status, created_at, invalidated_by, invalidated_at, valid_from, valid_from_source, valid_until FROM memories'
    )
    .all() as BackfillRow[]

  const counts: TemporalBackfillCounts = {
    ranAt: new Date().toISOString(),
    total: rows.length,
    datedBefore: rows.filter((r) => r.valid_from !== null).length,
    validFrom: { call: 0, stated: 0, approx: 0 },
    validUntil: { call: 0, stated: 0, approx: 0, none: 0 },
    callsReferenced: 0,
    callsResolved: 0
  }
  const referenced = new Set<string>()
  const resolved = new Set<string>()

  // pass 1 — valid_from, in memory first so pass 2 can read a superseder's
  // freshly computed date without a second query
  const validFromById = new Map<string, { at: string; source: ValidityDateSource }>()
  for (const r of rows) {
    if (r.valid_from !== null) {
      validFromById.set(r.id, { at: r.valid_from, source: (r.valid_from_source as ValidityDateSource) ?? 'approx' })
      continue
    }
    const callIds = evidenceCallIds(r.evidence)
    const times: string[] = []
    for (const id of callIds) {
      referenced.add(id)
      const t = callStartTimes.get(id)
      if (t) {
        resolved.add(id)
        times.push(t)
      }
    }
    times.sort()
    let at: string
    let source: ValidityDateSource
    if (times.length > 0) {
      at = times[0]
      source = 'call'
    } else if (r.source === 'user_stated' || r.source === 'user_confirmed') {
      at = r.created_at
      source = 'stated'
    } else {
      at = r.created_at
      source = 'approx'
    }
    validFromById.set(r.id, { at, source })
    counts.validFrom[source]++
  }
  counts.callsReferenced = referenced.size
  counts.callsResolved = resolved.size

  // pass 2 — valid_until for rows already superseded
  const validUntilById = new Map<string, { at: string; source: ValidityDateSource }>()
  for (const r of rows) {
    if (r.valid_until !== null) continue
    const superseded = r.status === 'invalidated' || r.invalidated_by !== null
    if (!superseded) continue
    const superseder = r.invalidated_by ? validFromById.get(r.invalidated_by) : undefined
    if (superseder) {
      validUntilById.set(r.id, superseder)
      counts.validUntil[superseder.source]++
    } else if (r.invalidated_at) {
      validUntilById.set(r.id, { at: r.invalidated_at, source: 'approx' })
      counts.validUntil.approx++
    } else {
      counts.validUntil.none++
    }
  }

  const write = db.transaction(() => {
    for (const r of rows) {
      const from = r.valid_from === null ? validFromById.get(r.id) : undefined
      const until = validUntilById.get(r.id)
      if (!from && !until) continue
      setValidity(db, r.id, {
        ...(from ? { validFrom: from.at, validFromSource: from.source } : {}),
        ...(until ? { validUntil: until.at, validUntilSource: until.source } : {})
      })
    }
    setMeta(db, TEMPORAL_BACKFILL_META_KEY, JSON.stringify(counts))
  })
  write()
  return counts
}

/** One line for the main log — the founder asked for the counts, not a
 *  cheerful "done". */
export function describeTemporalBackfill(c: TemporalBackfillCounts): string {
  return (
    `temporal backfill: ${c.total} memories, ${c.datedBefore} already dated; ` +
    `valid_from — ${c.validFrom.call} from evidence calls (real), ${c.validFrom.stated} user-stated (exact), ` +
    `${c.validFrom.approx} from learning time (APPROXIMATE); ` +
    `valid_until on superseded rows — ${c.validUntil.call} from the superseder's call, ${c.validUntil.stated} user-stated, ` +
    `${c.validUntil.approx} approximate, ${c.validUntil.none} undatable; ` +
    `calls referenced ${c.callsReferenced}, found ${c.callsResolved}`
  )
}
