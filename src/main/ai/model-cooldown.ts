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

/** BUG-057 Phase 5 — which frequency tier CAUSED a given cooldown, not which
 *  tier is asking right now. `'live'` = a purpose in CHAIN_BUDGET
 *  (coaching-cue, deal-tier1 — fires every ~2.5s while a call is active).
 *  `'durable'` = everything else (summary, memory-extract, etc. — fires on
 *  its own, much slower cadence). Drives the tiered-cooldown bypass in
 *  isUsableFor: a durable purpose may skip a cooldown a LIVE purpose caused
 *  (that purpose's own aggressive polling burned this attempt, not a
 *  genuine account-wide limit as far as a durable caller can tell), but
 *  never a cooldown ANY durable purpose caused — durable purposes fire rare
 *  enough that their own failure is much stronger evidence of a real
 *  limit, and a live purpose bypassing another live purpose's cooldown
 *  would defeat BUG-058 entirely. */
export type CooldownTier = 'live' | 'durable'

interface CooldownEntry {
  until: number
  causedBy: CooldownTier
}

const cooldowns = new Map<string, CooldownEntry>()

/** BUG-057 Phase 4 — how many consecutive no-hint rate-limits this model has
 *  taken in a row. NOT LiteLLM's `allowed_fails_policy` (permit N failures,
 *  then deprioritize) — this escalates the cooldown's DURATION using this
 *  file's existing exponential-backoff idiom
 *  (`completeWithSameModelRetry`'s `Math.min(200 * 2**attempt, 2_000)`),
 *  reusing the codebase's actual primitive (a `Map<catalogId, until>`)
 *  rather than adding a new counter subsystem. A model that keeps getting
 *  rate-limited with no explicit hint is asked about progressively less
 *  often; reset to zero the moment a real attempt succeeds.
 *
 *  Shared across tiers deliberately — a live purpose's miss and a durable
 *  purpose's miss on the SAME model both count toward the same streak, on
 *  the same "repeated misses ARE evidence of sustained pressure" logic
 *  regardless of who observed them. */
const transientStreak = new Map<string, number>()

/** Mark a model as not-worth-asking until `retryAfterMs` from now (or an
 *  escalating guess when the provider gave no hint at all). Never shortens
 *  an existing cooldown: two concurrent jobs can both get 429s, and the
 *  later one reporting a shorter delay must not undo the longer wait.
 *
 *  BUG-057 Phase 5 — a 'live' caller's re-mark of an already-'durable'-
 *  caused cooldown KEEPS 'durable' causation (the more restrictive tag)
 *  rather than overwriting it: a durable purpose's failure is stronger
 *  evidence of a real, account-wide limit than a live purpose's, since
 *  durable purposes fire far less often and are less likely to be the
 *  cause of a self-inflicted burst. */
export function markRateLimited(
  catalogId: string,
  retryAfterMs: number | undefined,
  now: number,
  causedBy: CooldownTier
): void {
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
  if (existing !== undefined && existing.until >= until) return
  const nextCausedBy = existing?.causedBy === 'durable' ? 'durable' : causedBy
  cooldowns.set(catalogId, { until, causedBy: nextCausedBy })
}

/** When this model becomes worth trying again FOR ANYONE, or null if it is
 *  available now. Tier-agnostic — a durable caller that could actually
 *  bypass a live-caused cooldown should use isUsableFor, not this. Expired
 *  entries are dropped on read — there is no sweeper, and this map only
 *  ever holds models that have actually been rate-limited. */
export function cooldownUntil(catalogId: string, now: number): number | null {
  const entry = cooldowns.get(catalogId)
  if (entry === undefined) return null
  if (entry.until <= now) {
    cooldowns.delete(catalogId)
    return null
  }
  return entry.until
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
 *  when the provider gave no hint. Same never-shorten and same sticky-
 *  durable-causation rules as markRateLimited, and the same map — a
 *  period-exhausted entry IS a cooldown, just one with a deliberately
 *  longer default/cap. */
export function markPeriodExhausted(
  catalogId: string,
  retryAfterMs: number | undefined,
  now: number,
  causedBy: CooldownTier
): void {
  const wait = Math.min(
    Math.max(retryAfterMs ?? PERIOD_EXHAUSTED_DEFAULT_MS, 60_000),
    PERIOD_EXHAUSTED_MAX_MS
  )
  const until = now + wait
  const existing = cooldowns.get(catalogId)
  if (existing !== undefined && existing.until >= until) return
  const nextCausedBy = existing?.causedBy === 'durable' ? 'durable' : causedBy
  cooldowns.set(catalogId, { until, causedBy: nextCausedBy })
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
 *  isn't a wait-then-retry condition the same way a cooldown is), now tiered:
 *  a `'durable'` caller may bypass a cooldown that a `'live'` caller caused
 *  — but never one a `'durable'` caller caused, and never a structural
 *  break regardless of tier (deterministic, not a wait-then-retry
 *  condition any caller can reason its way past).
 *
 *  BUG-057 Phase 5 — bypass is deliberately ALL-OR-NOTHING with respect to
 *  BUG-057 Phase 4's escalation: it does not partially respect an escalated
 *  duration versus a base one. A live-tier cooldown only escalates through
 *  REPEATED misses, each requiring the prior cooldown to have fully expired
 *  first (coaching-cue polls every ~2.5s, so a live-only escalation to the
 *  cap takes several minutes of genuinely sustained pressure) — so by the
 *  time a durable purpose fires "minutes later" (the exact scenario this
 *  tiering exists to fix), the cooldown it's checking is very likely
 *  already in an escalated state. Requiring durable bypass to respect that
 *  escalation would silently defeat Phase 5 in its own headline case. The
 *  cost model backs this too: a bypass is framed as one bounded HTTP round
 *  trip that falls through like any ordinary failure if wrong — a fixed
 *  cost that doesn't scale with how escalated the cooldown is, so there's
 *  no cost-based reason to make bypass conditional on it either. */
export function isUsableFor(catalogId: string, now: number, callerTier: CooldownTier): boolean {
  if (isStructurallyBroken(catalogId, now)) return false
  const entry = cooldowns.get(catalogId)
  if (entry === undefined) return true
  if (entry.until <= now) {
    cooldowns.delete(catalogId)
    return true
  }
  return callerTier === 'durable' && entry.causedBy === 'live'
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

/** The soonest moment any of these models is worth trying again — FOR THIS
 *  CALLER TIER. BUG-057 Phase 5 — a cooldown the caller could bypass
 *  (isUsableFor) doesn't count: reporting its expiry as "the wait" would
 *  overstate how long a durable caller is actually blocked, since it isn't
 *  blocked by that entry at all. */
export function soonestExpiry(catalogIds: string[], now: number, callerTier: CooldownTier): number | null {
  let soonest: number | null = null
  for (const id of catalogIds) {
    if (isUsableFor(id, now, callerTier)) continue
    const entry = cooldowns.get(id)
    if (!entry) continue
    if (soonest === null || entry.until < soonest) soonest = entry.until
  }
  return soonest
}

/** Test-only. */
export function resetCooldownsForTests(): void {
  cooldowns.clear()
  structuralBreaks.clear()
  transientStreak.clear()
}
