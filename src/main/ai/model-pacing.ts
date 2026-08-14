// BUG-058 remainder — cross-purpose request pacing.
//
// THE PROBLEM PER-MODEL COOLDOWN (model-cooldown.ts) DOES NOT SOLVE. Cooldown
// answers "did this model just tell us to back off?" — and once it did, it's
// honest and correct: the SAME purpose won't hit the same model again until
// the cooldown clears. But this app has ~10 purposes (coaching-cue, both
// Deal Intelligence tiers, summaries, scorecards, tasks, three memory
// purposes, prep-brief, coaching-chat) that mostly share the same 1-2
// free-tier keys, both by the founder's own configured chains and by this
// file's own bundled QUALITY_CHAIN default. Confirmed against a real
// ai-fallback-events.jsonl: a model's cooldown clearing doesn't mean "no one
// will ask again for a while" — it means "usable to whichever purpose
// happens to ask next," and with several purposes independently polling on
// their own schedules, something is almost always about to ask. Ten
// purposes each taking one individually-reasonable turn on the same key in
// the same minute IS the failure mode; per-model cooldown was never going
// to fix it, because it only ever protected a model from ONE purpose
// hammering it.
//
// THE FIX: a second, independent question — "did *anyone* just successfully
// use this model, or just get rate-limited by it?" — checked alongside
// cooldown, not instead of it. Deliberately NOT "did anyone just attempt
// it, regardless of outcome": model-cooldown.ts already has an established,
// tested rule that a plain non-rate-limit failure has ZERO lingering effect
// ("only rate limits cool down... applying it to every failure would
// sideline healthy models after one blip") — pacing follows the identical
// rule for the identical reason. A structural/generic error tells us
// nothing about a model being near a shared capacity limit; only a success
// (real capacity spent) or a rate-limit response (direct evidence of being
// near a cap) does.
//
// DELIBERATELY A SKIP, NOT A WAIT. A paced candidate is filtered out of the
// chain the same way a cooling-down one already is — the walk moves to the
// next candidate immediately, at zero added latency whenever the chain has
// another viable entry (which is most of the time; that's what the
// implicit-tail mechanism in complete-with-fallback.ts is for). This never
// becomes a real delay unless every remaining candidate is simultaneously
// cooling down or paced — a case complete-with-fallback.ts's own exhaustion
// path already handles.
//
// NOT A SEPARATE GATE. isPacedFor is not exported. model-cooldown.ts's
// isUsableFor — already the one function every caller in this codebase
// calls — imports it and checks it internally, so a caller who correctly
// calls isUsableFor gets pacing for free and never needs to know this file
// exists. A second, separately-remembered check is exactly the shape that
// let BUG-060 ship (`cancellable: true` defaulted on with nothing actually
// checking `handle.signal`) — one gate, not one more thing to forget.
import type { AIProviderId, CooldownTier } from './types'
import { catalogEntry } from './model-catalog'

/** The DEFAULT pacing gap — how long a model stays "recently used" to a
 *  durable caller after a success or a rate-limit-classified failure (see
 *  markUsed), for any provider without a more specific documented free-tier
 *  rate below. Derived, not guessed: Gemini 2.5 Flash's free-tier limit is
 *  reported as 10-15 RPM depending on source (Google's own current
 *  rate-limits page no longer publishes a static table — it's shown
 *  per-account in AI Studio). Using the conservative end,
 *  60_000ms / 10 requests-per-minute = 6_000ms — the spacing that keeps
 *  this app's own pacing-gated traffic to a shared model at exactly the
 *  full published free-tier rate under worst-case sustained multi-purpose
 *  demand, not below it. Cross-checked (not fit) against this app's real
 *  ai-fallback-events.jsonl: of the few genuine cross-purpose collisions
 *  found there (3 under 60s: 5.2s, 5.3s, 12.1s apart), this gap would have
 *  caught the first two, not the third — consistent with "meaningfully
 *  reduces collisions," not "guarantees none." Worth revisiting with real
 *  post-ship data, same as HARD_CEILING_MS (types.ts) is a considered,
 *  not measured, backstop.
 *
 *  google (Gemini) IS this default — it's where the 10-RPM number comes
 *  from — so it deliberately has no entry in the per-provider map below. */
export const PACING_GAP_MS = 6_000

