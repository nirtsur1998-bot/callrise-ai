// BUG-058 — remember that a model just rate-limited us, and stop asking it.
//
// THE SPIRAL THIS EXISTS TO BREAK. Before this, nothing anywhere remembered a
// 429. Every call re-walked the chain from position 1, so the model that was
// rate-limited two seconds ago got hit first, again, every single time —
// coaching-cue fires roughly every 2.5s, so that is a doomed request every
// 2.5s against a provider actively telling us to back off. Worse, each failed
// call then walked the WHOLE remaining chain, so one provider's rate limit
// was converted into hitting every other provider's limit too: on a 9-entry
// quality chain with retries, a single failed summary costs ~25 requests
// across 6 providers. Two operations can exhaust a free-tier account set.
//
// A cooldown inverts that: under pressure the chain gets SHORTER, not longer,
// and a provider is given the time it explicitly asked for.
//
// Deliberately in-memory only. A rate limit is a seconds-to-minutes condition
// and process restarts are rare compared to its lifetime; persisting it would
// mean a stale file could suppress a model that recovered hours ago. This is
// the opposite of PurposeHealth (ai/purpose-health.ts), which persists
// precisely because it describes a days-long condition.
//
// Keyed by catalogId, not provider: Groq and Gemini rate-limit per MODEL, so
// a sibling model on the same key is often still usable. A genuine
// account-wide limit simply marks each model as it is tried.

/** Used when the provider rate-limits us but says nothing about when to come
 *  back. Long enough to actually clear a per-minute window, short enough that
 *  a model is never sidelined for a meaningful stretch on a guess. */
export const DEFAULT_COOLDOWN_MS = 60_000

/** No provider's honest retry hint should sideline a model for longer than
 *  this. Caps a malformed or hostile `Retry-After: 86400` from removing a
 *  model for the rest of the session — past this the right answer is to try
 *  again and find out, not to trust a number indefinitely. */
export const MAX_COOLDOWN_MS = 10 * 60_000

const cooldowns = new Map<string, number>()

/** BUG-057 Phase 4 — how many consecutive no-hint rate-limits this model has
 *  taken in a row. NOT LiteLLM's `allowed_fails_policy` (permit N failures,
 *  then deprioritize) — this escalates the cooldown's DURATION using this
 *  file's existing exponential-backoff idiom
 *  (`completeWithSameModelRetry`'s `Math.min(200 * 2**attempt, 2_000)`),
 *  reusing the codebase's actual primitive (a `Map<catalogId, until>`)
 *  rather than adding a new counter subsystem. A model that keeps getting
 *  rate-limited with no explicit hint is asked about progressively less
 *  often; reset to zero the moment a real attempt succeeds. */
const transientStreak = new Map<string, number>()

/** Mark a model as not-worth-asking until `retryAfterMs` from now (or an
 *  escalating guess when the provider gave no hint at all). Never shortens
 *  an existing cooldown: two concurrent jobs can both get 429s, and the
 *  later one reporting a shorter delay must not undo the longer wait. */
export function markRateLimited(catalogId: string, retryAfterMs: number | undefined, now: number): void {
  const streak = (transientStreak.get(catalogId) ?? 0) + 1
  transientStreak.set(catalogId, streak)
  // Escalate ONLY the no-hint guess. An explicit Retry-After is a direct
  // instruction from the provider and must win outright — that's BUG-058's
  // whole point, unaffected here. Only the DEFAULT_COOLDOWN_MS guess grows
  // with repeated misses.
  const guessed = Math.min(DEFAULT_COOLDOWN_MS * 2 ** (streak - 1), MAX_COOLDOWN_MS)
  const wait = Math.min(Math.max(retryAfterMs ?? guessed, 1_000), MAX_COOLDOWN_MS)
  const until = now + wait
  const existing = cooldowns.get(catalogId)
  if (existing !== undefined && existing >= until) return
  cooldowns.set(catalogId, until)
}

/** When this model becomes worth trying again, or null if it is available
 *  now. Expired entries are dropped on read — there is no sweeper, and this
 *  map only ever holds models that have actually been rate-limited. */
export function cooldownUntil(catalogId: string, now: number): number | null {
  const until = cooldowns.get(catalogId)
  if (until === undefined) return null
  if (until <= now) {
    cooldowns.delete(catalogId)
    return null
  }
  return until
}

export function isCoolingDown(catalogId: string, now: number): boolean {
  return cooldownUntil(catalogId, now) !== null
}

/** BUG-057 Phase 2 — a period-exhausted failure (daily/monthly free-tier cap,
 *  credits exhausted) clears on a clock the account doesn't control
 *  minute-to-minute, unlike an ordinary rate limit. Reuses the SAME
 *  `cooldowns` map as markRateLimited — both are "don't ask again until
 *  this time" — but with its own default/cap tuned for a much longer wait,
 *  since retrying inside a quota window is pure waste, not just impolite. */
