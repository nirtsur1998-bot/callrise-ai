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
import type { AIPurpose, CooldownTier } from './types'
import { isPacedFor } from './model-pacing'

/** Used when the provider rate-limits us but says nothing about when to come
 *  back. Long enough to actually clear a per-minute window, short enough that
 *  a model is never sidelined for a meaningful stretch on a guess. */
export const DEFAULT_COOLDOWN_MS = 60_000

/** No provider's honest retry hint should sideline a model for longer than
 *  this. Caps a malformed or hostile `Retry-After: 86400` from removing a
 *  model for the rest of the session — past this the right answer is to try
 *  again and find out, not to trust a number indefinitely. */
export const MAX_COOLDOWN_MS = 10 * 60_000

// BUG-057 Phase 5 — CooldownTier itself now lives in types.ts (BUG-058's
// pacing work needed the same concept without a circular import between
// this file and model-pacing.ts — see that type's own doc comment there).
// Re-exported here so every existing importer of it from this file keeps
// working unchanged.
//
// What it drives here specifically: `causedBy` on a CooldownEntry is which
// frequency tier CAUSED a given cooldown, not which tier is asking right
// now. Drives the tiered-cooldown bypass in isUsableFor: a durable purpose
// may skip a cooldown a LIVE purpose caused (that purpose's own aggressive
// polling burned this attempt, not a genuine account-wide limit as far as a
// durable caller can tell), but never a cooldown ANY durable purpose caused
// — durable purposes fire rare enough that their own failure is much
// stronger evidence of a real limit, and a live purpose bypassing another
// live purpose's cooldown would defeat BUG-058 entirely.
export type { CooldownTier } from './types'

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
 *  rate limit) until `retryAfterMs` from now, or `resetsAt` (a real or
 *  documented-fixed-schedule quota reset — see AIProviderError.resetsAt's
 *  own doc comment) when no explicit short-term hint exists, or
 *  PERIOD_EXHAUSTED_DEFAULT_MS when NEITHER exists. `retryAfterMs` still
 *  wins outright when present — same rule as markRateLimited: a provider's
 *  own direct instruction beats a broader reset-schedule estimate, which
 *  itself beats a guess. BUG-058 Phase 3 — `resetsAt` is new; before it,
 *  this always fell straight to the 1h guess whenever no direct
 *  retryAfterMs existed, even on the rare provider that DOES tell us
 *  (indirectly) when the quota actually clears. Same never-shorten and same
 *  sticky-durable-causation rules as markRateLimited, and the same map — a
 *  period-exhausted entry IS a cooldown, just one with a deliberately
 *  longer default/cap. */
