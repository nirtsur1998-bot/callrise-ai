// BUG-148 — stop leading every call with a credential the provider just rejected.
//
// THE BUG. The chain falls back WITHIN a call, but learns nothing BETWEEN
// calls. `deadProviders` is declared inside the walk and dies with it, and
// `markStructurallyBroken` explicitly skips `auth`. So a default provider whose
// key is rejected is attempt #1 on every call, for every purpose, forever —
// one guaranteed-doomed request per call until a human notices.
//
// ── THE DESIGN DECISION THAT SHAPES EVERYTHING ELSE ──────────────────────
//
// **Demotion REORDERS. It never REMOVES.**
//
// The founder named the trap this avoids: "nothing ever retries a demoted
// provider." That is a property of REMOVAL. A step moved to the BACK of the
// chain is still attempted whenever everything ahead of it fails, which buys
// three things at once:
//   - it cannot be orphaned, because it keeps being tried;
//   - its own success is the restoration signal, so no TTL has to manufacture
//     one;
//   - the worst case is exactly today's ordering, so there is no new failure
//     mode to reason about.
//
// ── WHY IN MEMORY, DELIBERATELY ──────────────────────────────────────────
//
// Same stance as model-cooldown.ts, for the same reason plus one more. The
// reported harm — "attempt #1 on every call" — happens entirely within a
// session, so process-lifetime state fixes it completely. And a PERSISTED
// demotion would be a claim about the past presented as the present: a
// provider that rejected us last Tuesday is not necessarily rejecting us now.
// That is the founder's own reasoning for declining to persist key validation
// verdicts (M32 Stage 1a), applied to the same question one layer down. A
// restart is an honest boundary at which to stop assuming.
//
// ── WHY GLOBAL PER PROVIDER, NOT PER PURPOSE ─────────────────────────────
//
// Structural breaks are scoped per purpose because they are about REQUEST
// SHAPE — a tool-schema 400 says nothing about a summarisation job. Auth is
// not request-shaped: a credential is either accepted or it is not, identically
// for every purpose. The walk already agrees, treating auth as "a coarser,
// PROVIDER-wide skip" (complete-with-fallback.ts:1239).
//
// The practical argument is the stronger one. Per-purpose scoping would force
// `coaching-cue` to gather its own evidence MID-CALL, which is the worst place
// in the product to be learning something. Global means a summary that fails at
// 09:00 protects the 10:00 call.
import type { AIProviderId } from './types'

/**
 * Two auth rejections on SEPARATE walks.
 *
 * Not one: a single misclassified error would demote on its own, and
 * `classifyReason` is a heuristic over provider error shapes. Not three (the
 * `FAILURE_EPISODE_LIMIT` purpose-health uses): that number exists to avoid
 * over-counting bursts of TRANSIENT failures, and auth has no such variance —
 * a 401 is deterministic, the same credential will be rejected again
 * immediately. Waiting for a third costs a doomed request to protect against a
 * flicker that cannot happen.
 *
 * Two costs ONE extra doomed request in total — not per call — before the
 * bleeding stops.
 */
export const DEMOTION_THRESHOLD = 2

/**
 * Backstop only. Every ordinary recovery is evidence-driven (a success, or a
 * validated key save), so this exists purely so nothing can be stuck forever
 * if both of those somehow never happen.
 *
 * 4h is `STRUCTURAL_BREAK_MS`, reused rather than newly invented, and for the
 * identical stated reason: nothing wires an explicit "clear this" action, so a
 * wrongly-classified record has to be able to expire on its own.
 *
 * Measured from the LAST rejection, not the first — a provider still actively
 * rejecting us should stay demoted, and one that has gone quiet should age out.
 */
export const DEMOTION_TTL_MS = 4 * 60 * 60_000

interface DemotionRecord {
  /** Distinct walks that ended in an auth rejection for this provider. */
  rejections: number
  /** When the count reached DEMOTION_THRESHOLD — i.e. when demotion began.
   *  Null while still below it. Displayed to the user, so it must mean
   *  "demoted since", not "first complained since". */
  demotedAt: number | null
  lastRejectionAt: number
}

const records = new Map<AIProviderId, DemotionRecord>()

/** Expired records are dropped rather than left to accumulate a stale count —
 *  a provider that rejected us once six hours ago must start from zero, or the
 *  threshold silently becomes "one rejection, eventually". */
function live(providerId: AIProviderId, now: number): DemotionRecord | undefined {
  const record = records.get(providerId)
  if (!record) return undefined
  if (now - record.lastRejectionAt > DEMOTION_TTL_MS) {
    records.delete(providerId)
    return undefined
  }
  return record
}

/**
 * One walk ended with this provider rejecting our credential.
 *
 * MUST be called at most once per walk per provider. Within a single walk a
 * provider can be attempted more than once (a legacy step and a bundled entry
 * on the same key), and counting those separately would demote on the strength
 * of one call — which is the "one rejection" option that was explicitly not
 * chosen. The callers own that de-duplication; see `authNotedThisWalk` in
 * complete-with-fallback.ts.
 */
export function noteAuthRejection(providerId: AIProviderId, now: number): void {
  const existing = live(providerId, now)
  const rejections = (existing?.rejections ?? 0) + 1
  records.set(providerId, {
    rejections,
    demotedAt:
      existing?.demotedAt ?? (rejections >= DEMOTION_THRESHOLD ? now : null),
    lastRejectionAt: now
  })
}

/** Should this provider give up its place at the front of the chain? */
export function isDemoted(providerId: AIProviderId, now: number): boolean {
  // `!= null` (loose, deliberately) covers both "no record at all" — the
  // optional chain yields undefined — and "recorded but still below the
  // threshold", where demotedAt is null. Those are the same answer here.
  return live(providerId, now)?.demotedAt != null
}

/**
 * Forget everything about this provider.
 *
 * Called on any success from it (the evidence a reordered step keeps
 * generating), and on a key save that validates — a hook that exists only
 * because M32 Stage 1a made saving validate. That second one is what stops this
 * from punishing a restored key: fix the key in Settings and the demotion is
 * gone before you leave the screen.
 */
export function clearDemotion(providerId: AIProviderId): void {
  records.delete(providerId)
}

/** For the UI: enough to say what happened and when, without hunting. */
export function demotionState(
  providerId: AIProviderId,
  now: number
): { demoted: boolean; rejections: number; demotedAt: number | null } | null {
  const record = live(providerId, now)
  if (!record) return null
  return {
    demoted: record.demotedAt !== null,
    rejections: record.rejections,
    demotedAt: record.demotedAt
  }
}

/** Test seam. Module state is process-global by design; a test that leaves a
 *  demotion behind would silently reorder another test's chain. */
export function resetDemotionsForTests(): void {
  records.clear()
}
