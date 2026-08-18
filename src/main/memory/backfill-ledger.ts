// M27 — the import's memory of what it already tried.
//
// Sales Brain's import used to rebuild the full call list and start at index
// zero on EVERY run. With a rate-limited key that is fatal, not merely
// wasteful: the scan breaker stops a run after three consecutive failures, so
// with an exhausted chain the run dies about four calls in — and the next run
// starts at the same four. A user with 104 calls could press the button
// forever and never reach the fifth. That is exactly what was reported.
//
// WHY "ATTEMPTED" AND NOT "SUCCEEDED". The obvious cheaper design is to skip
// calls that already have memories attached, needing no new storage at all.
// It is wrong for a reason worth writing down: producing ZERO memories is a
// legitimate outcome — a short call, a voicemail, a conversation with nothing
// durable in it. Keyed on success, every one of those is retried on every
// future run, forever, burning the very quota this exists to protect. That is
// the same trap in a new place.
//
// So the ledger records the ATTEMPT, and the outcome alongside it for
// diagnosis. A failed attempt is deliberately recorded too, then cleared by
// retryFailedAttempts() at the start of a run — a call that failed because
// the key was exhausted deserves another try once it isn't, while a call that
// simply yielded nothing does not.
import type { Database } from 'better-sqlite3'

export type BackfillOutcome = 'ok' | 'failed' | 'skipped'

/** Call ids the import has already tried, whatever came of it. */
export function attemptedCallIds(db: Database): Set<string> {
  const rows = db.prepare('SELECT call_id FROM backfill_attempts').all() as { call_id: string }[]
  return new Set(rows.map((r) => r.call_id))
}

/** Records one call's outcome. INSERT OR REPLACE, not INSERT: a call retried
 *  after an earlier failure must end up with its LATEST outcome, not collide
 *  on the primary key and throw mid-run. */
export function recordAttempt(db: Database, callId: string, outcome: BackfillOutcome): void {
  db.prepare(
    'INSERT OR REPLACE INTO backfill_attempts (call_id, attempted_at, outcome) VALUES (?, ?, ?)'
  ).run(callId, new Date().toISOString(), outcome)
}

/**
 * Clears FAILED attempts so the next run retries them.
 *
 * Called at the start of every run, deliberately, rather than never recording
 * failures at all: within a single run the ledger must remember a failure (so
 * a resumed run doesn't re-attempt what it just failed on and re-trip the
 * breaker immediately), while across runs a failure is usually transient —
 * the exhausted key that caused it is the single most likely reason to be
 * pressing the button again.
 *
 * 'skipped' is NOT cleared: those are calls with no transcript or explicitly
 * excluded from Sales Brain, and both are stable properties of the call, not
 * transient conditions.
 */
export function retryFailedAttempts(db: Database): number {
  const info = db.prepare("DELETE FROM backfill_attempts WHERE outcome = 'failed'").run()
  return info.changes
}

/** The user-facing "scan everything again" reset. Wipes the whole ledger so
 *  the next run reconsiders every call, including ones that legitimately
 *  produced nothing. */
export function clearAttempts(db: Database): number {
  const info = db.prepare('DELETE FROM backfill_attempts').run()
  return info.changes
}
