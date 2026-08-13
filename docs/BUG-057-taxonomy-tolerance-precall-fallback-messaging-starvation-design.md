# BUG-057 Final Design — Failure Taxonomy, Tolerance, Pre-Call Checks, Fallback, Messaging, Starvation

All file:line citations below were re-read directly against `C:\Users\User\Desktop\callrise-m26` in this pass (not
carried over from the first-pass document or the critiques on faith). Where I relied on a prior pass's citation
without re-opening the file myself, I say so explicitly.

## CHANGES FROM FIRST PASS

Three critiques were run against the first pass. Two found fatal problems that are fixed here, not just
acknowledged; one found the baseline section itself was sound. Point-by-point:

1. **FATAL, fixed — `markStructurallyBroken` was a permanent, invisible, un-clearable trap.**
   Re-confirmed myself: `complete-with-fallback.ts:398` and `:561` filter `chain` *before* any attempt is made;
   `clearCooldown` (the only place the first pass wired a `structurallyBroken.delete()`) is called only at
   `:477`/`:616`, both inside a *successful* step — unreachable for an ID the filter already excluded. I also
   confirmed `catalog-ipc.ts` has **zero import of `model-cooldown.ts`** — the first pass's claimed "Settings
   Refresh escape hatch" doesn't exist in code. **Fix**: `structurallyBroken` now carries a real expiry
   (`STRUCTURAL_BREAK_MS`, sourced/chosen below) instead of "clears on success, which can never happen" — it
   self-heals like every other entry in this file, consistent with the module's own stated philosophy
   (`model-cooldown.ts:16-20`, quoted in §2.3).
2. **FATAL, fixed — `classifyFailureClass`'s ambiguous-case default was backwards.** First pass defaulted
   unclassifiable errors to `'structural'` (the *least* forgiving, and — per finding 1 — formerly the
   *unrecoverable* bucket) calling it "conservative." Actually conservative for an error we can't confidently
   place is the class that self-heals fastest even if we guessed wrong. **Fix**: default is now `'transient'`.
3. **FATAL, fixed — starvation Option 1 ("ship now") was either a no-op or actively regressive.** Re-derived the
   arithmetic myself (below, §7) rather than trusting either the first pass's "3 shared tail entries" framing or
   the critique's rebuttal at face value: both are partially right. Cooldown state keys purely on `catalogId`
   (`model-cooldown.ts:37`, `Map<string, number>`, no order/list dimension) so "reorder" is a true no-op. "Drop"
   would gut `QUALITY_CHAIN`'s Groq/Cerebras safety-net tail, which `complete-with-fallback.ts:49-53`'s own
   comment states exists specifically so a Groq-only user's non-speed purposes keep working — directly
   contradicts THE BAR. **Fix**: Option 1 is dropped entirely. §7 now specifies a corrected, complete version of
   the tiered-cooldown mechanism (former "Option 2") as the only mechanism proposed, with both code bugs the
   critique found repaired, given as a real diff rather than a sketch.
4. **SIGNIFICANT, fixed — starvation's own overlap count missed `memory-extract`.** Re-confirmed directly:
   `memory-extract`'s chain (`complete-with-fallback.ts:111`) is `[...new Set([...SPEED_CHAIN, ...QUALITY_CHAIN])]`
   — the *entire* `SPEED_CHAIN`, not a 3-entry tail. It collides with coaching-cue/deal-tier1 on **both** reachable
   entries (`groq-llama-3.1-8b-instant`, `groq-llama-3.3-70b-versatile`), not one. §7 now treats this as the
   primary worked example, not a footnote.
5. **SIGNIFICANT, fixed — C's "must not eliminate silently" safeguard was unreachable dead code.** The first
   pass's guard (`filterCapability(resolved).length === 0` after `resolved` was already filtered) can never be
   true when `resolved.length > 0`, and when every model is filtered out, `resolved` itself becomes `[]` and the
   caller can no longer tell "no keys" from "no tool-capable models" apart. **Fix**: `resolveChain` now returns
   the pre-filter and post-filter lists separately; the caller — not an internal, unreachable check — decides
   which empty-set message applies. See §4.
6. **SIGNIFICANT, fixed — `supportsToolCalling: false` had zero revalidation loop, unlike its own stated
   `knownStale` precedent.** `model-catalog.ts:55-58`'s `knownStale` doc comment (re-read directly) states
   `resolveCatalog()` re-checks it live; nothing analogous exists for a hand-set capability flag, and the first
   pass's own text admitted this while treating it as settled. **Fix**: promoted from a passing mention to an
   explicit Open Question with a concrete mitigation (dated-comment + quarterly audit obligation, tied to the
   existing catalog-audit convention) rather than left implicit.
7. **SIGNIFICANT, fixed — E's live-path fix relabeled a `HARD_CEILING_MS` timeout as "rate-limited."** Confirmed
   `live-cue.ts:490-501` and `deal-tier1.ts:265-270` today special-case only `AllModelsExhaustedError`, falling
   through to bare `{ ok: false }` for anything else — including a ceiling timeout, which is a genuinely different
   condition (a live, responding-but-slow provider) from "every model is cooling down." **Fix**: `pausedReason`
   gains a second value, `'timed-out'`, so the UI copy stops claiming "unreachable or rate-limited" for a case
   that's neither. See §6.1.
8. **MINOR, accepted — B was quietly narrower than "tolerance."** The first pass built escalating cooldown
   *duration*, not permit-N-failures-before-deprioritizing. Kept the same mechanism (it's the right one — see
   §3) but now says explicitly that this is a *reinterpretation* of the CONTEXT block's "tolerance" ask onto this
   codebase's actual cooldown-shaped primitive, not literally LiteLLM's counter-based policy.
9. **MINOR, accepted — G undersold that E's live-path fix touches ceiling-adjacent code.** Fixed in §8 (G) below
   by naming it explicitly rather than implying A-F are the only sections that touch claims 1-4's territory.
10. **MINOR, accepted — the two independent encodings of "don't double-count auth."** Collapsed to one: the
    catch-block in §2.3 now branches on `reason === 'auth'` (the same string already checked) and no longer
    relies on `classifyFailureClass`'s output agreeing with it by construction.
11. **Baseline section (claims 1-4)** — the adversarial re-read confirmed no stale reasoning was imported and both
    cited tests are genuine, non-cooperative-mock proofs. I re-confirmed the two load-bearing facts myself this
    pass (`isCoolingDown`/`clearCooldown` call sites; provider quota-keyword unreachability in the `RateLimitError`
    branch) rather than re-trusting the citation. The critique's one nitpick (a two-line citation offset) is
    real but cosmetic and not repeated below since I re-cite fresh line numbers from my own reads.

---

## EXECUTIVE SUMMARY

Already shipped and **not redesigned here** (re-confirmed by direct read this pass, not just quoted from VERIFY):
retries are fully ours, bounded, and abortable (`maxRetries: 0` at 9 sites, `completeWithSameModelRetry` the only
loop); a hard wall-clock ceiling (`HARD_CEILING_MS`) reaches every SDK call via `AbortSignal.any`; cancellation
threads a real signal through every job type that opts in (`cancellable` now defaults `false`); the rate-limit
cooldown genuinely engages before any internal SDK retry can hide it. All four hold under this pass's own
re-reads.