/**
 * M27 H2 — per-provider gaps where a free tier documents a HIGHER per-request
 * rate than Gemini's conservative 10 RPM. The BUG-058 design that introduced
 * PACING_GAP_MS shipped it as one global constant and explicitly deferred
 * per-provider tuning ("Revisit with real post-ship data rather than more
 * research now"); this is that revisit. Applying the single 6s gap to every
 * provider throttled durable fallback hops on Groq/OpenRouter up to 3x more
 * than their own published free-tier rate requires, adding avoidable latency
 * to every cross-purpose divert that lands on one of them.
 *
 * Each value is 60_000ms / that provider's documented free-tier RPM (see
 * docs/BUG-058-shared-resource-pacing-design.md §1's per-provider research).
 * Deliberately ONE-DIRECTIONAL: only providers whose documented rate is
 * HIGHER than the default get a shorter gap. Any provider whose free-tier
 * rate this session couldn't source (nvidia/cerebras/mistral/anthropic/openai)
 * falls to the conservative 6s default rather than a guessed shorter one —
 * erring short would risk re-clustering the exact multi-purpose pileup
 * BUG-058 exists to prevent, which is a worse failure than a slightly-longer
 * divert.
 */
const PACING_GAP_MS_BY_PROVIDER: Partial<Record<AIProviderId, number>> = {
  // Groq's free tier documents ~30 RPM per model → 60_000 / 30 = 2_000ms.
  groq: 2_000,
  // OpenRouter's free tier documents ~20 req/min → 60_000 / 20 = 3_000ms.
  openrouter: 3_000
}

/** The pacing gap for one catalogId, keyed on its provider. A `legacy:<id>`
 *  step (complete-with-fallback.ts's legacyStep — no catalog entry backs it)
 *  carries its provider in the id itself, so parse that; a real catalog id
 *  resolves through catalogEntry; anything unrecognised falls to the
 *  conservative default. */
function gapMsFor(catalogId: string): number {
  const providerId = catalogId.startsWith('legacy:')
    ? (catalogId.slice('legacy:'.length) as AIProviderId)
    : catalogEntry(catalogId)?.providerId
  return (providerId && PACING_GAP_MS_BY_PROVIDER[providerId]) ?? PACING_GAP_MS
}

interface PacingEntry {
  at: number
  causedBy: CooldownTier
}

const lastUsed = new Map<string, PacingEntry>()

/** Call on the real outcome — a success, or a rate-limit-classified failure
 *  (transient or period-exhausted) — never on a plain/structural failure.
 *  Same call sites as model-cooldown.ts's markRateLimited/
 *  markPeriodExhausted for the failure case, plus the success path
 *  alongside clearCooldown. A live-tier attempt is a deliberate no-op:
 *  never written, so it can never be the reason a durable caller gets
 *  paced (see isPacedFor) — a live purpose firing every 2.5s must not be
 *  able to push a rare, higher-value durable call further down its own
 *  fallback chain just by existing. */
export function markUsed(catalogId: string, now: number, causedBy: CooldownTier): void {
  if (causedBy === 'live') return
  lastUsed.set(catalogId, { at: now, causedBy })
}

/** Not exported past this file's own isUsableFor caller (model-cooldown.ts)
 *  — see the file header on why this must never become a second thing a
 *  caller has to remember to check. Live callers are never paced, matching
 *  their exemption from writing a mark in the first place — pacing exists
 *  entirely to protect durable purposes from each other, not to slow live
 *  work down. A durable caller is paced only by a durable caller's recent
 *  use, never by a live caller's (which never gets recorded at all).
 *  Deliberately NOT purpose-aware — this only knows tier, not which of the
 *  ~10 durable purposes caused the mark, so a purpose that fires twice in
 *  quick succession also spreads across its own fallback candidates rather
 *  than being specially exempted from its own recent use. That's
 *  intentional, not a gap: a burst FROM one purpose risks the same
 *  per-minute window as a burst ACROSS several. */
export function isPacedFor(catalogId: string, now: number, callerTier: CooldownTier): boolean {
  if (callerTier === 'live') return false
  const entry = lastUsed.get(catalogId)
  if (!entry || entry.causedBy === 'live') return false
  return now - entry.at < gapMsFor(catalogId)
}

/** Test-only reset — production code never calls this. */
export function resetPacingForTests(): void {
  lastUsed.clear()
}