export function markPeriodExhausted(
  catalogId: string,
  retryAfterMs: number | undefined,
  now: number,
  causedBy: CooldownTier,
  resetsAt?: number
): void {
  const wait = Math.min(
    Math.max(retryAfterMs ?? (resetsAt !== undefined ? resetsAt - now : PERIOD_EXHAUSTED_DEFAULT_MS), 60_000),
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

/**
 * AUDIT FIX (2026-08-24) — keyed by PURPOSE + catalogId, not catalogId alone.
 *
 * The doc comment above has always described the condition correctly: "a 400
 * on this exact request shape". The storage contradicted it. A 400 is by
 * construction a statement about the REQUEST, and a different purpose sends a
 * different request — so punishing the model everywhere, for four hours, on
 * the evidence of one purpose's request was a category error.
 *
 * What it cost in the field: attaching one PDF in Rise sends an OpenAI-only
 * `type:'file'` part to providers that reject it; each 400 blacklisted that
 * model globally, and on a fresh install every purpose falls through to the
 * SHARED synthetic `legacy:${provider.id}` step, with
 * LEGACY_TAIL_MAX['coaching-cue'] = 0 making coaching-cue's chain exactly one
 * entry long. So a single PDF in a chat window killed live call coaching for
 * four hours, with no message naming the cause and no UI to clear it. An
 * oversize prompt fired the same mechanism.
 *
 * Purpose-scoping keeps the protection where the evidence applies — a
 * genuinely broken integration still stops being retried for the purpose that
 * proved it broken — while making cross-purpose damage structurally
 * impossible rather than merely unlikely.
 *
 * NUL as the separator: no AIPurpose or catalogId contains one, so no two
 * distinct (purpose, catalogId) pairs can collide.
 */
const structuralBreaks = new Map<string, number>() // `purpose\0catalogId` -> expiry

const NUL = String.fromCharCode(0)
function breakKey(purpose: AIPurpose, catalogId: string): string {
  return `${purpose}${NUL}${catalogId}`
}

/**
 * BUG-125d (2026-08-28) — the break also records WHY it was set.
 *
 * A structural break benches a model for up to 4h, and until now nothing
 * anywhere remembered what it hard-rejected. The founder hit exactly that
 * wall: their keyed Claude was benched for an image turn and the only thing
 * the product could say was "blocked by the usability gate" — true, useless,
 * and one question short of the answer. The cause is knowable at the moment
 * the break is set and was simply being thrown away.
 *
 * `reason` is the provider's own text as the walk recorded it, so an
 * oversize/format rejection names itself instead of being inferred.
 */
const structuralBreakReasons = new Map<string, string>()

export function markStructurallyBroken(
  catalogId: string,
  now: number,
  purpose: AIPurpose,
  reason?: string
): void {
  const until = now + STRUCTURAL_BREAK_MS
  const key = breakKey(purpose, catalogId)
  const existing = structuralBreaks.get(key)
  if (existing !== undefined && existing >= until) return
  structuralBreaks.set(key, until)
  if (reason) structuralBreakReasons.set(key, reason)
}

/** What this model hard-rejected, if a break is recorded for this purpose. */
export function structuralBreakReason(catalogId: string, purpose: AIPurpose): string | null {
  return structuralBreakReasons.get(breakKey(purpose, catalogId)) ?? null
}

/**
 * `purpose: null` means "no particular purpose is being asked about" and
 * always answers false — the honest answer for a purpose-scoped record. A
 * break proven by ONE purpose's request says nothing about whether a
 * background summarisation job can use the model. Only hasUsableAiCapacity
 * passes null, and deferring every background job because one interactive
 * chat request 400'd is exactly the cross-purpose damage this scoping exists
 * to end.
 *
 * Deliberately names no specific purpose: the principle holds for any pair,
 * and this block is a backport candidate to `main`, which does not have
 * every purpose this branch does. A comment that cites an identifier the
 * target branch lacks is a small lie that ships.
 */
export function isStructurallyBroken(
  catalogId: string,
  now: number,
  purpose: AIPurpose | null
): boolean {
  if (purpose === null) return false
  const key = breakKey(purpose, catalogId)
  const until = structuralBreaks.get(key)
  if (until === undefined) return false
  if (until <= now) {
    structuralBreaks.delete(key)
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
 *  no cost-based reason to make bypass conditional on it either.
 *
 *  BUG-058 remainder — also the single gate for pacing (model-pacing.ts):
 *  checked here, internally, rather than a second call every caller has to
 *  remember to add alongside this one. Checked before the cooldown map, not
 *  after — a model can be "recently used, not yet cooling down" (no failure
 *  has happened at all), which cooldown alone has no way to represent. */
export function isUsableFor(
  catalogId: string,
  now: number,
  callerTier: CooldownTier,
  /** M27 — `ignorePacing` exists for ONE caller: the quota-pressure capacity
   *  check (ai/capacity.ts). Pacing is this app's own self-imposed spacing
   *  (2-6s since WE last used the model), not the provider refusing us — a
   *  model that is merely paced genuinely has capacity. Including it there
   *  would make "no capacity anywhere" briefly true during any ordinary
   *  burst and flicker a user-visible "waiting for provider capacity" label
   *  for a few seconds at a time. Expressed as a flag on this one function
   *  rather than a second near-copy of its logic elsewhere, so the two can
   *  never drift apart (the exact failure mode this codebase's own taxonomy
   *  warns about for duplicated encodings). Every existing caller omits it
   *  and is completely unaffected. */
  opts?: {
    ignorePacing?: boolean
    /** The purpose whose chain this model is being considered for. Required
     *  to consult purpose-scoped structural breaks; `null` (or omitted)
     *  skips that check — see isStructurallyBroken. */
    purpose?: AIPurpose | null
  }
): boolean {
  if (isStructurallyBroken(catalogId, now, opts?.purpose ?? null)) return false
  if (!opts?.ignorePacing && isPacedFor(catalogId, now, callerTier)) return false
  const entry = cooldowns.get(catalogId)
  if (entry === undefined) return true
  if (entry.until <= now) {
    cooldowns.delete(catalogId)
    return true
  }
  return callerTier === 'durable' && entry.causedBy === 'live'
}

/** BUG-154 follow-up (2026-09-01) — a transient failure that never stops
 *  being transient.
 *
 *  openai-compatible.ts classifies Groq's `tool_use_failed` as TRANSIENT on
 *  purpose, and the reasoning is good: malformed generation is sampling-
 *  dependent, so one flaky answer must not bench a whole link in an already-
 *  thin free-tier chain (BUG-066/B2). Nothing, however, counted repetitions,
 *  and 'usually resolves on retry' that never resolves is indistinguishable
 *  from a hard failure nobody is measuring.
 *
 *  MEASURED: driving live calls on the founder's machine produced this exact
 *  error twelve times in a row across two separate calls, same model, same
 *  purpose, zero successes — gpt-oss-120b on Groq cannot satisfy the cue
 *  prompt's forced tool choice at all. Live cues retried it every ~7 seconds
 *  forever and showed the user nothing.
 *
 *  So repetition itself becomes the evidence, rather than reclassifying the
 *  error and throwing away the sampling argument. THREE consecutive failures
 *  on the same model FOR THE SAME PURPOSE, with no success in between, is no
 *  longer a hiccup. Three rather than two: the neighbouring auth demotion
 *  uses two because a 401 is deterministic, whereas this genuinely can
 *  succeed on a retry, so it is given one more chance than a credential is.
 *
 *  PURPOSE-SCOPED, like the break it escalates into: a model that cannot emit
 *  one purpose's tool shape may serve another's perfectly well. Cleared by
 *  any success (see clearCooldown below), so a model that recovers is asked
 *  again immediately rather than serving out the break's TTL. */
export const TRANSIENT_ESCALATION_THRESHOLD = 3

const transientFailures = new Map<string, number>()

/** Records one transient failure. Returns true if THIS call escalated it into
 *  a structural break, so the caller can log the escalation rather than
 *  leaving a silent state change. */
export function noteTransientFailure(
  catalogId: string,
  now: number,
  purpose: AIPurpose
): boolean {
  const key = breakKey(purpose, catalogId)
  const n = (transientFailures.get(key) ?? 0) + 1
  transientFailures.set(key, n)
  if (n < TRANSIENT_ESCALATION_THRESHOLD) return false
  markStructurallyBroken(
    catalogId,
    now,
    purpose,
    `${n} consecutive transient failures with no success in between`
  )
  return true
}

/** A success proves the limit lifted early — trust the evidence over the
 *  estimate. Matters most when the default 60s guess was too pessimistic.
 *  Clears ALL THREE maps: a success is proof regardless of what class the
 *  LAST failure was classified as, and resets the escalation streak — a
 *  model that just worked has earned back the ordinary default, not a
 *  progressively longer wait from failures before it recovered. */
export function clearCooldown(catalogId: string, purpose: AIPurpose): void {
  cooldowns.delete(catalogId)
  // AUDIT FIX (2026-08-24) — clears THIS purpose's break only. A structural
  // break records "this purpose's request shape is rejected by this model";
  // a success on some other purpose is not evidence about that shape, so it
  // must not clear it. Cooldowns and the transient streak stay catalogId-wide
  // because a rate limit genuinely is a property of the model, not the
  // request. Before purpose-scoping, this line deleted a bare catalogId key —
  // after it, that key never exists, so leaving it unchanged would have made
  // every structural break un-clearable until its 4h TTL expired.
  structuralBreaks.delete(breakKey(purpose, catalogId))
  structuralBreakReasons.delete(breakKey(purpose, catalogId))
  transientStreak.delete(catalogId)
  // BUG-154 follow-up — the consecutive-transient counter is purpose-scoped,
  // like the break it escalates into, so it is cleared with the same key.
  transientFailures.delete(breakKey(purpose, catalogId))
}

/** The soonest moment any of these models is worth trying again — FOR THIS
 *  CALLER TIER. BUG-057 Phase 5 — a cooldown the caller could bypass
 *  (isUsableFor) doesn't count: reporting its expiry as "the wait" would
 *  overstate how long a durable caller is actually blocked, since it isn't
 *  blocked by that entry at all. */
export function soonestExpiry(
  catalogIds: string[],
  now: number,
  callerTier: CooldownTier,
  /** AUDIT FIX (2026-08-24) — without this the structural-break check inside
   *  isUsableFor is skipped, and a model broken for this purpose is reported
   *  as already available. */
  purpose?: AIPurpose
): number | null {
  let soonest: number | null = null
  for (const id of catalogIds) {
    if (isUsableFor(id, now, callerTier, { purpose })) continue
    const entry = cooldowns.get(id)
    if (!entry) continue
    if (soonest === null || entry.until < soonest) soonest = entry.until
  }
  return soonest
}

/** Test-only. */
export function resetCooldownsForTests(): void {
  structuralBreakReasons.clear()
  cooldowns.clear()
  structuralBreaks.clear()
  transientStreak.clear()
  transientFailures.clear()
}