What's actually designed here, and why: today one `Map<catalogId, expiry>` (`model-cooldown.ts`) is the entire
memory of failure — no distinction between "wait 10 seconds" and "wait until tomorrow" and "never send this
request again," no tolerance before a flaky model is deprioritized, no way to skip a model that structurally
can't do tool calls before spending a real attempt on it, a flat generic exhaustion message, and — confirmed by
re-deriving the actual chain data, not assuming it — a real starvation path where `coaching-cue`'s two reachable
models (`SPEED_CHAIN.slice(0,2)`) are the *entirety* of what `memory-extract`'s chain shares with it, meaning a
busy live call can cool down every model a background extraction purpose can reach.

This pass adds: (A) a three-class failure taxonomy (`transient`/`period-exhausted`/`structural`) with its own
cooldown *shape* per class, including a real fix for two prior-pass bugs — a self-healing expiry for structural
breaks (previously permanent and invisible) and a transient-safe default for ambiguous errors (previously the
unrecoverable bucket); (B) escalating transient-cooldown duration on repeated unhinted misses, reusing the
existing exponential-backoff idiom already in this file; (C) a static, hand-verified `supportsToolCalling` catalog
flag with an honestly-scoped elimination path (fixed to actually distinguish "no keys" from "no capable models",
unlike the first pass's unreachable guard) and a named staleness risk with no automatic fix; (D) confirmation that
fallback traversal needs no change beyond catalogId-level filtering; (E) a real three-way (`wait`/`add-key`/`bug`)
message classifier, plus closing three confirmed silent/mislabeled paths (two live purposes swallowing
timeout/cooldown into total silence, `deal-risk.ts` missing an `AllModelsExhaustedError` branch, `coaching-chat`
mislabeling "everything cooling down" as "nothing configured"); (F) a corrected, fully-specified tiered cooldown
(`'live'` vs `'durable'` causation) replacing the first pass's disproven "just reorder the chains" idea, since
that idea provably does nothing.

Needs deciding before/alongside build: the 1h/24h period-exhausted cooldown bounds and the structural-break TTL
are **chosen, not measured** (§2.3, §7); whether `supportsToolCalling` gets a periodic re-probe cost budget (§4);
whether the tiered-cooldown fairness tradeoff in §7 is worth its added state given only 2 catalogIds are affected
today. None of this blocks the phase-1 (E) live-path fixes, which touch no new state.

---

## 1. RE-VERIFIED BASELINE

**Claim 1 (retries fully ours, bounded, abortable) — CONFIRMED, re-read fresh this pass.**
`types.ts` — `LatencyPolicyEntry` has exactly one field, `timeoutMs: number`; no `maxRetries` anywhere on it (grep
confirms zero hits outside comments explaining its removal). `complete-with-fallback.ts:356-380`,
`completeWithSameModelRetry`, is the only retry loop; scoped to `reason === 'network' || reason === 'timeout'`;
bounded by `SAME_MODEL_RETRY_LIMIT[purpose]`; every attempt passes the same `signal` parameter through unchanged.
`grep -n "maxRetries: 0" src/main/ai/providers/*.ts` (run fresh this pass) returns exactly 9 hits across
`anthropic.ts`, `openai.ts`, `openai-compatible.ts` (3 each: `complete()`, `stream()`, `validateKey()`) —
`gemini.ts` has no SDK retry to disable (bespoke `fetch` adapter). No gap.

**Claim 2 (hard wall-clock ceiling) — CONFIRMED, re-read fresh this pass.** `complete-with-fallback.ts` constructs
`ceiling`/`ceilingTimer` from `HARD_CEILING_MS[purpose]`, unconditionally puts `ceiling.signal` first when
composing `attemptSignal` via `AbortSignal.any`, and that composed signal — not just the outer loop — is what
reaches `completeWithSameModelRetry` → `provider.complete()`. A distinct `AIProviderError('timeout', …)` is thrown
separately from `AllModelsExhaustedError`. No gap.

**Claim 3 (cancellation real everywhere) — CONFIRMED.** `JobManager.ts:150`, `cancellable: def.cancellable ?? false`
— re-grepped fresh, exact match. The `AbortSignal.any` composition pattern this claim depends on for correctness
is the same one independently confirmed for claim 2, and `gemini.ts`'s own `combineSignals()` helper does the
identical thing for its bespoke adapter. This pass does not re-walk the full 9-hop JobManager→SDK trace a third
time (VERIFY did it once, the first-pass critique re-confirmed the mechanism pieces it touches independently) —
nothing in A-F adds a new async hop outside the existing `completeWithFallback`/`streamWithFallback` call, so
there is nothing new for this claim's chain to re-verify.

**Claim 4 (cooldown engages) — CONFIRMED, `model-cooldown.ts` read in full again this pass** (quoted complete in
§2.3 below). `markRateLimited` is called only from `complete-with-fallback.ts`'s catch block, which is only
reached after `provider.complete()` settles — and per claim 1, that now happens on the actual first HTTP response,
not after a hidden multi-minute SDK-internal sleep. `isCoolingDown` gates chain resolution before any attempt.
No gap in engagement. The real gap (period-exhausted vs. transient indistinguishability, the coaching-chat
mislabel) is a gap in what the cooldown can *express* and where its state's *message* surfaces — exactly items A
and E below, not a regression of claim 4. See §8 (G).

---

## 2. A — THE TAXONOMY

### 2.1 Type

```ts
// src/main/ai/types.ts — additive
/** BUG-057 Phase 2 — HOW a failure behaves over time, distinct from
 *  AIProviderErrorCode (WHAT shape it took). Drives cooldown SHAPE
 *  (model-cooldown.ts) and message copy (AllModelsExhaustedError).
 *  - 'transient': clears on its own in seconds-minutes — network blip, a
 *    per-minute rate-limit window, a provider 5xx.
 *  - 'period-exhausted': clears on a clock the account doesn't control
 *    minute-to-minute (daily/monthly free-tier cap, credits exhausted).
 *    Retrying inside the window is pure waste.
 *  - 'structural': will not succeed for this exact request shape against
 *    this exact model without a config change (BUG-057's 400/tool-schema
 *    mismatch, a delisted model, an auth failure).
 */
export type AIFailureClass = 'transient' | 'period-exhausted' | 'structural'
```

```ts
// AIProviderError — 4th optional ctor param, same precedent as retryAfterMs
export class AIProviderError extends Error {
  constructor(
    readonly code: AIProviderErrorCode,
    message: string,
    readonly retryAfterMs?: number,
    /** Undefined at most call sites (validateKey's probe, the AbortError
     *  branch in completeWithSameModelRetry). effectiveFailureClass()
     *  treats undefined as 'transient' — see failure-class.ts for why that
     *  default direction matters (fixed from the first design pass, which
     *  had this backwards — see CHANGES FROM FIRST PASS #2). */
    readonly failureClass?: AIFailureClass
  ) {
    super(message)
    this.name = 'AIProviderError'
  }
}

export function effectiveFailureClass(err: AIProviderError): AIFailureClass {
  return err.failureClass ?? 'transient'
}
```

### 2.2 One classifier, shared by all four provider adapters

Re-confirmed directly this pass (not re-quoting VERIFY): `openai-compatible.ts:217-220`'s quota/billing keyword
check sits in the generic `APIError` branch, which is only reached when the error is **not** a `RateLimitError`
(that branch is checked first, at line 194). `anthropic.ts:58-66`'s `RateLimitError` branch constructs
`AIProviderError('rate-limit', 'Anthropic is rate-limiting requests right now.')` with **no third argument** —
`retryAfterMs` is always `undefined` for Anthropic, confirmed by direct read. So a quota-exhaustion response that
arrives as HTTP 429 (the common real-world case) is indistinguishable from a 10-second throttle today, exactly as
VERIFY found. This is a real, reachable bug, not a hypothetical.

```ts
// src/main/ai/failure-class.ts (new, pure function, unit-testable without an SDK)
import type { AIFailureClass, AIProviderErrorCode } from './types'

const QUOTA_KEYWORDS = ['quota', 'billing', 'credit']

/** Same three keywords every adapter's toProviderError() already checks
 *  somewhere (openai-compatible.ts:219, anthropic.ts:70-72, openai.ts's
 *  equivalent) — no new provider behavior invented, just evaluated in the
 *  branch (RateLimitError/429) that previously skipped it entirely. */
export function looksLikeQuotaExhaustion(message: string): boolean {
  const msg = message.toLowerCase()
  return QUOTA_KEYWORDS.some((k) => msg.includes(k))
}

/** Fixed from the first design pass (CHANGES FROM FIRST PASS #2): the
 *  ambiguous-input fallback is 'transient', not 'structural'. A wrong
 *  'transient' guess self-heals within MAX_COOLDOWN_MS (10 min, unchanged
 *  existing constant). A wrong 'structural' guess, by construction (see
 *  §2.3), used to be UNRECOVERABLE — permanently excluding a model on a
 *  classification we weren't even confident about. Erring toward the
 *  cheaper mistake is the actually-conservative choice. */
export function classifyFailureClass(
  code: AIProviderErrorCode,
  opts: { message: string; status?: number }
): AIFailureClass {
  if (code === 'network' || code === 'timeout') return 'transient'
  if (code === 'auth') return 'structural' // never succeeds until the key changes
  if (code === 'model-not-found') return 'structural'
  if (code === 'rate-limit') {
    return looksLikeQuotaExhaustion(opts.message) ? 'period-exhausted' : 'transient'
  }
  // code === 'failed' — the generic bucket every adapter uses for
  // everything it doesn't special-case (5xx, malformed 400s, BUG-057's
  // tool_use_failed).
  if (looksLikeQuotaExhaustion(opts.message)) return 'period-exhausted'
  if (opts.status !== undefined) {
    if (opts.status >= 500) return 'transient'   // server-side hiccup, not our request's fault
    if (opts.status >= 400) return 'structural'  // client-side: this exact request is rejected
  }
  // No status, no quota keyword — genuinely ambiguous. See doc comment above.
  return 'transient'
}
```

Wiring (shown for `openai-compatible.ts`'s confirmed-gap branch; identical one-line change in the other three
adapters):

```ts
// providers/openai-compatible.ts — toProviderError(), RateLimitError branch (line ~194)
if (err instanceof OpenAI.RateLimitError) {
  const providerMsg = typeof err.message === 'string' ? err.message : ''
  return new AIProviderError(
    'rate-limit',
    `${displayName} is rate-limiting requests right now.`,
    retryAfterMsFrom(err),
    classifyFailureClass('rate-limit', { message: providerMsg, status: err.status })
  )
}
```

`anthropic.ts`'s `RateLimitError` branch gains `err.message` and `err.status` (both exist on `Anthropic.APIError`,
confirmed at `anthropic.ts:81` where `err.status` is already read in the sibling branch) as the classifier's
input. `gemini.ts`'s `toProviderError` already extracts `message`/`res.status` locally — pass both through
unchanged.

