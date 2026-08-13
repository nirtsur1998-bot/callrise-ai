// The "scan past calls" loop's own bookkeeping, kept as pure logic with no
// Electron import so it stays testable the way crm-note-generator.ts and
// coaching-chat.ts are — the loop itself lives in calls.ts's job executor.
//
// This exists because the accounting has a genuinely subtle rule in it: the
// scan shares mineCallIntoQueue() with the automatic post-call auto-mine
// hook, and the two legitimately collide (a call saved just before a scan
// starts is still unmined when the eligible list is snapshotted, so the
// scan picks it up while the auto-mine's AI call is still in flight). That
// collision must be reported as a SKIP, never a failure — the scan's
// circuit breaker aborts the whole remaining run after 3 consecutive
// failures, so counting harmless collisions as failures could stop a scan
// early on a perfectly healthy API and report "stopped after repeated
// errors".

/** How many consecutive genuine failures before the scan gives up. A run
 *  this long means the API is down/rate-limited, so continuing would just
 *  burn a doomed request per remaining call. */
export const CONSECUTIVE_FAILURE_LIMIT = 3

/** One call's mining outcome, as far as the tally cares. */
export type ScanOutcome =
  /** Mined successfully (possibly adding 0 candidates). */
  | { kind: 'ok'; added: number }
  /** Genuinely failed — counts toward the circuit breaker. */
  | { kind: 'failed' }
  /** Already being mined by the other trigger right now. Not a failure. */
  | { kind: 'skipped' }

export type ScanStopReason = 'disabled' | 'errors'

export interface ScanTallyState {
  scanned: number
  candidatesAdded: number
  failed: number
  skipped: number
  stopped?: ScanStopReason
}

export interface ScanTally {
  /** Record one call's outcome. Returns 'stop' when the circuit breaker has
   *  tripped and the caller should break out of its loop. */
  record: (outcome: ScanOutcome) => 'continue' | 'stop'
  /** Mark the run as stopped because the feature toggle was flipped off
   *  mid-scan (the hard gate — "off means no call is ever read"). */
  stopDisabled: () => void
  /** How many calls have been dealt with, for progress reporting. */
  itemsDone: () => number
  state: () => ScanTallyState
  /** The human summary shown in the Activity Center / on the card. */
  summary: () => string
}

/** BUG-057 also reuses this module (memory/backfill.ts) for the Sales Brain
 *  import — the accounting rule it encodes (a skip is not a failure; three
 *  consecutive failures mean the API is down, so stop burning a doomed
 *  request per remaining item) is identical there, and worth having in
 *  exactly one place. That caller composes its own summary sentence from
 *  state()/itemsDone() rather than calling summary() below, so this module's
 *  wording stays the objection scan's own and needs no parameterization. */
export function createScanTally(): ScanTally {
  let scanned = 0
  let candidatesAdded = 0
  let failed = 0
  let skipped = 0
  let consecutiveFailures = 0
  let stopped: ScanStopReason | undefined

  return {
    record(outcome) {
      if (outcome.kind === 'skipped') {
        // Deliberately does NOT touch consecutiveFailures in either
        // direction: a skip is not a failure, but it is also no evidence
        // the API recovered, so a genuine outage interleaved with skips
        // still trips the breaker at the same point it otherwise would.
        skipped++
        return 'continue'
      }
      if (outcome.kind === 'ok') {
        scanned++
        candidatesAdded += outcome.added
        consecutiveFailures = 0
        return 'continue'
      }
      failed++
      if (++consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
        stopped = 'errors'
        return 'stop'
      }
      return 'continue'
    },
    stopDisabled() {
      stopped = 'disabled'
    },
    itemsDone() {
      return scanned + failed + skipped
    },
    state() {
      return { scanned, candidatesAdded, failed, skipped, stopped }
    },
    summary() {
      const parts = [`Scanned ${scanned} call${scanned === 1 ? '' : 's'}`]
      parts.push(`found ${candidatesAdded} suggestion${candidatesAdded === 1 ? '' : 's'}`)
      if (failed > 0) parts.push(`${failed} failed`)
      // Named honestly rather than hidden: these calls WERE mined, just by
      // the other trigger, so the totals adding up needs explaining.
      if (skipped > 0) parts.push(`${skipped} already being mined`)
      if (stopped === 'errors') parts.push('stopped after repeated errors')
      else if (stopped === 'disabled') parts.push('stopped — toggle turned off')
      return parts.join(', ')
    }
  }
}