const PERIOD_EXHAUSTED_DEFAULT_MS = 60 * 60_000 // 1h — CHOSEN, not sourced: no
// adapter today surfaces a provider-stated "resets in N hours" for a quota
// response (only retryAfterMs exists, and it's absent for Anthropic/OpenAI-
// direct entirely). Long enough not to hammer a period cap on a guess; short
// enough that a mislabeled transient-as-period-exhausted doesn't idle a
// model for a full day.
const PERIOD_EXHAUSTED_MAX_MS = 24 * 60 * 60_000 // 24h — the common unit for
// free-tier daily caps across this app's provider set (Groq, Gemini,
// OpenRouter free tiers are all documented as daily-reset).

/** Mark a model as period-exhausted (a quota/billing cap, not an ordinary
 *  rate limit) until `retryAfterMs` from now, or PERIOD_EXHAUSTED_DEFAULT_MS
 *  when the provider gave no hint. Same never-shorten rule as
 *  markRateLimited, and the same map — a period-exhausted entry IS a
 *  cooldown, just one with a deliberately longer default/cap. */
export function markPeriodExhausted(catalogId: string, retryAfterMs: number | undefined, now: number): void {
  const wait = Math.min(
    Math.max(retryAfterMs ?? PERIOD_EXHAUSTED_DEFAULT_MS, 60_000),
    PERIOD_EXHAUSTED_MAX_MS
  )
  const until = now + wait
  const existing = cooldowns.get(catalogId)
  if (existing !== undefined && existing >= until) return
  cooldowns.set(catalogId, until)
}

/** BUG-057 Phase 2 — a structural failure (auth rejected, model delisted, a
 *  400 on this exact request shape) will very likely fail again immediately,
 *  so unlike a rate limit no clock fixes it directly. A truly permanent,
 *  only-manually-clearable entry would be unsafe in this codebase today:
 *  nothing wires an explicit clear action to it (no Settings button, no IPC
 *  handler), so a wrongly-classified structural failure would silently and
 *  invisibly blacklist a model for the life of the process with zero
 *  corrective path. STRUCTURAL_BREAK_MS is therefore a long, self-healing
 *  TTL — CHOSEN (no provider documents "how long until we reconsider a
 *  400"): long enough that a genuinely broken integration (wrong tool
 *  schema, delisted model) isn't retried every few minutes wasting a real
 *  attempt, short enough that a misclassification self-heals within a
 *  working day rather than needing a process restart. Also cleared early by
 *  success, same as a normal cooldown — proof beats the guess whenever we
 *  get proof. */
export const STRUCTURAL_BREAK_MS = 4 * 60 * 60_000 // 4h

const structuralBreaks = new Map<string, number>() // catalogId -> expiry, same shape as `cooldowns`

export function markStructurallyBroken(catalogId: string, now: number): void {
  const until = now + STRUCTURAL_BREAK_MS
  const existing = structuralBreaks.get(catalogId)
  if (existing !== undefined && existing >= until) return
  structuralBreaks.set(catalogId, until)
}

export function isStructurallyBroken(catalogId: string, now: number): boolean {
  const until = structuralBreaks.get(catalogId)
  if (until === undefined) return false
  if (until <= now) {
    structuralBreaks.delete(catalogId)
    return false
  }
  return true
}

/** The single gate chain resolution should filter on — cooling down (an
 *  ordinary rate limit or a period-exhausted cap, same map) OR structurally
 *  broken (a separate map, since "will not succeed for this request shape"
 *  isn't a wait-then-retry condition the same way a cooldown is). */
export function isUsable(catalogId: string, now: number): boolean {
  return !isCoolingDown(catalogId, now) && !isStructurallyBroken(catalogId, now)
}

/** A success proves the limit lifted early — trust the evidence over the
 *  estimate. Matters most when the default 60s guess was too pessimistic.
 *  Clears ALL THREE maps: a success is proof regardless of what class the
 *  LAST failure was classified as, and resets the escalation streak — a
 *  model that just worked has earned back the ordinary default, not a
 *  progressively longer wait from failures before it recovered. */
export function clearCooldown(catalogId: string): void {
  cooldowns.delete(catalogId)
  structuralBreaks.delete(catalogId)
  transientStreak.delete(catalogId)
}

/** The soonest moment any of these models is worth trying again. Used to tell
 *  the user how long to wait instead of reporting a generic failure. */
export function soonestExpiry(catalogIds: string[], now: number): number | null {
  let soonest: number | null = null
  for (const id of catalogIds) {
    const until = cooldownUntil(id, now)
    if (until === null) continue
    if (soonest === null || until < soonest) soonest = until
  }
  return soonest
}

/** Test-only. */
export function resetCooldownsForTests(): void {
  cooldowns.clear()
  structuralBreaks.clear()
  transientStreak.clear()
}