### 2.3 Cooldown storage — per-class SHAPE, both first-pass bugs fixed

Full current file (`model-cooldown.ts`, re-read complete this pass):

```
const cooldowns = new Map<string, number>()
markRateLimited(catalogId, retryAfterMs, now)   // sets cooldowns[catalogId]
cooldownUntil / isCoolingDown                    // read, self-expiring on read
clearCooldown(catalogId)                         // called ONLY from a successful step
                                                  //   (complete-with-fallback.ts:477, :616)
soonestExpiry(catalogIds, now)
```

The design's own comment (lines 16-20, quoted verbatim): *"Deliberately in-memory only. A rate limit is a
seconds-to-minutes condition... This is the opposite of PurposeHealth... which persists precisely because it
describes a days-long condition."*

**Fix for first-pass fatal #1**: `structurallyBroken` must not be modeled the same way `PurposeHealth` is
(open-ended, cleared only by explicit action) because — confirmed directly, `catalog-ipc.ts` imports
`model-catalog.ts` only, never `model-cooldown.ts` — no explicit-clear action exists in this codebase today, and
building one (an IPC handler + a Settings button) is out of scope for this pass. The only honest choice available
now is to make it self-expire, like every other entry in this file already does:

```ts
// model-cooldown.ts — additive
/** Structural failures (failure-class.ts): a model that 400s on THIS exact
 *  request shape will very likely 400 again immediately. Unlike a rate
 *  limit, no clock fixes it directly — so this is NOT modeled as "wait N
 *  minutes and it'll work." But per CHANGES FROM FIRST PASS #1, a truly
 *  permanent, only-manually-clearable entry is unsafe in THIS codebase
 *  today: nothing wires a clear action to it (grepped — catalog-ipc.ts
 *  never imports this module), so a wrongly-classified structural failure
 *  would silently and invisibly blacklist a model for the life of the
 *  process with zero corrective path. STRUCTURAL_BREAK_MS below is
 *  therefore a long, self-healing TTL — CHOSEN (not sourced; no provider
 *  documents "how long until we reconsider a 400"): long enough that a
 *  genuinely broken integration (wrong tool schema, delisted model) isn't
 *  retried every few minutes wasting a real attempt, short enough that a
 *  misclassification (see classifyFailureClass's honest uncertainty on the
 *  ambiguous branch) self-heals within a working day rather than needing a
 *  process restart. Also cleared early by success, same as a normal
 *  cooldown — proof beats the guess whenever we get proof. */
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
  if (until <= now) { structuralBreaks.delete(catalogId); return false }
  return true
}

export function clearCooldown(catalogId: string): void {
  cooldowns.delete(catalogId)
  structuralBreaks.delete(catalogId) // a success is proof, regardless of what class the LAST failure was
  transientStreak.delete(catalogId)  // see §3
}

export function isUsable(catalogId: string, now: number): boolean {
  return !isCoolingDown(catalogId, now) && !isStructurallyBroken(catalogId, now)
}
```

**Fix for first-pass fatal #2** is already reflected above: `classifyFailureClass`'s ambiguous default is
`'transient'`, so `markStructurallyBroken` is only ever reached via a *confident* structural signal (`auth`,
`model-not-found`, or an explicit 4xx status) — the self-expiring TTL is a second, independent safety net on top
of that, not a substitute for it.

Cooldown-length escalation for period-exhausted:

