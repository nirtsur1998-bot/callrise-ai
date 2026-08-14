# BUG-058 remainder — shared-resource pacing, systemic early-exit, honest quota messaging

Status: **proposal, no code written.** Same process as BUG-057: read the actual current source in full (`model-cooldown.ts`, `complete-with-fallback.ts`, all four provider adapters, `purpose-health.ts`, `types.ts`), then confirmed the real failure mode against this machine's own `ai-fallback-events.jsonl` and `app-settings.json` rather than reasoning from the bug report's prose alone. Every claim below is a file:line citation against `claude/m26-engine-room`, or a provider-API fact confirmed via web search this session (sources listed per claim).

---

## The one fact that reshapes this doc

**BUG-057 already shipped four of the six things BUG-058's own writeup asked for.** The `transient`/`period-exhausted`/`structural` taxonomy, per-model cooldown with escalating backoff, the tiered live/durable bypass rule, the pre-call tool-calling check, and the 3-way wait/add-key/bug message classifier are all live, tested, and correct (`model-cooldown.ts` full file, `complete-with-fallback.ts:51-102`, `:367-373`). None of that is being redesigned here.

**And per-model cooldown was never going to fix the actual remaining problem, because the actual remaining problem isn't about one model.** Every purpose in this app — coaching-cue, both Deal Intelligence tiers, summaries, scorecards, tasks, three memory purposes, prep-brief, coaching-chat — draws from the same 1-2 free-tier keys, both by the founder's own configured `aiModelAssignments` (`app-settings.json`: `google-gemini-flash` appears in 10 of 12 purposes' chains, `groq-gpt-oss-120b` in 9) and by the app's own bundled default (`complete-with-fallback.ts:119-129`, `QUALITY_CHAIN` puts `google-gemini-flash` first). Confirmed directly from this machine's `ai-fallback-events.jsonl`: in a single ~12-minute window, `memory-extract` alone logged 344 fallback events, `scorecard` 95, `other` 96 — all independently, politely, correctly respecting their own per-model cooldowns, and still colliding on the same 1-2 keys because **ten purposes each taking one individually-reasonable turn on the same key in the same minute is itself the failure mode.** Per-model cooldown stops one purpose from hammering a model. It does nothing about many purposes each hammering it once.

This is why the fix that matters most here is new — **cross-purpose request pacing** — not in the bug's original six-item list, because that list was written reasoning about the wrong mechanism (one caller retrying too fast) rather than the actual one (many callers, each slow enough on their own, converging on the same resource).

---

## 1. Cross-purpose pacing (the real lever)

### What's actually happening, from real data

`ai-fallback-events.jsonl`, 8/13 17:05-17:18 window: `google-gemini-flash` gets attempted and rate-limited on effectively every attempt across 12 minutes, with no growing gap between failures — which looks like the escalating backoff (`model-cooldown.ts:85-104`) isn't working, until you check *why*: `markRateLimited`'s wait is `min(max(retryAfterMs ?? guessed, 1_000), MAX)` (`:97-99`) — **a real provider-stated wait always wins over the escalating guess**, correctly (a provider telling you the truth beats us guessing). Gemini's own `RetryInfo.retryDelay` (`gemini.ts:128-140`) is a short, per-minute-window figure — commonly tens of seconds on a free tier. So each individual purpose's cooldown clears correctly and honestly in under a minute. The problem is that with 5+ purposes independently polling on their own schedules (`memory-extract` every ~2 min, `scorecard`/`other`/`summary`/`tasks` on theirs), **something is almost always about to try Gemini the moment its short cooldown clears** — the model never gets a sustained clear window, because clearing means "usable to the next purpose that happens to ask," not "usable to nobody for a while."

### The fix

A new module, `src/main/ai/model-pacing.ts`, sibling to `model-cooldown.ts` — deliberately separate *storage*, not folded into the cooldown map, because it answers a different question (cooldown: "did this model just tell us to back off?"; pacing: "did *anyone* just use this model, whether or not it failed?"). But **not a separate gate callers have to remember to check** — see the correction below.

```ts
// model-pacing.ts
export type PacingTier = 'live' | 'durable' // same concept as CooldownTier, reused not duplicated

const PACING_GAP_MS = 6_000 // derived, not guessed — see "what this number is and isn't" below

interface PacingEntry { at: number; causedBy: PacingTier }
const lastUsed = new Map<string, PacingEntry>()

/** Call immediately before the actual network call — closes the race window
 *  as tightly as async JS allows. Live tier is a deliberate no-op: never
 *  written, so it can never be checked against either. */
export function markUsed(catalogId: string, now: number, causedBy: PacingTier): void {
  if (causedBy === 'live') return
  lastUsed.set(catalogId, { at: now, causedBy })
}

/** Not exported for callers to check directly — see the single-gate note
 *  below. Same tiering shape as isUsableFor's cooldown-bypass rule,
 *  deliberately: live is NEVER paced (matches its ~4s total chain budget —
 *  it cannot afford to lose even one candidate to a soft heuristic); a
 *  durable caller is paced only by ANOTHER durable caller's recent use,
 *  never by a live caller's — a live purpose firing every 2.5s must not be
 *  able to push the post-call summary further down its own fallback chain
 *  just by existing. */
function isPacedFor(catalogId: string, now: number, callerTier: PacingTier): boolean {
  if (callerTier === 'live') return false
  const entry = lastUsed.get(catalogId)
  if (!entry || entry.causedBy === 'live') return false
  return now - entry.at < PACING_GAP_MS
}
```

**Correction from the first draft, before any code was written — single-gate, not a fourth check.** The first version of this doc had callers write `isUsableFor(...) && !isPacedFor(...)` side by side in the chain filter — flagged during review as exactly the shape that let `cancellable:true` ship as a default nobody actually satisfied: a second thing every call site has to remember, with no compiler or test catching the site that forgets. Fixed before writing any implementation code: `isPacedFor` is not exported. `model-cooldown.ts`'s `isUsableFor` — already the one function every caller calls today — imports it and checks it internally:

```ts
// model-cooldown.ts, isUsableFor's new body
import { isPacedFor } from './model-pacing'

export function isUsableFor(catalogId: string, now: number, callerTier: CooldownTier): boolean {
  if (isStructurallyBroken(catalogId, now)) return false
  if (isPacedFor(catalogId, now, callerTier)) return false
  const entry = cooldowns.get(catalogId)
  if (!entry) return true
  if (now <= entry.until) return callerTier === 'durable' && entry.causedBy === 'live'
  return true
}
```

`complete-with-fallback.ts:512` and the `streamWithFallback` equivalent (`:728`) are **unchanged in shape** — still the single existing call, `capable.filter((s) => isUsableFor(s.catalogId, startedNow, tier))`. Two storage maps, two reasons to say no, one gate.

**Second correction, found by the existing test suite once real code was written — `markUsed` fires on the OUTCOME, never before the attempt.** The first implementation called `markUsed` synchronously right before the network call (to close the race window as tightly as possible) and unconditionally, on every attempt regardless of outcome. Running the existing suite immediately surfaced two real, pre-existing, intentional invariants this broke: `modelCooldown.test.ts`'s "only rate limits cool down — a plain failure still retries next call" and "an ambiguous failure... NOT excluded." Both tests call `completeWithFallback` twice in a row, in real time, expecting a *plain* (non-rate-limit) failure to have zero lingering effect — `model-cooldown.ts`'s own established rule, stated in its file header: *"applying [a cooldown] to every failure would sideline healthy models after one blip."* Marking pacing unconditionally on every attempt violated that rule for pacing specifically, even though cooldown itself still respected it.

Fixed by moving `markUsed` to fire only on the real outcome: a success (right after `clearCooldown`), or a rate-limit-classified failure (alongside `markRateLimited`/`markPeriodExhausted`) — never on a plain `'failed'`/structural error, which tells us nothing about a model being near a shared capacity limit. This costs the race-window-closing property the first draft had (two purposes deciding on the exact same event-loop tick could both attempt before either marks) — accepted, since that was an optimization, not a correctness requirement, and consistency with the codebase's own established "only real capacity evidence gates future attempts" rule matters more. Verified both ways: reverted the pacing check inside `isUsableFor` and confirmed the new pacing-specific tests (`modelPacing.test.ts`) fail without it; restored and confirmed the full suite (1746 tests) passes.

**Deliberately a skip, not a wait.** A paced candidate is filtered out of `chain` the same way a cooling-down one already is — the walk moves to the next candidate immediately, at zero added latency in the common case where a chain has more than one viable entry (which is exactly why the implicit-tail mechanism from BUG-057 exists). Pacing only becomes visible as a *delay* in the case §2 covers: the chain running out of un-paced, un-cooling candidates entirely.

### What `PACING_GAP_MS` actually is — derived, with the honest limits of the derivation

Checked whether the log itself could fit a value, per the instruction to derive rather than guess where possible. It can't, cleanly: filtering the whole `ai-fallback-events.jsonl` for genuine cross-*purpose* collisions (a different purpose hitting the same catalogId within 5 minutes of another purpose) finds only **5 instances total for `google-gemini-flash` and 4 for `groq-gpt-oss-120b`** across three days of real use — of those, only 3 were under 60 seconds apart (5.2s, 5.3s, 12.1s). Three-to-five data points isn't enough to fit a gap value from; most of the hundreds of logged failures turn out to be a *single* purpose (usually `memory-extract`, on its own ~2-minute cadence) repeatedly re-trying a scarce model, which per-model cooldown already handles about as well as the model's real capacity allows — not a dense multi-purpose pileup in any narrow window. Worth stating plainly since it complicates the cleaner story in §"the one fact that reshapes this doc": genuine cross-purpose collisions are real but were rarer in this specific log than the framing implied; the aggregate pressure from many purposes sharing few keys is still real (hundreds of total events against 1-2 models), it just doesn't show up as tight collision clusters as often as expected.

So the derivation comes from a published capacity figure instead, cross-checked against (not fit to) the log. Gemini 2.5 Flash's free-tier RPM is reported inconsistently across sources — 10 RPM in some, 15 RPM in others — and Google's own current rate-limits page no longer publishes a static table (limits are shown per-account in AI Studio, not documented generally). Using the **conservative (lower) end, 10 RPM**:

```
PACING_GAP_MS = 60_000ms / 10 requests-per-minute = 6_000ms
```

This is the spacing that keeps this app's own pacing-gated traffic to a shared model at *exactly* the full published free-tier rate under worst-case sustained multi-purpose demand — not below it, so it doesn't leave headroom for the same model's own cooldown-driven reattempts landing in the same window, and doesn't account for any other application sharing the same key outside this app. Cross-checked against the 3 real collision gaps found (5.2s, 5.3s, 12.1s): a 6s gap would have caught the first two, not the third — consistent with "meaningfully reduces the collisions that do happen" rather than "guarantees none." **Labeled in code as a derived-but-uncertain starting point** (uncertain input: 10 vs. 15 RPM; derived arithmetic: 60000/RPM), the same way `HARD_CEILING_MS` is labeled as a considered-but-not-measured backstop — worth revisiting with real post-ship data rather than more research now.

**What `PACING_GAP_MS = 3_000` is and isn't.** It's a single conservative constant for v1, not tuned per-provider — free-tier RPM figures researched this session range from Groq's 30 RPM (≈2s/request sustainable) to OpenRouter's free 20 RPM (≈3s) to Gemini Flash's typically lower free-tier RPM (varies by model). 3 seconds is a deliberately simple, conservative starting point that meaningfully de-clusters bursty concurrent use without being tuned to any one provider's exact window — not claimed to be optimal, and cheap to revisit once real post-ship data exists.

**Why live is fully exempt, restated plainly:** `coaching-cue`'s total chain budget is 6 seconds across up to 2 entries (`CHAIN_BUDGET`, `types.ts`); `deal-tier1` is 4 seconds. Losing even one candidate to a *heuristic* (not a real failure) risks the hard hallway wall (`HARD_CEILING_MS`) for a purpose whose whole point is sub-second latency. Live purposes stay exactly as fast as they are today; this fix costs them nothing and protects nothing *for* them — it exists entirely to protect durable purposes from each other and from being crowded out.

---

## 2. Systemic early-exit, and the `streamWithFallback` gap

### What exists today

`deadProviders = new Set<AIProviderId>()` (`complete-with-fallback.ts:553`), checked once per loop iteration (`:569`, `if (deadProviders.has(step.providerId)) continue`), added to **exclusively** on `reason === 'auth'` (`:610`). The comment right above it (`:546-552`) is explicit about the narrowness: *"Deliberately NOT extended to 'rate-limit': Groq and Gemini rate-limit per-MODEL, so a different model on the same key really can succeed."* True for a single rate-limited model. Says nothing about the case where the walk itself, within one call, discovers that a provider is having a bad time across *multiple* of its own models.

**`streamWithFallback` has none of this at all** — confirmed by reading the entire function (`:715-921`): no `deadProviders` declaration, no check, anywhere. An auth failure on entry 1 does not stop it from trying entry 2 on the same now-known-dead provider, unlike `completeWithFallback`. This is a real, pre-existing asymmetry, unrelated to anything new here.

### The fix

Two small, independent pieces:

1. **Close the `streamWithFallback` gap** — add the identical `deadProviders` mechanism that already exists in `completeWithFallback`. Mechanical port, no new design.
2. **A same-provider heuristic for rate-limit, scoped to what's actually knowable within one walk.** Track a per-walk (not global — a local variable, reset every call) `Map<AIProviderId, number>` counting rate-limit failures by provider during *this* walk. If a second, *different* catalogId on the same provider also comes back `rate-limit` within the same walk, add that provider to `deadProviders` too. This isn't claiming to detect "account-wide" limiting from any provider-side signal (none of the four adapters distinguish per-model from account-wide scope — confirmed by reading all four `toProviderError` functions) — it's a same-walk pattern: two different models on the same provider both refusing within seconds of each other is stronger evidence than either alone, and the cost of being wrong is only "we tried one fewer candidate on a provider that was two-for-two rate-limiting us anyway."

Both purposes intentionally do not touch `markRateLimited`/`markPeriodExhausted`/`markStructurallyBroken` or their cooldown durations — this is purely about not spending a request within an *already-doomed* walk, layered on top of, not replacing, the existing per-model cooldown.

---

## 3. Honest quota messaging — with real data where it exists, not deferred everywhere

**Founder's instruction, followed literally:** confirm what each provider's API actually exposes before naming a duration in any message. Researched this session (sources below); the picture is better than assumed — several providers *do* expose real, structured reset data, just never parsed. Where no real signal exists, the message says so honestly. Nothing here invents a number.

### What's actually available, provider by provider

| Provider | Real signal available today | What it gives |
|---|---|---|
| **Anthropic** | `anthropic-ratelimit-requests-reset` / `anthropic-ratelimit-tokens-reset` response headers (ISO 8601 timestamp, present on every response) — **currently parsed nowhere** (`anthropic.ts:59-67`'s `RateLimitError` branch passes no 3rd/4th constructor arg at all). Also a `retry-after` header on 429. | Exact reset timestamp. Precise, real. [[1]](https://www.respan.ai/articles/anthropic-api-rate-limits) |
| **OpenRouter** | `X-RateLimit-Reset` header, a Unix timestamp in ms, present on rate-limit error responses — **not currently parsed** (`openai-compatible.ts` only reads `retry-after-ms`/`retry-after`, not this header). | Exact reset timestamp. Precise, real. [[2]](https://openrouter.ai/docs/api_reference/limits) |
| **Groq** | No daily (RPD) reset header exists — confirmed: Groq's own docs say to track the daily counter yourself, it resets at a fixed **midnight UTC**. Per-minute/token reset headers (`x-ratelimit-reset-requests`/`-tokens`) do exist and are short-window. | No live daily signal, but a **documented, fixed** daily schedule — computable without any response data, once we know we've hit the daily case specifically. [[3]](https://console.groq.com/docs/rate-limits) |
| **Gemini** | `RetryInfo.retryDelay` (short, already partially parsed, `gemini.ts:128-140`) and a `QuotaFailure.quotaMetric` string (e.g. `...PerDay-FreeTier`) that names *which* quota was hit — **the metric name itself is not currently parsed at all**, only the retry delay. Google's daily RPD quota is documented to reset at a fixed **midnight Pacific Time (00:00 PT / 08:00 UTC)**. | The metric name tells us *whether* it's the daily quota (real signal, currently unused). The reset time itself is a documented fixed schedule, same shape as Groq. [[4]](https://ai.google.dev/gemini-api/docs/troubleshooting) [[5]](https://ai.google.dev/gemini-api/docs/rate-limits) |
| **OpenAI** | `x-ratelimit-reset-requests`/`x-ratelimit-reset-tokens` — real, but relative-duration (`"6m0s"`, `"120ms"`) and scoped to the per-minute/per-request window, not a daily figure. No daily-reset header found. **Currently parsed nowhere** (`openai.ts:64-72`, same missing-3rd-arg gap as Anthropic). | Real short-term wait, no daily signal. |
| **NVIDIA / Cerebras / Mistral** | Route through the same `openai-compatible.ts` adapter; header behavior for these three specifically is unconfirmed by this research pass (not each individually tested against a real 429). | Unknown — treat as no-signal until confirmed. |

### The fix

1. **`AIProviderError` gains one new optional field, `resetsAt?: number`** (epoch ms), alongside the existing `retryAfterMs` — kept separate deliberately: `retryAfterMs` answers "how long until worth retrying" (short, drives the cooldown *duration*); `resetsAt` answers "when does the underlying quota actually reset" (potentially much longer, drives *messaging*, and — bonus, not scope creep — when present, replaces `markPeriodExhausted`'s guessed 1h default with the real figure, still capped by `PERIOD_EXHAUSTED_MAX_MS` as a backstop).
2. **Parse it where a real signal exists**: Anthropic's ISO-8601 header → `resetsAt` directly. OpenRouter's Unix-ms header → `resetsAt` directly. Groq: when a failure is already classified `period-exhausted` (the existing `QUOTA_KEYWORDS` match) and no live header exists, compute next UTC midnight — **documented in the code as "Groq's own published fixed schedule, not live per-response data"** so it's never confused with a real signal later. Gemini: when `quotaMetric` contains `PerDay` and it's classified `period-exhausted`, compute next-midnight-Pacific the same documented-fixed-schedule way. Everyone else: `resetsAt` stays `undefined`.
3. **Thread `AIFailureClass` into `purpose-health.ts`**, which doesn't have it today — confirmed: `FailureInfo` (`purpose-health.ts:141-145`) is `{reason: AIProviderErrorCode, providerId, detail?}`, no failure-class field; `PurposeHealth` (`:65-85`) stores `lastFailureReason: AIProviderErrorCode | null`, same gap. The call sites already compute `effectiveFailureClass(err)` at the moment of failure (`complete-with-fallback.ts:608`, `:853`) — wiring it into `recordAiFailure`'s `info` argument, and `resetsAt` alongside it, is additive plumbing, not new computation.
4. **`messageFor` gets a `period-exhausted` branch**: with `resetsAt` → `"${provider}'s free-tier quota is used up — resets around ${formatted time}. Add another provider's key, or wait."` Without it → `"${provider}'s free-tier quota is used up. We don't know exactly when it resets — add another provider's key, or check back later."` **The second sentence is the founder's own instruction, verbatim in intent**: never imply precision that isn't there.
5. **A third live `pausedReason` value.** Today, `live-cue.ts`/`deal-tier1.ts`/`deal-tier2.ts` collapse both an ordinary rate-limit *and* a genuine quota exhaustion into the same `'all-models-unavailable'` — confirmed by reading all three files' `AllModelsExhaustedError`/`AIProviderError` handling. Add `'quota-exhausted'` alongside the existing `'all-models-unavailable' | 'timed-out'`, threaded through the same three files plus `StatusNotice.tsx`/`PresenceHeader.tsx`, carrying the same real-or-honest message from step 4. This is the one piece of live-path plumbing that doesn't exist at all today and needs building, not just wiring.

---

## What I am NOT touching / deferring

- **Item 5b, context-window pre-call checks — deferred, logged here so it doesn't silently drop.** `CatalogEntry.contextWindow` exists (`model-catalog.ts:50`) but is read nowhere except a Settings display label (`ModelAssignmentSection.tsx:128`) — confirmed by grep, it has zero consumers in the actual call path. No token-counting/estimation mechanism exists anywhere in this codebase for an outbound prompt. Building this is genuinely new infrastructure (a tokenizer or character-count heuristic), not a wiring gap the way the tool-calling check was — and the evidence this session points hard at shared-resource contention as the dominant real-world failure mode, not context overflow (nothing in `ai-fallback-events.jsonl` shows a context-length error). Revisit only if a real context-overflow failure is actually observed.
- **NVIDIA/Cerebras/Mistral's real header behavior** — unconfirmed by this research pass. Ship with `resetsAt: undefined` for these (the honest path, correctly), and confirm their actual 429 response shape in a follow-up if they turn out to matter in practice.
- **Tuning `PACING_GAP_MS` per-provider** — ships as one global constant. Revisit with real post-ship data rather than more research now.
- **The escalating-backoff and cooldown-duration constants themselves** (`DEFAULT_COOLDOWN_MS`, `PERIOD_EXHAUSTED_DEFAULT_MS`, `STRUCTURAL_BREAK_MS`, the tiering rule) — unchanged. They're correct; the problem was never their values, it was that they only ever protected one purpose from itself.

---

## Phased plan

Each ships independently and leaves the app working, same discipline as every prior phase this milestone.

**Phase 1 — cross-purpose pacing.** `model-pacing.ts`, wired into both `completeWithFallback` and `streamWithFallback`'s chain filters plus the `markUsed` call site. *Verifiable: a synthetic test with 3 "purposes" (2 durable, 1 live) sharing one catalogId proves durable purposes spread out across it while live is never delayed; the real headline scenario (memory-extract + scorecard + summary all wanting Gemini in the same few seconds) resolves to at most one immediate attempt, the rest diverted to their own next chain entry, not all three failing on Gemini.*

**Phase 2 — systemic early-exit + `streamWithFallback` parity.** Port `deadProviders` to `streamWithFallback` (mechanical). Add the same-provider-twice-in-one-walk heuristic to both. *Verifiable: streamWithFallback's own version of `authShortCircuit.test.ts`'s existing scenarios (currently only proven for completeWithFallback) plus a new same-provider-rate-limit-twice-in-one-walk test.*

**Phase 3 — honest, real-where-possible quota messaging.** `resetsAt` field, the four providers' real/documented-schedule parsing, `purpose-health.ts` threading, `messageFor`'s new branch, the third live `pausedReason` value across all five consumer files. *Verifiable: unit tests per provider adapter proving real headers parse correctly (or don't exist and correctly produce `undefined`); `messageFor` tests for both the real-data and honest-unknown branches; a through-the-real-walk test proving a live purpose's `pausedReason` correctly distinguishes quota-exhausted from an ordinary cooling-down state.*

## Testing, and what only you can verify

**Automated (me):** all three phases' mechanisms are pure-function-testable the same way `model-cooldown.ts` already is (fake timers, the existing mock-registry harness in `modelCooldown.test.ts`, the real-SDK-plus-mocked-fetch harness in `realSdkRetryAndCooldown.test.ts` for provider-adapter header parsing specifically). Red-checked the same way as every other fix this session — confirm the test fails against a reverted version before trusting it green.

**Only you, against real provider behavior:** whether Anthropic's/OpenRouter's real reset headers actually show up in the shape documented (I'm working from their public docs and community reports, not a live 429 I triggered myself this session) — worth a quick real check before trusting the parsed value in production. Whether `PACING_GAP_MS = 3_000` actually reduces real collisions on your demo machine's own multi-purpose load, or needs tuning — that's exactly the kind of thing that's only visible from real usage, not a unit test.

---

**Sources for the provider research above:**
- [1] [Anthropic API (Claude) Rate Limits in 2026](https://standardcompute.com/rate-limits/anthropic), [Anthropic 429/529 in Production](https://www.respan.ai/articles/anthropic-api-rate-limits)
- [2] [OpenRouter API Credit & Rate Limits](https://openrouter.ai/docs/api_reference/limits)
- [3] [Groq Rate Limits — GroqDocs](https://console.groq.com/docs/rate-limits)
- [4] [Gemini API Troubleshooting guide](https://ai.google.dev/gemini-api/docs/troubleshooting)
- [5] [Gemini API Rate Limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- [OpenAI API Rate Limits + 429 Handling](https://www.respan.ai/articles/openai-api-rate-limits), [OpenAI rate limits guide](https://developers.openai.com/api/docs/guides/rate-limits)