```ts
// 1h default / 24h cap — CHOSEN, not sourced: no adapter today surfaces a
// provider-stated "resets in N hours" for a quota response (confirmed —
// only retryAfterMs exists, and it's absent for Anthropic/OpenAI-direct
// entirely per VERIFY). 1h: long enough not to hammer a period cap on a
// guess; short enough that a mislabeled transient-as-period-exhausted
// doesn't idle a model for a full day. 24h: the common unit for free-tier
// daily caps across this app's provider set (Groq, Gemini, OpenRouter free
// tiers are all documented as daily-reset). See Open Question 1 for the
// plan to replace this guess with observed data.
export const PERIOD_EXHAUSTED_DEFAULT_MS = 60 * 60_000
export const PERIOD_EXHAUSTED_MAX_MS = 24 * 60 * 60_000

export function markPeriodExhausted(catalogId: string, retryAfterMs: number | undefined, now: number): void {
  const wait = Math.min(Math.max(retryAfterMs ?? PERIOD_EXHAUSTED_DEFAULT_MS, 60_000), PERIOD_EXHAUSTED_MAX_MS)
  const until = now + wait
  const existing = cooldowns.get(catalogId)
  if (existing !== undefined && existing >= until) return
  cooldowns.set(catalogId, until)
}
```

`complete-with-fallback.ts`'s catch block, updated (both chain-filter call sites — `:398` and `:561` — switch from
`!isCoolingDown(...)` to `!isUsable(...)`; both `clearCooldown` call sites at `:477`/`:616` are unchanged, since
`clearCooldown` already clears all three maps):

```ts
const failureClass = err instanceof AIProviderError ? effectiveFailureClass(err) : 'transient'
if (reason === 'rate-limit' && failureClass === 'period-exhausted') {
  markPeriodExhausted(step.catalogId, err instanceof AIProviderError ? err.retryAfterMs : undefined, Date.now())
} else if (reason === 'rate-limit') {
  markRateLimited(step.catalogId, err instanceof AIProviderError ? err.retryAfterMs : undefined, Date.now())
} else if (failureClass === 'structural' && reason !== 'auth') {
  // 'auth' already gets a coarser, PROVIDER-wide skip (deadProviders,
  // shipped) — checking the raw reason string here (not re-deriving from
  // failureClass, which would also say 'structural' for auth) avoids two
  // independent encodings of the same exclusion drifting apart. See §5 (D).
  markStructurallyBroken(step.catalogId, Date.now())
}
```

**Interaction with shipped invariants, stated explicitly:** none of this touches `ceiling`, `attemptSignal`, or
`SAME_MODEL_RETRY_LIMIT`. It only changes which catalogIds are in `chain` *before* the walk starts — the exact
seam `isCoolingDown` already occupied. `HARD_CEILING_MS` still bounds the whole walk; abort still reaches the SDK
call unchanged; `SAME_MODEL_RETRY_LIMIT` is untouched (a structural or period-exhausted failure was never
same-model-retried before this design either, since only `'network'/'timeout'` are retryable there).

---

## 3. B — PER-ERROR-TYPE TOLERANCE

Confirmed again this pass: `objection-scan-tally.ts`'s `CONSECUTIVE_FAILURE_LIMIT` is per-run/per-loop over
*calls*, not per-model — not directly reusable. `purpose-health.ts` is unwired (no `purpose-health-store.ts`
exists; `recordFailure`/`recordSuccess` have zero callers) — wiring it is scoped out (Open Question 4).

**Named scope narrowing (CHANGES FROM FIRST PASS #8):** what follows is *not* LiteLLM's `allowed_fails_policy`
(permit N failures, then deprioritize) — it's an escalating-cooldown-*duration* mechanism reusing this file's
existing exponential-backoff idiom (`completeWithSameModelRetry`'s `Math.min(200 * 2**attempt, 2_000)`) applied at
the cooldown-length level. It answers the same underlying need (a model that keeps failing gets progressively less
of our attention) via this codebase's actual primitive (a `Map<catalogId, until>`) rather than a new counter
subsystem, per house style. If a literal N-strikes counter is wanted later, that's a different, additive
mechanism — flagged, not silently substituted.

Applies only to the `transient` class — `period-exhausted` and `structural` already have their own class-specific
shape (§2.3) and don't need this:

```ts
// model-cooldown.ts — additive
const transientStreak = new Map<string, number>()

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
```

`clearCooldown` (§2.3) already resets `transientStreak` on success. Bounded by the existing `MAX_COOLDOWN_MS`
(10 min, unchanged) — this can never sideline a model longer than today's worst case for a single large
`Retry-After` already allowed. Pure-arithmetic, no SDK interaction — doesn't touch retry/ceiling/cancellation.

---

## 4. C — PRE-CALL CHECKS + catalog capability flag

Re-confirmed directly: `CatalogEntry` has no tool-calling field, and `listModels(): Promise<string[]>` returns ID
strings only — no live signal exists to build a real check from. Per the brief's "real, current signals only,"
this must be a static, hand-verified field, same convention as `knownStale`:

```ts
export interface CatalogEntry {
  // ...existing fields...
  /** Hand-verified against provider docs, same convention as knownStale —
   *  but UNLIKE knownStale (whose staleness resolveCatalog() re-checks
   *  live every 10 min, model-catalog.ts's own doc comment), there is no
   *  live signal for this (listModels() returns ID strings only). See
   *  Open Question 2 for the staleness mitigation this asymmetry requires.
   *  `false` = verified NOT to support forced tool calls, dated in the
   *  entry's own comment. Undefined = "assumed to support it, unverified"
   *  — a newly added entry without this field is never silently excluded. */
  supportsToolCalling?: false
}
```

**Fix for first-pass significant #5 (unreachable elimination guard):** the first pass filtered inside
`resolveChain` and then re-ran the same idempotent filter on the already-filtered result, which can never trigger.
The actual bug it was trying to prevent is real: a `needsTool` caller must be able to tell "no keys configured at
all" apart from "keys exist but none of the assigned models support tools" — and only the caller has both counts,
since `resolveChain` is where the filtering happens.

```ts
// complete-with-fallback.ts
export interface ResolvedChain {
  /** Every step whose provider has a configured key — unfiltered by
   *  capability. Empty here means "no keys," independent of needsTool. */
  configured: ResolvedStep[]
  /** configured, further filtered by capability when needsTool is set.
   *  Equal to `configured` when needsTool is false/omitted. */
  capable: ResolvedStep[]
}

export function resolveChain(purpose: AIPurpose, opts?: { needsTool?: boolean }): ResolvedChain {
  const configured = /* ...existing resolveChain body, unchanged... */
  const capable = opts?.needsTool
    ? configured.filter((s) => catalogEntry(s.catalogId)?.supportsToolCalling !== false)
    : configured
  return { configured, capable }
}
```

Call sites (`completeWithFallback`, `streamWithFallback`) branch on the two counts explicitly instead of relying
on a single collapsed empty-array case:

```ts
const { configured, capable } = resolveChain(purpose, { needsTool: Boolean(req.tool) })
if (configured.length === 0) {
  throw new AIProviderError('no-key', 'No AI provider is configured for this yet.')
}
if (capable.length === 0) {
  // configured.length > 0 here by construction — this branch is reachable
  // and DISTINCT from the no-key case, fixing the first pass's dead code.
  throw new AIProviderError(
    'failed',
    "Every model configured for this can't run this request (tool-calling not supported by any of them) — reassign a model in Settings.",
    undefined,
    'structural'
  )
}
const chain = capable.filter((s) => isUsable(s.catalogId, Date.now()))
```

**Kept honest over time — named as an open risk, not asserted solved (fix for first-pass significant #6):**
there is no automatic re-check. A `false` that goes stale (provider ships tool-calling support later) silently
and permanently excludes a working model, with no error and no log line — worse than a wasted attempt, which at
least surfaces in `fallback-log.ts`. Mitigation proposed, not built this pass: require a dated comment on every
`false` entry (`// verified 2026-08-13, see <provider docs link>`), and add catalog entries with this field to
whatever periodic audit process already exists for `knownStale` entries (if none exists formally, that's itself
worth raising — see Open Question 2, this is not invented as solved).

**What happens when every model is eliminated — the `capable.length === 0` branch above is symmetric with the
existing cooldown-exhausted branch's shape** (a distinct `AIProviderError`, not a silent empty success), so it
does not add a new silent-failure mode; it adds a new, correctly-labeled loud one.

---

## 5. D — ERROR-CLASS-SPECIFIC FALLBACK

**No traversal change beyond the already-shipped auth→provider-skip.** Re-confirmed: `'auth'` already skips the
remaining provider entirely (`deadProviders` mechanism) — correct, since an invalid/revoked key fails identically
on every model that provider offers. Extending that provider-wide skip to `'structural'` generally would be
over-broad: a structural 400 (BUG-057's `tool_use_failed`) is about *this exact request shape against this exact
model*, not evidence the whole provider is broken — confirmed by `openai-compatible.ts`'s own comment describing
that exact scenario. §2.3's `markStructurallyBroken` is deliberately catalogId-scoped, matching that comment's own
framing — correct granularity, no traversal change needed.

`'period-exhausted'` needs no traversal change either: the account being periodically exhausted for *this* model
says nothing about a *different* provider, and the chain already advances to the next entry the instant any step
throws, regardless of failure class.

---

## 6. E — THE HONEST TAXONOMY OF MESSAGES

**What `AllModelsExhaustedError` says today**, quoted exactly from the file re-read this pass:
```ts
super(`Every configured model for "${purpose}" failed: ${attempts.map((a) => a.reason).join('; ')}`)
```
A flat join of raw reason codes — no class distinction, no suggested action.

**Where it renders today, each re-confirmed by direct read this pass:**
- Batch purposes (`coach.ts`, `summarize.ts`, `generate-tasks.ts`, `objection-mining.ts`,
  `coaching-chat-ipc.ts`) share an identical `friendlyError()` shape: `if (err instanceof
  AllModelsExhaustedError) return 'Every configured AI model failed to <X>. Check your keys and free-tier
  limits in Settings, or try again shortly.'`
- **`deal-risk.ts:132-135`** — confirmed directly, its `friendlyError()` has **no** `AllModelsExhaustedError`
  branch at all: `if (err instanceof AIProviderError) return err.message; return 'Something went wrong while
  assessing this deal. Please try again.'` — falls to the generic string even on a fully-diagnosable exhaustion.
- **Live purposes** (`live-cue.ts:490-501`, `deal-tier1.ts:265-270`): confirmed both files special-case only
  `AllModelsExhaustedError` → `pausedReason: 'all-models-unavailable'`, rendered by `StatusNotice.tsx:11`
  (`'Live intelligence is temporarily unavailable — the model provider chain is unreachable or rate-limited.
  Resumes automatically; transcription is unaffected.'`) and `PresenceHeader.tsx:19` (`'Deal intelligence paused
  — provider chain unreachable, resumes automatically'`). Any other `AIProviderError` — including a
  `HARD_CEILING_MS` timeout or an everything-cooling-down rate-limit, both confirmed to throw plain
  `AIProviderError`, not `AllModelsExhaustedError` — falls through to `{ ok: false }` with no `pausedReason`: the
  rep sees literal silence, indistinguishable from "nothing to say this cycle."
- `coaching-chat`'s `streamWithFallback`: when every chain entry is cooling down but keys are configured, it hits
  the same `chain.length === 0` branch used for genuinely no keys, throwing `AIProviderError('no-key', 'No AI
  provider is configured for this yet.')` — actively mislabeling a user with valid keys as unconfigured.

### 6.1 Fix 1 — the live paths, corrected for first-pass significant #7

The first pass routed both a `HARD_CEILING_MS` timeout and an everything-cooling-down rate-limit to the same
`pausedReason: 'all-models-unavailable'`, reusing `StatusNotice.tsx`'s "unreachable or rate-limited" copy for a
timeout case that is neither — a slow-but-live provider is not the same failure as an unreachable one, and the
existing batch-path timeout message (`` `This took too long and was stopped after ${s}s...` ``) already says the
right thing for exactly this case. Fixed by giving the live paths a second, distinct `pausedReason`:

```ts
// live-cue.ts / deal-tier1.ts / deal-tier2 analyze — catch block, LiveCueResult's
// pausedReason type widened to 'all-models-unavailable' | 'timed-out'
} catch (err) {
  if (err instanceof AllModelsExhaustedError) { /* existing branch, unchanged */ }
  if (err instanceof AIProviderError) {
    if (err.code === 'timeout') {
      // BUG-057 Phase 2 — HARD_CEILING_MS firing: a live, responding
      // provider that was just too slow. Distinct from "unreachable or
      // rate-limited" (StatusNotice.tsx's existing copy) which is
      // genuinely inaccurate for this case — see CHANGES FROM FIRST PASS #7.
      console.log(`[live-cue] paused: ceiling timeout, code=${err.code} message=${err.message}`)
      return { ok: false, pausedReason: 'timed-out' }
    }
    if (err.code === 'rate-limit') {
      // Every model set up for this purpose is cooling down. Previously
      // fell through to the generic branch below with NO pausedReason at
      // all — the rep saw silence indistinguishable from "nothing to say
      // this cycle."
      console.log(`[live-cue] paused: cooling down, code=${err.code} message=${err.message}`)
      return { ok: false, pausedReason: 'all-models-unavailable' }
    }
  }
  const providerErr = err instanceof AIProviderError ? err : null
  console.log(`[live-cue] brain error: code=${providerErr?.code ?? 'unknown'} message=${providerErr?.message ?? String(err)}`)
  return { ok: false }
}
```

`StatusNotice.tsx`/`PresenceHeader.tsx` need one added branch each for `pausedReason === 'timed-out'`, copy
matching the batch path's tone: *"Live intelligence paused — the model is taking too long to respond right now.
Resumes automatically."* This is the one place in this design that touches renderer copy, scoped narrowly to
mirror an existing, already-correct message rather than inventing new tone.

### 6.2 Fix 2 — coaching-chat's cooling-down mislabel

```ts
// complete-with-fallback.ts — streamWithFallback(), using the §4 resolveChain shape
const { configured, capable } = resolveChain(purpose, { needsTool: Boolean(req.tool) })
async function* generator() {
  if (configured.length === 0) {
    const err = new AIProviderError('no-key', 'No AI provider is configured for this yet.')
    rejectFinal(err); throw err
  }
  const chain = capable.filter((s) => isUsable(s.catalogId, Date.now()))
  if (chain.length === 0) {
    // BUG-057 Phase 2 — configured (or capable) is non-empty: real keys
    // exist, but every entry is cooling down or structurally broken. This
    // used to fall into the SAME branch as genuinely-no-keys, telling a
    // user with valid keys "nothing is configured" — see CHANGES FROM
    // FIRST PASS, and the founder's original wait/add-key/bug ask.
    const until = soonestExpiry(capable.map((s) => s.catalogId), Date.now())
    const secs = until ? Math.max(1, Math.ceil((until - Date.now()) / 1000)) : 60
    const err = new AIProviderError(
      'rate-limit',
      `Every model set up for this is rate-limited right now. Try again in about ${secs}s.`,
      until ? until - Date.now() : undefined
    )
    rejectFinal(err); throw err
  }
  // ...existing loop unchanged...
}
```

### 6.3 Fix 3 — a real 3-way message classifier for `AllModelsExhaustedError`

```ts
// complete-with-fallback.ts
export class AllModelsExhaustedError extends Error {
  constructor(
    readonly purpose: AIPurpose,
    readonly attempts: { catalogId: string; reason: string; failureClass?: AIFailureClass }[]
  ) {
    super(summarizeExhaustion(attempts).message)
    this.name = 'AllModelsExhaustedError'
  }
}

/** Founder's explicit ask: exactly one of three actions, always. 'auth' is
 *  checked via the raw reason string first (lossless — the code already
 *  distinguishes it) rather than folded into 'structural', so an
 *  all-revoked-keys chain reads as "add/fix a key," not "report a bug." */
export function summarizeExhaustion(
  attempts: { reason: string; failureClass?: AIFailureClass }[]
): { kind: 'wait' | 'add-key' | 'bug'; message: string } {
  if (attempts.every((a) => a.reason.startsWith('auth'))) {
    return { kind: 'add-key', message: 'Every configured key was rejected — check your API keys in Settings.' }
  }
  const classes = attempts.map((a) => a.failureClass ?? 'transient')
  if (classes.every((c) => c === 'structural')) {
    return {
      kind: 'bug',
      message: 'Every configured model rejected this request the same way — this looks like a bug, not a rate limit or a full key. Please report it.'
    }
  }
  if (classes.some((c) => c === 'period-exhausted') && classes.every((c) => c !== 'transient')) {
    return {
      kind: 'add-key',
      message: "Every model set up for this has hit its free-tier limit for now. Add another provider's key in Settings, or wait for it to reset."
    }
  }
  return {
    kind: 'wait',
    message: 'Every configured model failed to respond just now — this is usually temporary. Try again shortly, or add another provider key in Settings for backup.'
  }
}
```

Every attempt pushed to `attempts` (both `completeWithFallback` and `streamWithFallback`) gains one field:
`failureClass: err instanceof AIProviderError ? effectiveFailureClass(err) : 'transient'`.

All 5 batch `friendlyError()` helpers change identically (shown once):
```ts
function friendlyError(err: unknown): string {
  if (err instanceof AllModelsExhaustedError) return err.message // now classified via summarizeExhaustion
  if (err instanceof AIProviderError) return err.message
  return 'Something went wrong. Please try again.'
}
```

`deal-risk.ts` gains the missing branch (confirmed absent above):
```ts
function friendlyError(err: unknown): string {
  if (err instanceof AllModelsExhaustedError) return err.message
  if (err instanceof AIProviderError) return err.message
  return 'Something went wrong while assessing this deal. Please try again.'
}
```

**Interaction with shipped invariants:** message-only. `attempts` already existed; only a `failureClass` field is
added per pushed entry. No control-flow, retry, ceiling, or cancellation change.

---

## 7. F — STARVATION (fully re-derived, replacing the disproven first-pass Option 1)

### 7.1 The real overlap, computed fresh against current chain data

`coaching-cue`'s chain is `SPEED_CHAIN.slice(0, coachingCap)`, `coachingCap = CHAIN_BUDGET['coaching-cue']
?.maxChainLength ?? 2` (`complete-with-fallback.ts:69`). `SPEED_CHAIN` (`:42-49`, confirmed in full this pass) is:
```
['groq-llama-3.1-8b-instant', 'groq-llama-3.3-70b-versatile', 'groq-gpt-oss-120b',
 'cerebras-gpt-oss-120b', 'groq-llama-4-scout', 'groq-qwen3-32b']
```
So coaching-cue only ever reaches the **first two**: `groq-llama-3.1-8b-instant`, `groq-llama-3.3-70b-versatile`.
`deal-tier1` is identical (`dealTier1Cap` also defaults to 2).

`summary`'s chain is the full `QUALITY_CHAIN` (`:57-67`, confirmed in full):
```
['google-gemini-flash', 'nvidia-deepseek-v3.2', 'openrouter-nemotron-3-ultra', 'nvidia-glm-5.2',
 'mistral-small', 'openrouter-auto-free', 'groq-llama-3.3-70b-versatile', 'groq-gpt-oss-120b',
 'cerebras-gpt-oss-120b']
```
For a Groq-only user (THE BAR's target case), every non-Groq entry drops out at the key-presence filter, leaving
`[groq-llama-3.3-70b-versatile, groq-gpt-oss-120b]`. Overlap with coaching-cue's reachable set: **exactly one**
catalogId, `groq-llama-3.3-70b-versatile` — not the first pass's claimed 3 (that count came from the raw
`SPEED_CHAIN ∩ QUALITY_CHAIN` intersection, which over-counts because it ignores `coachingCap`).

**But `memory-extract`'s chain (`complete-with-fallback.ts:111`, confirmed exact) is
`[...new Set([...SPEED_CHAIN, ...QUALITY_CHAIN])]` — the entire `SPEED_CHAIN`, uncapped.** It collides with
coaching-cue on **both** reachable entries, not one. Concrete trace: coaching-cue fires every 2.5s
(`useLiveCues.ts`, `CALL_GAP_MS = 2_500`, per VERIFY, not re-walked this pass but internally consistent with the
file's own comment at `model-cooldown.ts:6`), cools `groq-llama-3.1-8b-instant`, escalates to
`groq-llama-3.3-70b-versatile`, cools that too under sustained live traffic. A post-call `memory-extract` job
firing minutes later has *zero* of its two fastest options available — it falls through to `QUALITY_CHAIN`'s
non-Groq entries, which is the intended safety net working as designed for a multi-key user, but for a Groq-only
user those entries are all unconfigured and `memory-extract` gets nothing until the cooldown clears. This is the
sharper, previously-uncounted instance of the founder's concern.

### 7.2 Why the first pass's "ship now" Option 1 is dropped, not merely revised

- **"Reorder" the shared entries within the chains**: `model-cooldown.ts`'s `cooldowns` Map is keyed purely by
  `catalogId` — confirmed, re-read the whole file — with no order/position dimension in `markRateLimited`,
  `isCoolingDown`, or `soonestExpiry`. Two lists containing the same ID collide on cooldown state regardless of
  where that ID sits in either list. Reordering cannot change this; it is a true no-op against the actual
  mechanism, not a partial mitigation.
- **"Drop" the shared entries from one chain**: `complete-with-fallback.ts:49-53`'s own comment (re-read, quoted
  in §7.1) states these exact entries are what makes "paste only a Groq key and every job still works end-to-end"
  true. Dropping them from `QUALITY_CHAIN` collapses `resolved`/`configured` to empty for a Groq-only user on
  every non-speed purpose — reproducing the exact silent-failure class this project's own BUG-039 was written to
  fix, for precisely the free-tier user THE BAR names as the point of the whole app. This is not a safe stopgap;
  it's a regression with a different name.

Neither variant of Option 1 survives contact with the actual mechanism or the actual chain-design comment. It is
removed from this design, not kept as a "cheap first step."

### 7.3 The corrected mechanism (was "Option 2" — first pass's sketch had two real bugs, both fixed here)

Tag each cooldown/structural-break entry with which frequency tier caused it, using a signal that already exists
(`purpose in CHAIN_BUDGET` — confirmed `CHAIN_BUDGET` is exactly `{'coaching-cue', 'deal-tier1'}`, re-read
`types.ts` directly). A `'durable'`-tier caller may bypass a cooldown *only* if it was caused by a `'live'`-tier
caller — never its own tier's cooldown, which would defeat BUG-058 entirely.

```ts
// model-cooldown.ts — full corrected shape (first-pass bugs fixed inline, noted)
export type CooldownTier = 'live' | 'durable'

interface CooldownEntry { until: number; causedBy: CooldownTier }
const cooldowns = new Map<string, CooldownEntry>() // was Map<string, number> — shape change, see below

export function markRateLimited(
  catalogId: string,
  retryAfterMs: number | undefined,
  now: number,
  causedBy: CooldownTier // FIX (critique #2, bug 1): write side now actually sets this
): void {
  const streak = (transientStreak.get(catalogId) ?? 0) + 1
  transientStreak.set(catalogId, streak)
  const guessed = Math.min(DEFAULT_COOLDOWN_MS * 2 ** (streak - 1), MAX_COOLDOWN_MS)
  const wait = Math.min(Math.max(retryAfterMs ?? guessed, 1_000), MAX_COOLDOWN_MS)
  const until = now + wait
  const existing = cooldowns.get(catalogId)
  if (existing !== undefined && existing.until >= until) return
  // A 'live' caller's re-mark of an already-'durable'-caused cooldown keeps
  // 'durable' causation (the more restrictive tag) rather than overwriting
  // it — a durable purpose's failure is stronger evidence of a real,
  // account-wide limit than a live purpose's, since durable purposes fire
  // far less often and are less likely to be the cause of a self-inflicted
  // burst.
  const nextCausedBy = existing?.causedBy === 'durable' ? 'durable' : causedBy
  cooldowns.set(catalogId, { until, causedBy: nextCausedBy })
}

export function isUsableFor(catalogId: string, now: number, callerTier: CooldownTier): boolean {
  // FIX (critique #2, bug 2): structural-break check no longer skipped on
  // the bypass path — a model that's both transiently cooling AND
  // independently structurally broken must never be bypassed into, since
  // the structural break is deterministic regardless of tier.
  if (isStructurallyBroken(catalogId, now)) return false
  const entry = cooldowns.get(catalogId)
  if (entry === undefined) return true
  if (entry.until <= now) { cooldowns.delete(catalogId); return true }
  return callerTier === 'durable' && entry.causedBy === 'live'
}
```

Call sites: `complete-with-fallback.ts`'s two chain filters become
`chain.filter((s) => isUsableFor(s.catalogId, now, purpose in CHAIN_BUDGET ? 'live' : 'durable'))`. The catch
block's `markRateLimited`/`markPeriodExhausted` calls gain the same tier argument, computed identically.

`soonestExpiry` — first-pass critique's minor point, addressed: when reporting a wait estimate to a `'durable'`
caller, only cooldowns it cannot bypass should count, or the reported wait overstates the real block:
```ts
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
```

**Tradeoff, stated plainly:** a `'durable'` bypass spends one real HTTP round trip against a model that might
still be limited — bounded risk, since a failed bypass just falls through to the next chain entry like any other
failure (never worse than today). In exchange, `memory-extract`/`summary`/`scorecard` stop being starved by
`coaching-cue`'s own cooldowns specifically (not by a genuine account-wide limit, which both tiers still correctly
respect via the `'durable'`-caused branch never bypassing `'durable'`-caused entries). Adds one dimension
(`causedBy`) to a module whose whole design principle was "simple, in-memory, `catalogId → until`" — a real cost,
worth naming, not hidden.

**Given the corrected mechanism is now fully specified and its two prior bugs are fixed, and given §7.1 shows the
actual affected surface is narrow and named (2 catalogIds, `memory-extract` as the sharpest case) rather than
hypothetical, this is now the recommended F implementation — not deferred pending telemetry, since the first
pass's cheaper alternative doesn't exist as a viable option (see §7.2).** If `fallback-log.ts`'s existing
`{purpose, fromCatalogId, toCatalogId, reason}` JSONL later shows this pattern is rarer in practice than the
static chain analysis suggests, the tier tag can be removed as a follow-up — but there's no cheaper interim step
to ship first, so there's nothing to gain by waiting.

---

## 8. G — EXPLICIT NON-GOALS

- **Claim 1 (retries)** — no further design work. Re-confirmed via direct 9-site grep and `completeWithSameModelRetry`
  read this pass; untouched by A-F.
- **Claim 2 (ceiling)** — no further design work on the *ceiling mechanism itself*. Named explicitly (fix for
  first-pass minor #9): §6.1's live-path fix does add new branching keyed on `err.code === 'timeout'`, which is
  ceiling-*adjacent* — it changes what happens to a `pausedReason` after a ceiling timeout, not the ceiling's
  timing, construction, or abort-signal composition, all of which are unchanged and re-confirmed in §1.
- **Claim 3 (cancellation)** — no further design work. `JobManager.ts:150`'s inverted default re-confirmed. A-F
  add no new async work outside the existing `completeWithFallback`/`streamWithFallback` call, so no new
  signal-threading is needed anywhere.
- **Claim 4 (cooldown engagement)** — no further design work on *engagement*. The one place VERIFY found cooldown
  state feeding a wrong message (coaching-chat's `'no-key'` mislabel, §6.2) was a bug in which *exception type*
  gets thrown after a correctly-populated cooldown check — not a bug in the check itself. The underlying `Map`
  (now `Map<string, CooldownEntry>` per §7.3) was accurate the whole time; only its consumer's branching was wrong.

---

## PHASED PLAN

1. **E, live-path fixes** (§6.1, §6.2, `deal-risk.ts`'s missing branch) — pure catch-block/renderer-copy additions,
   zero new persistent state, highest user-visible impact (kills the silent live-cue freeze and the
   coaching-chat mislabel) for the lowest risk. Ship first, ahead of new taxonomy work, per the brief's
   VERIFY-gap-first instruction.
2. **A, taxonomy** (§2) — `AIFailureClass`, `classifyFailureClass`, 4-provider wiring, `markPeriodExhausted`/
   `markStructurallyBroken` with its corrected self-expiring TTL. Foundational for B, E's Fix 3, and F.
3. **E, message classifier** (§6.3) — depends on Phase 2's `failureClass` field on `attempts`.
4. **B, escalating transient backoff** (§3) — isolated to `model-cooldown.ts`.
5. **F, tiered cooldown** (§7.3) — depends on Phase 2's cooldown-shape refactor (`CooldownEntry` object replaces
   the bare `number`); do this once, not twice.
6. **C, pre-call capability check** (§4) — needs a manual hand-verification pass over the catalog; slowest, most
   manual-labor phase, ships last among code changes.

D requires no code — its "no traversal change" conclusion is reasoning folded into Phases 2-3.

---

## VERIFICATION

- **Phase 1:** new test per live file (`live-cue.ts`/`deal-tier1.ts`/`deal-tier2`) mocking `completeWithFallback`
  to throw `AIProviderError('timeout', ...)` and `AIProviderError('rate-limit', ...)` directly (testing our own
  catch-block routing, not SDK behavior — a provider mock is legitimate here since no SDK claim is under test) →
  assert `pausedReason === 'timed-out'` and `'all-models-unavailable'` respectively, as two DISTINCT values.
  **Fails on revert**: today both fall through to `{ ok: false }` with no `pausedReason` at all — confirmed by
  direct read this pass. For coaching-chat: extend `realSdkRetryAndCooldown.test.ts`'s real-SDK-plus-fetch-mock
  harness, drive every chain entry to a real 429 so all cool down, assert the rejected error's `code ===
  'rate-limit'`, not `'no-key'`. **Red against current code today** — this is the red-check for an
  already-identified live bug, not a hypothetical.
- **Phase 2:** pure-function tests in `__tests__/failureClass.test.ts` (no SDK — `classifyFailureClass`/
  `looksLikeQuotaExhaustion` are deterministic), including an explicit test that an unrecognized/ambiguous input
  classifies as `'transient'`, not `'structural'` (this is the exact case the first-pass critique found broken).
  Provider-level, extending the real-SDK pattern: a 429 body containing `"exceeded your current quota...
  billing"` → assert `failureClass === 'period-exhausted'`, not just `code === 'rate-limit'`. **Fails on revert**
  (the fix that checks quota text inside the `RateLimitError` branch, not just the generic branch, confirmed
  unreachable there today). A parallel real-SDK 5xx case asserting `failureClass === 'transient'` despite `code
  === 'failed'` — **fails on revert** to the current status-blind mapping. A `markStructurallyBroken` unit test:
  mark now, advance fake time past `STRUCTURAL_BREAK_MS`, assert `isStructurallyBroken` returns `false` —
  **fails on revert** to the first pass's permanent-map shape (there advancing time would do nothing).
- **Phase 3:** unit tests on `summarizeExhaustion` with synthetic `attempts` per class combination, asserting
  exact `kind`. Integration: real-SDK harness where every mocked attempt 400s with a schema-shaped message →
  assert `AllModelsExhaustedError.message` contains "bug," not the old flat reason-join. **Fails on revert.**
- **Phase 4:** pure unit test — 3× `markRateLimited(id, undefined, now, 'durable')` with increasing `now`, assert
  wait grows 60s→120s→240s capped at `MAX_COOLDOWN_MS`, and `clearCooldown` resets the streak. Deterministic, no
  SDK needed.
- **Phase 5:** unit tests on `isUsableFor`/`markRateLimited` with the `causedBy` tag: a `'live'`-caused cooldown
  is bypassable by a `'durable'` caller but not another `'live'` caller; a `'durable'`-caused cooldown is
  bypassable by neither. **The critique's bug 2 gets its own explicit test**: mark a catalogId both
  `markRateLimited(..., 'live')` AND `markStructurallyBroken(...)`, assert `isUsableFor(id, now, 'durable')` is
  `false` — **fails on the first pass's sketch**, which skipped the structural check on the bypass path entirely.
- **Phase 6:** `resolveChain(purpose, { needsTool: true })` unit test with a fixture entry
  `supportsToolCalling: false` → assert it's absent from `capable` but present in `configured`; a
  second test with every entry incapable asserts the thrown error is the capability-specific message, DISTINCT
  from the `configured.length === 0` no-key message. **Fails on the first pass's version** (its guard could never
  fire, so an all-incapable chain fell through to the generic no-key path with the wrong message — or, if
  filtered internally as first drafted, `resolved` collapsed to empty and the no-key message fired instead).

---

## OPEN QUESTIONS

1. **`PERIOD_EXHAUSTED_DEFAULT_MS`/`MAX_MS` (1h/24h) and `STRUCTURAL_BREAK_MS` (4h)** — all three are chosen
   without per-provider ground truth on real reset windows or real structural-failure recurrence rates.
   *Recommendation:* ship as designed (all three self-heal, so a wrong guess is bounded, not catastrophic — this
   is the exact property the first pass's `structuralBreaks` design lacked before this pass's fix); instrument via
   `fallback-log.ts`'s existing raw `detail` text, and revisit the constants once real quota/structural payloads
   accumulate rather than guessing twice.
2. **`supportsToolCalling`'s staleness has no automatic re-check, unlike `knownStale`** — this pass names the
   asymmetry explicitly (§4) rather than treating it as solved. *Recommendation:* before Phase 6 ships, confirm
   whether a periodic catalog-audit process actually exists for `knownStale` today; if it does, add this field to
   it; if it doesn't, that's a pre-existing gap this design inherits rather than introduces, and is out of this
   pass's scope to fix on its own.
3. **F's tiered cooldown adds real state (`causedBy`) for a currently-narrow surface (2 catalogIds today,
   `memory-extract` as the sharpest instance)** — worth a final gut-check against `fallback-log.ts` production
   data once Phase 1-2 are live and generating real telemetry, specifically: does `memory-extract` actually starve
   in practice as often as the static chain analysis in §7.1 predicts, or does the `QUALITY_CHAIN` fallback tail
   absorb it acceptably for most real (non-Groq-only) users? This pass proceeds on the static analysis since it's
   the only evidence available before shipping, but real usage should be checked once it exists.
4. **`purpose-health.ts` remains unwired dead code** — its shape (`consecutiveFailures`, `severityOf`,
   `messageFor` branching per code) overlaps meaningfully with B/E, and would get more accurate for free once
   `AIFailureClass` exists upstream. *Recommendation:* still not in this pass — it needs a missing
   `purpose-health-store.ts` persistence/IPC layer plus a UI surface, genuinely beyond A-G's scope. Flagged as the
   natural next milestone once A-F ship, not silently dropped.

**Residual risk not resolvable by design alone, requiring verification against the running app:** the escalating
transient backoff (§3) and the tiered cooldown (§7.3) are both pure-arithmetic and unit-testable in isolation, but
their *interaction* under real concurrent live-call load (multiple coaching-cue calls firing across different
active calls simultaneously, each independently marking the same shared catalogId) has not been exercised against
real timing — the existing tests are single-threaded-in-effect (fake timers, sequential awaits). A load-style test
firing concurrent `completeWithFallback` calls against a shared fake-cooling catalogId, asserting no double-counted
streak or lost `causedBy` tag under interleaving, is worth adding before Phase 5 ships, and is not covered by
anything specified above.

**Files touched:** `src/main/ai/types.ts`, `src/main/ai/failure-class.ts` (new), `src/main/ai/model-cooldown.ts`,
`src/main/ai/complete-with-fallback.ts`, `src/main/ai/providers/{anthropic,openai,openai-compatible,gemini}.ts`,
`src/main/ai/model-catalog.ts`, `src/main/{live-cue,deal-tier1,deal-tier2,coach,summarize,generate-tasks,
objection-mining,deal-risk,coaching-chat-ipc}.ts`, `src/renderer/src/features/deal-intelligence/ui/
{StatusNotice,PresenceHeader}.tsx`.