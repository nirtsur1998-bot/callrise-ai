# BUG-057 — AI fallback hole + silent repeated failure
## Final design (second pass, revised against three adversarial reviews)

---

## EXECUTIVE SUMMARY

Two defects, one trigger.

**A — the legacy path has no fallback.** `resolveChain` (`src/main/ai/complete-with-fallback.ts:155-156`) returns `[legacy]` — one attempt, zero fallback — whenever a purpose's chain is empty and a default provider is set. Fix: append the bundled chain behind the legacy step, key-filtered, different-provider-first, capped (**0** extra attempts for the two live purposes, **1** where a human is waiting, **3** otherwise). And widen `memory-extract` past the Groq-only speed lane — without that, the fix is cosmetic on your machine.

**B — nothing surfaces repeated failure.** Successes are never logged, so "consecutive" is not computable today. Fix: a small persisted per-purpose health record written by `completeWithFallback` itself. A purpose reads as *failing* after **3 separate failure episodes spanning ≥15 minutes** (bursts collapse — your 205 events are 8 episodes), surfaced as **one** Home banner that names the cause and the fix, plus honest empty states.

Separately: backfill and the onboarding interview report success while storing nothing. That is the piece that would have caught this on day one.

**Decide:** Q1, Q3, Q6.

---

## CHANGES FROM FIRST PASS

The reviews found real defects. Fifteen changes, plus four places I am pushing back.

| # | What changed | Why |
|---|---|---|
| 1 | **`MIN_STREAK_MS` now measures streak *span*, not *age*, and adds an evidence-recency gate.** | Both correctness reviews found the same fatal flaw independently: `now − firstFailureAt` grows forever, so the guard *delayed* blips into alarms instead of suppressing them. A 5-minute outage that self-healed would have produced a permanent overnight banner. |
| 2 | **Failure counting is now burst-collapsed into *episodes*.** | Verified against your live log: one backfill run produced **99 failures in 26 seconds**. Any raw-count threshold is crossed instantly by a batch loop. At a 60-second gap your 205 events collapse to **8 episodes** — and the 3rd episode is at the same instant as the 3rd raw failure, so this costs zero detection latency on the real incident. |
| 3 | **The per-purpose `FAILURE_THRESHOLD` table is deleted.** One number: 3 episodes. | Episode-collapsing made the per-purpose tuning unnecessary. Simpler *and* more correct. |
| 4 | **The 48-hour escape hatch no longer requires a prior success, and now requires ≥2 episodes.** | It excluded exactly the never-worked user. Requiring ≥2 episodes stops "one Friday blip → Monday-morning accusation." |
| 5 | **`severityOf` now takes fresh feature-enabled state.** | Turning Sales Brain off stops all `memory-extract` calls (`memory-hooks.ts:99`), so the streak could never reset — the banner latched forever on a feature the user deliberately disabled. |
| 6 | **A `no-key` streak on a machine with no text-AI keys is `not-configured`, not `failing`.** | Otherwise a fresh install gets "these features have stopped working" about features that never started, competing with `MissingKeyBanner`. |
| 7 | **Multi-purpose aggregation is now defined.** One Home banner, grouped by `(provider, reason)`. | One outage fails many purposes at once. Undefined stacking would have shipped 6-12 banners. |
| 8 | **Tier 1 (substitution notice) fires only on the *implicit tail*, via a new `fromImplicitTail` flag.** | `chainIndex > 0` is also true for a chain **you authored**. Your `scorecard` chain's first entry fails chronically (35 `failed` + 16 `rate-limit` in the log) — the first design would have put a permanent warning banner on Home for a chain working exactly as ordered. |
| 9 | **Worst-case latency table corrected for `LATENCY_POLICY.maxRetries`.** | `openai-compatible.ts:229` passes `maxRetries` to the SDK, which applies `timeoutMs` *per attempt*. The first pass understated worst cases by 2-3×. |
| 10 | **The legacy step's duplicate-model problem is now fixed, not disclosed.** New optional `defaultModelId` on `ProviderRegistryEntry`. | Verified: **6 of 8** providers' `defaultModel` is byte-identical to a catalog entry's `modelId`. For the single-key user A2 protects, attempt 1 and attempt 3 were literally the same request. The first pass's "the cap truncates it away" is false for exactly that user. |
| 11 | **`auth` failures now skip every remaining step on the same provider.** | An invalid key fails identically on every model. This is what makes A2 not-just-slower-failure in the most common broken-key case. |
| 12 | **Three cap constants collapsed to one exhaustive `LEGACY_TAIL_MAX: Record<AIPurpose, number>`.** | The `CHAIN_BUDGET`-presence overload was a third meaning bolted onto a two-field type, and a `Partial<Record>` lets a 13th purpose silently inherit a number nobody chose. |
| 13 | **`streamWithFallback`'s mid-stream failure exit (`:341-348`) now records a failure.** | It was missing from the four recording sites. A `coaching-chat` that dies after the first delta would have frozen the counter — the new mechanism reproducing the old bug. |
| 14 | **§5 now reuses `createScanTally()` instead of hand-rolling a parallel tally; the throw condition is corrected.** | The first pass imported that module's constant while duplicating the module. Throw condition changed from "zero memories created" to "zero successful AI calls" — a healthy run over calls with nothing extractable must not read as failure. |
| 15 | **Phases re-cut.** P1+P2 merged (P1 alone is a no-op on your config); the store now ships with its Settings surface; P6 split into three. | A phase that changes nothing observable is not a phase. |

**Where I am pushing back:**

- **"Add `other`/`coaching-chat` to `CHAIN_BUDGET`" (correctness S1, option i).** Rejected. `CHAIN_BUDGET` also caps *configured* chains at settings-write time (`model-assignments.ts:46-47`), so it would silently rewrite your existing 2-entry `other` and `coaching-chat` chains, and it breaks `chainBudget.test.ts:22-31`, which asserts `CHAIN_BUDGET['other'] === undefined` as a deliberate decision. Option (ii) — exclude them entirely — is over-strict: `askCoach` is a question a rep deliberately asked, and answering late beats failing. One tail entry, with the corrected latency stated honestly.
- **"Two runtime policies behind one 'Automatic' label" (scope F2).** Partly conceded (one table now), but the asymmetry stays and is deliberate: a chain **you authored** may be 9 long; a chain the app **inferred** on your behalf gets 4. Being more conservative with inferred spend than with authored spend is the correct default, and it is A1's own logic.
- **"205 consecutive failures" as the framing.** Not a critique's error — mine and yours. See §1.
- **The "15 minutes to detection" claim in the first pass.** Wrong by ~26×. Corrected to **6h35m**, verified. Still ~41 hours before you noticed.

---

## 0. FACTS I VERIFIED MYSELF (these change the premises)

**(1) `aiProvider` is `"groq"` now; it was `"google"` during the incident.** `app-settings.json` (mtime **today 15:23**) reads `groq`. The last failure in the log is **today 14:39 local**, `fromCatalogId: "legacy:google"`. So the switch happened *after* the last failure. Q10 asks whether that was you or `maybeAutoSelectProvider`.

**(2) Only THREE purposes take the legacy branch on your machine — and none of them is live or interactive.** Read from disk:

| chain | purposes |
|---|---|
| configured (2-9 entries) | `coaching-cue`, `summary`, `scorecard`, `tasks`, **`other`**, `prep-brief`, `deal-tier1`, `deal-tier2`, **`coaching-chat`** |
| **`[]`** | `memory-extract`, `memory-consolidate`, `memory-reflect` |

This corrects `survey:callsites-blast-radius`, which claimed `other` and `coaching-chat` are "in the same hole today." On *your* machine they are not. Consequence: **P1 has zero effect on any path where a human is waiting, on your machine.** The live/interactive caps in §2 exist for everyone else.

**(3) But every fresh install runs the legacy path for all twelve purposes.** `DEFAULT_MODEL_ASSIGNMENTS` (`model-assignments.ts:23-36`) is `{chain: []}` for all 12, and `aiProvider` defaults to `'anthropic'` (`app-settings.ts:501`) with `maybeAutoSelectProvider` flipping it to the first key saved. So for a new user, *every* AI feature is one-attempt-no-fallback until they visit Model Assignment. The blast radius of Defect A is much larger than your machine shows.

**(4) Your 205 failures are 8 episodes, and 198 of them are two backfill runs from this morning.**

| # | start (UTC) | n | span |
|---|---|---|---|
| 1 | 08-12 13:44:14 | 1 | — |
| 2 | 08-12 20:15:24 | 1 | — |
| 3 | 08-12 20:19:47 | 1 | — |
| 4 | 08-13 10:11:32 | 1 | — |
| 5 | 08-13 10:14:42 | 1 | — |
| 6 | 08-13 10:18:41 | 2 | 12s |
| 7 | **08-13 10:46:19** | **99** | **26s** |
| 8 | **08-13 11:39:03** | **99** | **26s** |

Genuine post-call extraction failures over the two days: **7**. Episodes 7 and 8 are two "Import now → also scan past calls" runs **you ran this morning**, each of which burned 99 doomed requests and then reported green **"Import complete."** — §5's hole, live, today. This does not weaken the bug (every attempt still failed; Sales Brain still learned nothing). It changes what a counter must count.

**(5) Groq is not a safe harbor on this machine.** The log has 55 `other` + 16 `scorecard` rate-limits on `groq-llama-3.3-70b-versatile`, 35 `scorecard` hard failures on `groq-gpt-oss-120b`, plus `legacy:openrouter` (Aug 11) and `legacy:groq` (Aug 11) rows — this machine has been through three default providers, and other purposes sat on the same one-step legacy path before their chains were written.

**(6) Startup ordering is already safe.** `src/main/index.ts:324` is `await loadStoredAiKeysIntoEnv()`, before `registerAiKeys()`/`registerModelCatalog()`/`registerFallbackLog()` at `:325-327` (with an earlier best-effort load at `:305`). The first pass listed this as an open risk. It is closed. Hydrate the health store at `:324` alongside the keys.

---

## 1. PROBLEM RESTATEMENT

Two defects. One trigger, two independent failure modes, two independent fixes.

**Defect A — the legacy path has no fallback.** `complete-with-fallback.ts:155-156`:

```ts
const legacy = legacyStep()
if (legacy) return [legacy]
```

An array of exactly one, returned unconditionally, short-circuiting the bundled `DEFAULT_CATALOG_CHAIN` branch on lines 158-167. The file header (lines 5-11) documents this as deliberate M16-parity. That argument is sound for **attempt 1**; it was over-applied to **attempts 2..n**. Setting a default provider silently opts you out of every fallback the app has, for every purpose the Settings picker cannot reach — which, per fact (3), is all twelve on a fresh install.

**Defect B — nothing surfaces repeated failure.** Structurally independent. Even with A fixed, an exhausted chain is still invisible:

- `logFallbackEvent` is called only from `catch` blocks (`:243`, `:333`). **Successes are never logged.** There is no reset signal in the file, so "consecutive" is not computable from it at any level of cleverness.
- The `chain.length === 0` → `AIProviderError('no-key')` throw at `:194` happens **before any logging** — a purpose that cannot run at all leaves zero evidence.
- The only consumer is `RecentFallbackActivity` (`ModelAssignmentSection.tsx:259-287`): last 20 events, 10 rendered, `return null` when empty, three clicks deep, no counts. Its own copy — "the next one in its chain takes over automatically" — is affirmatively false for a one-step chain.
- `extraction.ts:194-196` `catch { return [] }` converts every AI failure into "found nothing", which `memory-hooks.ts:27-28` (`if (newCount === 0) return`) converts into silence, and `memory-extraction-job.ts:43` (`silent: true`) converts into a **green check** in the Activity Center.

**A precision correction to the framing, which matters for the fix.** "205 consecutive failures" is 205 *attempts*, of which 198 are two backfill bursts from this morning. The honest statement is: **every extraction attempt for two days failed, across 8 separated occasions, and the product's every surface reported success.** A counter that counts raw attempts would have tripped on any 30-second network hiccup during a backfill; a counter that counts *occasions* trips on your incident at the same moment and not on the hiccup. That is the whole reason §4 counts episodes.

Ship both fixes, in order, as separate phases. Fixing A alone leaves the next failure mode silent. Fixing B alone leaves you with a correct alarm about a hole that did not need to exist.

---

## 2. PART 1 — FALLBACK POLICY

### 2.1 The rule

> For a purpose:
> 1. If a configured chain exists and any entry survives the filters (catalog-known, not `knownStale`, provider key present in `process.env`) — return exactly those. **Unchanged.**
> 2. Else if a legacy default provider with a key exists — return the legacy step **first**, followed by up to `LEGACY_TAIL_MAX[purpose]` bundled entries under the same filters, **stably partitioned so different-provider entries come first**, with **at most one** same-provider entry, and **never** an entry whose concrete model is the legacy step's own default model.
> 3. Else — return the filtered bundled chain. **Unchanged** (except that `memory-extract`'s bundled chain itself widens — §2.3, deliberate).
>
> Additionally, in the chain-walk loop: once a step fails with `auth`, every remaining step on that same provider is skipped.

### 2.2 The diff — `resolveChain`, `complete-with-fallback.ts:123-168`

```ts
/** How many BUNDLED fallback entries may sit behind the legacy step.
 *
 *  Exhaustive Record, not Partial, and not derived from CHAIN_BUDGET: a 13th
 *  purpose must force a decision here rather than silently inheriting a
 *  number nobody chose for it — the same convention LATENCY_POLICY and
 *  DEFAULT_CATALOG_CHAIN already use in this file.
 *
 *  0 for the two live paths. Their whole budget is the point (see
 *  CHAIN_BUDGET's doc comment in types.ts — M9 already fixed one multi-second
 *  dead-air regression here), and they are the only two purposes whose
 *  exhaustion is ALREADY visible to the rep, via LiveView's "AI coaching cues
 *  are temporarily unavailable" banner. Silence was never their failure mode,
 *  so they are not what BUG-057 is for.
 *
 *  1 where a human is watching a spinner: 'other' carries askCoach()
 *  (live-cue.ts:143 — mid-call, rep blocked), and 'coaching-chat' is the only
 *  streamWithFallback() consumer, which has no budget logic at all. One retry
 *  on a DIFFERENT provider is worth the wait; a third and fourth are not.
 *
 *  3 elsewhere: enough to cross two or three providers on a typical key set,
 *  bounded enough that a doomed call costs 4 requests instead of 9. If four
 *  models across every provider you hold a key for fail within seconds of
 *  each other, what is broken is the account, the network, or the request
 *  shape — not the model. */
const LEGACY_TAIL_MAX: Record<AIPurpose, number> = {
  'coaching-cue': 0,
  'deal-tier1': 0,
  other: 1,
  'coaching-chat': 1,
  summary: 3,
  scorecard: 3,
  tasks: 3,
  'prep-brief': 3,
  'deal-tier2': 3,
  'memory-extract': 3,
  'memory-consolidate': 3,
  'memory-reflect': 3
}

/** Lines 158-167, moved verbatim so the legacy branch can reach them instead
 *  of short-circuiting past them (BUG-057). The key filter is unchanged code,
 *  not a rewrite — it must stay read-fresh from process.env on every
 *  resolution, because ai-keys.ts sets and deletes those vars mid-session. */
function bundledSteps(purpose: AIPurpose): ResolvedStep[] { /* lines 158-167, unchanged */ }
```

Replacing lines 155-167:

```ts
  // BUG-057 — this used to be `if (legacy) return [legacy]`: the legacy step
  // was the WHOLE chain. One attempt, zero fallback, for every purpose with an
  // empty chain — which on a fresh install is ALL TWELVE (see
  // DEFAULT_MODEL_ASSIGNMENTS), and on an established install is every purpose
  // Settings cannot reach (catalog-ipc.ts's ASSIGNABLE_PURPOSES omits
  // memory-extract/-consolidate/-reflect, 'other' and 'coaching-chat').
  // Against a rate-limited provider that is a feature which fails every single
  // time and says nothing: two days of Sales Brain learning nothing from any
  // call, with every surface in the product reporting success.
  //
  // The legacy step still goes FIRST, so an existing M16 install's first
  // attempt is byte-identical to before — the promise this file's header
  // makes. Only what happens AFTER it fails is new.
  const legacy = legacyStep()
  if (!legacy) return bundledSteps(purpose)

  const tailMax = LEGACY_TAIL_MAX[purpose]
  if (tailMax === 0) return [legacy] // computed before bundledSteps: coaching-cue is a per-few-seconds hot path

  const bundled = bundledSteps(purpose)

  // Never re-issue the identical request as attempt N+2. registry.ts's
  // defaultModel is byte-identical to a catalog entry's modelId for six of the
  // eight providers (groq/google/nvidia/cerebras/mistral/openrouter), and the
  // `attempted` Set below dedupes by catalogId, which can never match
  // `legacy:*`. For a single-key user — exactly the user requirement A2 exists
  // to protect — that duplicate is not truncated away by the cap; it lands at
  // index 3 of 4.
  const legacyModelId = PROVIDER_REGISTRY[legacy.providerId].defaultModelId
  const usable = bundled.filter((s) => s.modelId !== legacyModelId)

  // Different providers first, then AT MOST ONE same-provider model.
  // Dropping same-provider entries entirely would leave memory-extract
  // (SPEED_CHAIN = groq/cerebras only) with literally nothing behind a groq
  // legacy step; leaving them in place would make the first "fallback" behind
  // a google legacy step be google-gemini-flash, the account that just 429'd.
  // One is kept because Groq and Gemini rate-limit per-MODEL, so a different
  // model on the same key really can succeed — but only one, because if two
  // models on that key fail the account is the problem (A2: "for a single-key
  // user, 'fall back to the bundled chain' is just slower failure").
  const others = usable.filter((s) => s.providerId !== legacy.providerId)
  const same = usable.filter((s) => s.providerId === legacy.providerId).slice(0, 1)
  return [legacy, ...others, ...same].slice(0, tailMax + 1)
```

**Three small companion changes in `completeWithFallback`'s loop:**

```ts
// (a) An invalid/revoked key fails identically for every model on that
//     provider — the remaining same-provider steps are guaranteed-doomed
//     requests. Rate limits are NOT included: Groq and Gemini rate-limit
//     per-model, so a different model on the same key is a real second chance.
const deadProviders = new Set<AIProviderId>()
...
if (deadProviders.has(step.providerId)) continue
...
if (reason === 'auth') deadProviders.add(step.providerId)

// (b) Keep the classified code, not just the concatenated display string —
//     `attempts[].reason` is `${code}: ${detail}`, and PurposeHealth needs the
//     bare AIProviderErrorCode (Part 3).
let lastReason: AIProviderErrorCode | null = null
let lastProviderId: AIProviderId | null = null
let lastCatalogId: string | null = null
let lastDetail: string | undefined

// (c) The per-attempt budget timer at :224 is never cleared, so it fires after
//     a successful return. One clearTimeout in the finally.
```

**One field in `registry.ts`** (`ProviderRegistryEntry`), with **no duplicated string constants** — hoist each provider's config object to module scope so `build` and `defaultModelId` read the same literal:

```ts
const GROQ_CONFIG = { id: 'groq', displayName: 'Groq', baseURL: '…', defaultModel: 'llama-3.3-70b-versatile', testModel: 'llama-3.1-8b-instant' } as const
...
groq: {
  displayName: 'Groq',
  keyEnvName: 'GROQ_API_KEY',
  /** The concrete model a step with no explicit req.model resolves to.
   *  Only used to stop the legacy step and a catalog entry being the same
   *  request twice (BUG-057). Undefined for anthropic/openai — they pick
   *  per-purpose via MODEL_BY_PURPOSE and have no catalog entries at all,
   *  so a collision is impossible there. */
  defaultModelId: GROQ_CONFIG.defaultModel,
  build: (key) => createOpenAICompatibleProvider(GROQ_CONFIG, key)
}
```

Gemini's `DEFAULT_MODEL` (`providers/gemini.ts:31`) gets exported for the same purpose.

**And one field on `ResolvedStep`**, used by Part 2 only:

```ts
/** True for the bundled entries BUG-057 appends behind a legacy step —
 *  models the user never chose for this job. False for a configured chain's
 *  entries (the user authored that ordering, a fallback within it is the
 *  system doing what they asked) and for the bundled-only branch (there is no
 *  "primary" there to have substituted for). This is what keeps A1's
 *  "a provider I didn't pick for that call" notice rare and truthful. */
fromImplicitTail: boolean
```

### 2.3 `memory-extract`'s bundled chain is single-lane — required, not optional

`complete-with-fallback.ts:99` — `'memory-extract': SPEED_CHAIN`, which is groq×5 + cerebras×1. Your keys are Deepgram, Google, Groq, OpenRouter. After the key filter and the two `knownStale` skips, `memory-extract`'s bundled chain is **three Groq entries and nothing else**. With `aiProvider: "groq"`, §2.2 alone gives you `[legacy:groq, groq-8b, groq-gpt-oss-120b]` — three attempts on one rate-limited account. It will pass a unit test and still fail live.

```ts
/** BUG-057 — speed lane FIRST (extraction is fixed-shape allowlist pulling,
 *  not judgment work — the M25 spec's "fast model for extraction"), but no
 *  longer speed lane ONLY. SPEED_CHAIN is groq+cerebras exclusively, so on a
 *  machine with a groq key and a rate-limited groq account, "fall back" meant
 *  every attempt on the same 429. This purpose has no CHAIN_BUDGET and blocks
 *  nothing a user is watching — a slower quality-lane model is strictly
 *  better than learning nothing from the call. */
const EXTRACT_CHAIN = [...new Set([...SPEED_CHAIN, ...QUALITY_CHAIN])]
```

**Stated plainly, correcting the first pass's invariant table:** this changes branch 3 too. A no-legacy install with only a Google key goes from `[]` (immediate `no-key`, silently swallowed by `extraction.ts:194-196`) to a working chain — an improvement, but a real change. The uncapped worst case for `memory-extract` on branch 3 goes from 4 attemptable entries to **10** (12 ids minus 2 `knownStale`), against `summary`/`scorecard`'s existing uncapped **9**. That is +1 over the norm this codebase already accepts for background purposes, on the BATCH lane where nothing is watching. I judge it acceptable; Q2 makes it your call.

Effect on your exact config (`aiProvider: groq`; groq/google/openrouter keyed):

| purpose | today | after §2.2 only | after §2.2 + §2.3 |
|---|---|---|---|
| `memory-extract` | **1** attempt (groq) | 3 attempts, **all groq** | **4 attempts / 3 providers** — `legacy:groq`, `google-gemini-flash`, `openrouter-nemotron-3-ultra`, `openrouter-auto-free` |
| `memory-consolidate` / `-reflect` | **1** | 4 / 3 providers | unchanged (already QUALITY_CHAIN) |
| all nine others | unchanged (configured chains) | unchanged | unchanged |

### 2.4 How A2 ("keys only") is enforced

By reusing the existing predicate **verbatim** — the same three lines that already appear four times in this file (`:145-146`, `:163-164`, `:207-208`, `:310-311`):

```ts
const keyEnvName = PROVIDER_REGISTRY[entry.providerId].keyEnvName
if (!process.env[keyEnvName]?.trim()) continue // skip - no key configured
```

`bundledSteps()` is lines 158-167 *moved*, not rewritten. Two load-bearing properties: it is read **fresh** from `process.env` on every resolution, never snapshotted (matching the house rule stated at `memory-hooks.ts:88-94`), and `completeWithFallback:207-208` re-checks the same predicate inside the loop so a key removed mid-walk skips rather than fails.

**Honest limit, stated plainly.** For a genuinely single-key user the tail is now: zero or one same-provider model, skipped entirely if the failure was `auth`, and never a repeat of the legacy step's own model. Your "just slower failure" concern is fully answered for account-level outages (auth → 0 extra requests) and reduced to **one** extra request for rate limits, where a different model on the same key genuinely can succeed. Part 3 is what tells that user "add a second key" instead of leaving them to guess.

### 2.5 Latency — corrected for `maxRetries`

`openai-compatible.ts:229` passes `{ timeout: policy.timeoutMs, maxRetries: policy.maxRetries }`; the SDK applies the timeout **per attempt**. So one `provider.complete()` costs up to `timeoutMs × (1 + maxRetries)`. (Gemini is exempt — `gemini.ts:187` is a single fetch.) The first pass's table was 2-3× optimistic.

| purpose | attempts today → after | worst case today → after | who waits |
|---|---|---|---|
| `coaching-cue` | 1 → **1** | 6s → **6s** | rep, mid-call |
| `deal-tier1` | 1 → **1** | 4s → **4s** | rep, mid-call |
| `other` (askCoach) | 1 → 2 | ~60s → **~120s** | rep, blocked |
| `coaching-chat` (stream) | 1 → 2 | ~90s → **~180s** to first token | rep, watching |
| `summary`/`scorecard`/`deal-tier2` | 1 → 4 | ~180s → ~720s | a progress chip |
| `tasks` | 1 → 4 | ~90s → ~360s | a progress chip |
| `memory-extract` | 1 → 4 | ~40s → ~160s | nobody |
| `memory-consolidate`/`-reflect` | 1 → 4 | ~180s → ~720s | nobody (nightly) |

Two things make the two mid-call rows tolerable, and I want both on the record rather than buried:

1. **The live paths do not change at all.** Achieved by exclusion (`LEGACY_TAIL_MAX` = 0), not by budget arithmetic. `chain.length === 1` ⇒ `perAttemptMs = 6000 / 4000` at `:221-222`, bit-identical to today. No re-litigating M9 or M24's ≤4s criterion.
2. **The *worst* case doubles; the *common* case adds under a second.** `rate-limit`, `auth`, and `model-not-found` all return fast — they are 4xx responses, not timeouts. Only `network`/`timeout` failures consume the full per-attempt budget. Every failure in your log is a fast 4xx.

And on your machine specifically, per fact (2): `other` and `coaching-chat` have configured chains, so **none of the interactive rows applies to you at all.**

### 2.6 Cost

Zero on the happy path — a fallback attempt only ever follows a failure, so a succeeding call costs exactly what it costs today. Worst case per call is `LEGACY_TAIL_MAX[purpose]` extra requests: 0 live, 1 interactive, 3 background. The partition sends the *first* extra request to a different provider — the one most likely to work — so the expected extra on a real outage is close to 1, not 3. Most failure classes are rejected before tokens are billed.

The uncapped multipliers remain real and are bounded elsewhere: `memory/backfill.ts` loops every call × (1 extract + up to 3 `judgeSameFact` + 1 `detectContradiction`). §5's circuit breaker is what bounds that, and it matters as much as this cap — this morning it would have saved 2 × 96 doomed requests.

### 2.7 What must NOT change

| Invariant | Preserved by | What it protects |
|---|---|---|
| An M16 install's **first** attempt is bit-identical | legacy stays at index 0; `modelId: ''` → `model: undefined` (`:234`) | this file's header (5-11), `app-settings.ts:438-445` |
| A **configured** chain resolves exactly as today | branch 1 (`:127-153`) untouched; `LEGACY_TAIL_MAX` applies only to branch 2 | 9 of 12 purposes on your machine |
| Live latency contracts | `LEGACY_TAIL_MAX` = 0 for both | M9's dead-air fix; M24's ≤4s |
| `maxChainLength ≤ 2` never exceeded | those purposes never grow past 1 | `chainBudget.test.ts:34-59` |
| `knownStale` never attempted | `bundledSteps` is lines 158-167 moved verbatim | `resolveChain.test.ts:44-64` |
| A logging failure never breaks the call | no change to `void logFallbackEvent(...)` | `fallback-log.ts:41-43` |
| Extraction never throws into a fire-and-forget caller | Part 1 touches no `catch` in `memory/`; §5 changes the shape, not the contract | `extraction.ts:195`, `backfill.ts:178` |
| **Changed deliberately:** branch 3 for `memory-extract` only | §2.3, argued above | — |

---

## 3. PART 2 — VISIBILITY OF SUBSTITUTION (A1)

### 3.1 Does the app know which model served a request?

**Not from the result — and it does not need to.** `AICompletionResult` (`types.ts:114-122`) carries `model: string` only: never a provider (`groq-gpt-oss-120b` and `cerebras-gpt-oss-120b` both return the literal `'openai/gpt-oss-120b'`), no `catalogId`, and on a legacy step it is silently the provider's internal default. `completeWithFallback:237` is `return result` — it holds `step`, `i`, and now `step.fromImplicitTail`, and discards all three.

But the notice is recorded **at that line**, into the health store, not returned to 26 call sites that would each have to render it. That is the minimal route: four recording points, zero consumer changes.

If per-artifact provenance is later wanted, it is two non-breaking lines (an optional `served?: { catalogId, providerId, chainIndex }` no provider ever sets). **Recommendation: defer** — Q8.

### 3.2 The tiers

**One row per purpose at the highest applicable tier.** Tier 1 requires *successes* on a substitute; Tier 2 requires *zero* successes — mutually exclusive by data, with `severityOf`'s precedence as the tiebreaker for the mixed state (substituting for hours, then the substitute dies → Tier 2 wins).

**Tier 0 — a transient substitution.** Fell back, succeeded, primary served again. **Log only.** No banner, no toast. This is the system working.

**Tier 1 — sustained substitution on the implicit tail.** The purpose's last **≥2 successes were all `fromImplicitTail`, spanning ≥30 minutes**, with no primary success in between. Warning-free, information-toned line in the Home banner slot:

> **Sales Brain is running on Gemini, not Groq**
> Groq has been unavailable since 2:10 PM (rate limit), so fact extraction is going to Gemini instead — on your Gemini key. → *Model Assignment*

Clears the instant a non-tail step succeeds.

**Why `fromImplicitTail` and not `chainIndex > 0`:** your `scorecard` chain's first entry fails chronically (35 `failed` on `groq-gpt-oss-120b` + 16 rate-limits on `groq-llama-3.3-70b-versatile` in the log). Under a `chainIndex > 0` rule you would get a permanent Home banner about a chain **you ordered yourself**, working exactly as designed. A1's words are "a provider I didn't pick **for that call**" — a chain you authored *is* a pick.

**Tier 2 — failing.** Part 3. Supersedes Tier 1 for the same purpose.

### 3.3 Where it renders

**Primary: a Home banner**, modeled on `MissingKeyBanner` (`HomeView.tsx:32-79`, rendered at `:135` as the first element). Same grammar — rounded card, icon, bold headline, one sentence, one inline navigate button. That component's own doc comment (29-31) is your existing written argument for exactly this pattern.

**Secondary: Settings → AI Setup → Model Assignment**, upgrading `RecentFallbackActivity` (`:259-287`) into a per-purpose rollup **above** the raw list: human job label (its own `JOBS` array 210 lines up already says "Sales Brain — fact extraction"; today the card prints the raw enum `memory-extract`), episode count, raw attempt count, since-when, last `detail`. Remove the `return null` on empty so the card is a stable place to look, and fix the copy at `:271-274` which currently claims the next model takes over automatically — true only after Part 1 ships.

**Deliberately NOT the Activity Center**, against `survey:status-precedents`' #1 ranking: it is `Job[]`-typed by construction, its red dot already means "some job finished" (successes included), and during this incident it displayed **205 green checks**. It is the surface that was most wrong. It can mirror the condition later; it must not own it.

### 3.4 Aggregation — one banner, never twelve

A single cause fails many purposes at once (one key, one provider, offline). Rule:

1. Compute severity per purpose.
2. Group the `failing` set by `(lastFailureProviderId, lastFailureReason)`; group the Tier-1 set the same way.
3. **Home shows exactly one banner**, for the largest `failing` group; if none is failing, the largest Tier-1 group. Rank ties by earliest `firstFailureAt`.
4. When a group covers >1 purpose, the headline names the cause, not one feature:

> **Groq is rate-limiting your key — 6 AI features have stopped working since 2:10 PM.**
> Adding a second provider's key lets these fall back instead of failing. → *AI Setup*

5. Per-purpose detail lives in the Settings rollup only.
6. **Suppressed while a LIVE-lane job is running** — precedent `jobs/activity.ts:63` (`jobs.some(j => j.lane === 'LIVE' && j.state === 'running')`). A rep who navigates to Home mid-call must not get a warning card during a customer conversation.

---

## 4. PART 3 — CONSECUTIVE-FAILURE SURFACING

### 4.1 Are successes observable? (the blocking question)

**No — and this is the one thing that must be added before anything else in Part 3 is possible.** Two failure events 48 hours apart are byte-identical whether zero or ten thousand successes happened between them.

**Can the fallback log carry it?** No, and I recommend against trying, for four structural reasons — not aesthetics:

1. **Wrong granularity.** One failing call with a 4-step chain emits 4 lines; four failing calls with 1-step chains also emit 4. Nothing correlates lines into calls. On your machine 1 line == 1 call only by the accident of a 1-length chain — and Part 1 removes that accident.
2. **Retention is global.** `MAX_ENTRIES = 1000` shared across all purposes (`fallback-log.ts:31`). Your file is already 50% one purpose, and **two backfill runs consumed 198 of the 1000 slots in 52 minutes**.
3. **Lossy by design.** `pruneIfNeeded()` (`:46-56`) is a read-modify-write running after *every* append, and appends are `void`-ed. Overlapping writes can silently drop lines.
4. **Logging successes would make (2) and (3) dramatically worse** — `coaching-cue` fires every ~2.5s mid-call (`useLiveCues.ts:78`, `CALL_GAP_MS`).

**Therefore: a separate counter.** A counter is *state* (12 purposes × a few scalars), not events.

### 4.2 The mechanism

Two files, split the way `objection-scan-tally.ts:1-3` explains its own split ("kept as pure logic with no Electron import so it stays testable").

**`src/main/ai/purpose-health.ts`** — pure reducer, zero Electron import:

```ts
export interface PurposeHealth {
  /** Whole-CALL failures in a row (chain exhausted, or no chain at all),
   *  never per failed step — otherwise "N in a row" would mean something
   *  different before and after BUG-057 changed chain lengths. Kept as the
   *  honest number to SHOW ("205 attempts"). */
  consecutiveFailures: number
  /** What actually TRIPS the indicator. Failures within EPISODE_GAP_MS of
   *  each other count as ONE. A backfill scans every call in a loop — one
   *  30-second provider hiccup produced 99 exhausted chains in 26 seconds in
   *  the real log — so counting raw failures would make "3 in a row" mean
   *  "one bad half-minute", which is exactly the blip this threshold exists
   *  to ignore. Verified: at a 60s gap the founder's 205 events collapse to 8
   *  episodes and the 3rd episode lands at the SAME instant as the 3rd raw
   *  failure, so this costs zero detection latency on the real incident. */
  failureEpisodes: number
  firstFailureAt: string | null
  lastFailureAt: string | null
  lastFailureReason: AIProviderErrorCode | null
  lastFailureProviderId: AIProviderId | null
  lastFailureCatalogId: string | null
  lastFailureDetail: string | null
  lastSuccessAt: string | null
  lastSuccessCatalogId: string | null
  lastSuccessProviderId: AIProviderId | null
  lastSuccessFromImplicitTail: boolean | null
  /** When the current implicit-tail-only run began; null while a step the
   *  user actually chose is serving. Drives Tier 1 (§3.2). */
  substitutingSince: string | null
  substituteSuccesses: number
}

export function recordSuccess(h, at, step: { catalogId, providerId, fromImplicitTail }): PurposeHealth
export function recordFailure(h, at, f: { reason, providerId, catalogId, detail }): PurposeHealth
export function severityOf(h, now, ctx: { featureEnabled: boolean; anyTextKeyConfigured: boolean }):
  'ok' | 'not-configured' | 'substituting' | 'failing'
```

**`src/main/ai/purpose-health-store.ts`** — persistence + IPC. In-memory `Map<AIPurpose, PurposeHealth>` (authoritative; never `load → mutate → save` across an `await`), hydrated at `index.ts:324` alongside the keys, written through `writeJsonAtomic` (`src/main/atomic-write.ts`, the same primitive `jobs/store.ts` uses) to `userData/ai-purpose-health.json` with a `schemaVersion` field, throttled via `src/main/jobs/throttle.ts` with **`leading: false`** (that module's own doc comment: use it "wherever `cancel()` needs to be a real guarantee … e.g. JobManager's own persistence") and **serialized on a single in-flight promise** so two `rename`s cannot land out of order. Broadcasts `aiHealth:changed` on a severity transition; exposes `aiHealth:snapshot`.

**Keyed by `AIPurpose`** — not by provider, not by model. Your sentence is "a *feature* failing every attempt"; the user-visible unit is the job. The provider is *content* of the message (and the grouping key at the surface, §3.4), not the key of the state.

**Persisted, in its own file.** A purely in-memory streak resets on every launch, and a 48-hour window certainly spans restarts. Not in `app-settings.json`: `saveAppSettings` stamps `settingsUpdatedAt` and `syncScope.settingsPersonalization` can push settings to the cloud — one AI failure would trigger a cloud-sync write. Same local-only posture `fallback-log.ts:1-11` already argues for itself.

**Recorded at exactly six points, all in `complete-with-fallback.ts`:**

| line | call |
|---|---|
| `:194` — `chain.length === 0` throw | `recordFailure(reason: 'no-key')` — **the case that leaves zero evidence today** |
| `:237` — success return | `recordSuccess(step, i)` |
| `:258` — `AllModelsExhaustedError` | `recordFailure(lastReason ?? 'failed', …)` — `attempts` can legitimately be empty if every step hit `if (!key) continue` at `:208`; handle nulls |
| `:298` — stream, empty chain | `recordFailure('no-key')` |
| `:325` — stream success | `recordSuccess` |
| **`:341-348` — stream mid-stream failure** | `recordFailure` — **added in this pass.** A `coaching-chat` that dies after the first delta recorded *neither* success nor failure, freezing the counter. That is the old bug reproduced inside the new mechanism. |
| `:359` — stream exhaustion | `recordFailure` |

All wrapped so a health-store failure can never break the call, matching `fallback-log.ts:41-43`.

### 4.3 The trip rule

```ts
/** Three separate failure occasions. Not a new number — it is
 *  objection-scan-tally.ts:19's CONSECUTIVE_FAILURE_LIMIT, the same "three in
 *  a row means the API is down, not a fluke" judgment this codebase already
 *  made once. Referenced rather than imported: that constant belongs to the
 *  objection scan's own run-local circuit breaker, and a cross-feature import
 *  would tie two unrelated policies together. */
const FAILURE_EPISODE_LIMIT = 3
const EPISODE_GAP_MS = 60_000

/** The streak's own DURATION, not its age. A burst of failures inside a
 *  couple of minutes is a Wi-Fi handoff or a captive portal, not a broken
 *  feature, and a banner that flickers during a network blip teaches people
 *  to ignore banners. (First pass measured `now − firstFailureAt`, which
 *  grows forever and therefore DELAYED blips into permanent alarms instead of
 *  suppressing them — a 5-minute outage that self-healed produced an
 *  overnight banner.) */
const MIN_STREAK_SPAN_MS = 15 * 60_000

/** No recent failure means no live problem. Without this, quitting on Friday
 *  after one blip and reopening on Monday asserts a three-day outage before a
 *  single AI call has been made. 72h, not 24h, because it must comfortably
 *  exceed the slowest purpose's natural cadence (memory-reflect is nightly). */
const EVIDENCE_MAX_MS = 72 * 60 * 60_000

/** The founder's own number, and the escape hatch for rarely-fired purposes.
 *  Requires >= 2 episodes so a single Friday-afternoon blip can never become
 *  a Monday-morning accusation, and uses firstFailureAt when there has never
 *  been a success — the never-worked user is the one MOST in need of a signal
 *  and the first pass excluded them. */
const STALE_MS = 48 * 60 * 60_000
```

```ts
function severityOf(h, now, ctx) {
  if (!ctx.featureEnabled) return 'ok'                       // read FRESH, never snapshotted
  if (h.consecutiveFailures === 0) return substitutionTier(h, now)
  if (h.lastFailureReason === 'no-key' && !ctx.anyTextKeyConfigured) return 'not-configured'
  if (now - t(h.lastFailureAt) > EVIDENCE_MAX_MS) return 'ok'

  const span = t(h.lastFailureAt) - t(h.firstFailureAt)
  const countTrip = h.failureEpisodes >= FAILURE_EPISODE_LIMIT && span >= MIN_STREAK_SPAN_MS
  const staleTrip = h.failureEpisodes >= 2 && now - t(h.lastSuccessAt ?? h.firstFailureAt) >= STALE_MS
  return countTrip || staleTrip ? 'failing' : 'ok'
}
```

**Verified against the real data and the three adversarial personas:**

| scenario | result |
|---|---|
| **Your incident** | 3rd episode at **2026-08-12T20:19:47Z**, span 6h35m ≥ 15 min → **`failing`**, ~41 hours before you noticed |
| 5-minute rate limit mid-call, provider recovers | all failures inside one episode (2.5s cadence, gaps ≪ 60s) → `ok`. Even as 3 episodes, span 5 min < 15 min → `ok` |
| 99-failure backfill burst then silence | 1 episode → `ok` |
| one Friday blip, back Monday | 1 episode; and `staleTrip` needs ≥2 → `ok` |
| Sales Brain turned off while failing | `featureEnabled === false` → `ok`, immediately |
| nightly `memory-reflect` broken from day one | trips on the 3rd night (both paths agree) |
| fresh install, no keys at all | `not-configured` → routed to the existing setup surface, never "stopped working" |

**Reset rule.** Any success: `consecutiveFailures = 0`, `failureEpisodes = 0`, `firstFailureAt = null`. The indicator clears itself; no dismissal needed. Identical to `objection-scan-tally.ts:75` and `alerts-schema.sql:502-507`'s `unhealthy_at` latch.

**Plus one narrow extra reset**, corrected from the first pass: on `aiKeys:save` of a **text-AI** key (never `DEEPGRAM_API_KEY` — saving a transcription key must not wipe a genuine text-AI failure indicator), clear only purposes whose `lastFailureReason` was `no-key` or `auth` — the reasons a new key plausibly fixes. A `rate-limit` streak is not cured by pasting an unrelated key. **Never reset on `aiKeys:clear`** — removing a key makes failure *more* likely; suppressing the signal there is backwards.

### 4.4 The UI

**A. Home banner — primary, one at a time (§3.4), not dismissible.** `MissingKeyBanner`'s per-session `useState` dismiss is too leaky for a condition that persisted two days; the precedents that get this right are `coachingPaused` (`LiveView.tsx:939-945`) and `BackupCard` — both render exactly as long as the condition holds. It survives restart because the *condition* is persisted, not the banner. Suppressed during a live call.

**B. The affected feature's own empty state — this is what makes it land.** `MemoryCenterSection.tsx:235-237` currently reads *"Nothing here yet — about you facts will show up as calls happen"*, which attributes emptiness to not enough calls; and `:196` hides the "N learned this week" card entirely when `weeklyCount === 0`, so the one number that would contradict it is absent exactly when it is diagnostic. When `memory-extract` is `failing`:

> Nothing here yet — and not because there was nothing to learn. Fact extraction has failed on its last 205 attempts (Gemini is rate-limiting your key). → *Open AI Setup*

A generic mechanism that leaves this line unchanged still ships the exact experience you had.

**C. Settings → Model Assignment rollup** — §3.3.

**Copy is actionable per cause.** An indicator that says "something's wrong" with no next step is the weak version you warned about:

| reason | message | action |
|---|---|---|
| `auth` | "Your Gemini key was rejected — it may have been revoked or mistyped." | AI Setup |
| `rate-limit` | "Gemini is rate-limiting your key. Adding a second provider's key lets this fall back instead of failing." | AI Setup |
| `model-not-found` | "Llama 3.3 70B is no longer available from Groq. Pick a different model for this job." | Model Assignment |
| `network`/`timeout` | "Couldn't reach Gemini — check your connection." | none |
| `failed` | generic + the provider's own `detail` verbatim | Model Assignment |
| `no-key` (+ no keys) | defers entirely to the existing setup surface | — |

Labels come from a shared `PURPOSE_LABEL: Record<AIPurpose, string>` resolved in main (same reasoning as `fallback-log.ts:79-83`), never the raw enum.

**Known limitation, stated rather than papered over:** `other` and `summary` each back several features (8 and 4 call sites), and jobs run concurrently — so a deterministically-failing *single* call site on those purposes can be masked by a sibling's success and will never trip. Requirement B is met for the reported bug because `memory-extract` is single-feature (call, chat, and onboarding extraction are all Sales Brain). Copy for `other`/`summary` must therefore stay purpose-level ("Post-call summaries"), never claim a specific feature. Feature granularity would need a caller tag on `AICompletionRequest` — out of scope, Q11.

---

## 5. THE SALES BRAIN SILENT-ZERO HOLE

Verified end to end, and it fired **twice this morning**. `extraction.ts:194-196` `catch { return [] }` swallows first, so `backfill.ts:177-179`'s per-call `catch` — commented *"one call's extraction failing must never abort the whole backfill"* — never sees an AI failure at all; it only catches `getCall()` I/O and `consolidateNewCandidate()` throws. `runBackfill` counts nothing, `backfill-ipc.ts:97` returns the hardcoded string `'Import complete.'`, and `JobManager` maps it straight to `Job.resultRef`. A run that scanned 99 calls, failed 99 AI calls, and stored zero memories is byte-identical on screen to a successful one — green "Import complete.", a full `99 / 99` progress readout, a green Activity Center check, and a success toast.

**Three small pieces:**

**(1) Make the outcome expressible.** In `extraction.ts`:

```ts
export interface ExtractionOutcome {
  candidates: MemoryCandidate[]
  /** True when the AI call itself failed, as opposed to succeeding and
   *  finding nothing worth keeping. A bare [] cannot tell those apart, and
   *  that is precisely how 205 failed extractions read as healthy "nothing to
   *  learn" runs (BUG-057) — including to the code that was supposed to
   *  notice.
   *
   *  This is deliberately RUN-LOCAL and does NOT duplicate PurposeHealth
   *  (ai/purpose-health.ts). The health store answers "is this feature broken
   *  in general?" and persists across restarts; this answers "did THIS call in
   *  THIS run fail?", which is what a per-run circuit breaker and a per-run
   *  summary need. A breaker fed by the global streak would abort a run on
   *  evidence inherited from yesterday. */
  aiFailed: boolean
  failureReason?: string
}
```

`extractMemoriesFromCall` (and its chat twin) returns `ExtractionOutcome`; the `catch` sets `{ candidates: [], aiFailed: true, failureReason }`. **The never-throw contract is unchanged.** Three call sites update: `memory-hooks.ts:111`, `memory-hooks.ts:141`, `backfill.ts:171`.

**(2) Tally and bound the run — by reusing the existing tally, not rebuilding it.** `src/main/objection-scan-tally.ts` already is a pure, Electron-free tally with `record(outcome) → 'continue' | 'stop'`, a 3-consecutive-failure breaker (`:79-83`), `itemsDone()`, and a `summary()` that already emits the literal `'stopped after repeated errors'`. The first pass imported its constant while duplicating the module — the inverse of the house rule. Instead: **parameterize its two nouns in place**:

```ts
export function createScanTally(
  opts: { noun?: string; skippedLabel?: string } = {}
): ScanTally
// objection scan (unchanged defaults): 'suggestion' / 'already being mined'
// backfill: { noun: 'new thing', skippedLabel: 'skipped (no transcript or excluded)' }
```

Backfill then emits, via a new `summary?: string` on the final `done` progress payload:

> `Scanned 99 calls, learned 37 new things`
> `Scanned 3 calls — every extraction failed (rate-limit), learned nothing. Stopped after repeated errors.`

`backfill-ipc.ts:97` becomes `return progressHolder.last?.summary ?? 'Import complete.'` — a two-line change, and the Activity Center row plus the settings card both get the real sentence for free. This morning it would have stopped each run after 3 calls instead of 99.

**(3) Make a total failure actually fail.** If the calls stage was requested and **`state().scanned === 0 && state().failed > 0`** — i.e. not one AI call succeeded — the executor throws. Corrected from the first pass's "zero memories created": a healthy run over calls that genuinely have nothing extractable produces zero memories and must not read as failure. Then `job.state === 'failed'` → red `AlertTriangle` + `job.error.message` + **Retry** in the Activity Center (`ActivityCenter.tsx:240,250,263-272`) + `toast.error` (`:75`). If contacts/deals succeeded, the job succeeds with an honest summary naming the failures — partial success is not failure.

**This is the piece that would have caught the bug on day one**, and it is fully independent of Parts 1-3.

Two adjacent instances of the identical swallow, scoped as follow-ups:
- `memory/onboarding.ts:137-139` `catch { return [] }` → `onboarding-ipc.ts:100-119` never checks the return, stamps `finishedAt` unconditionally, and `OnboardingInterviewModal.tsx:93` says **"All set — Sales Brain now knows the basics about your business."** The most natural "is this working?" test a worried user can run reports success and stores nothing.
- `memory-hooks.ts:27-28` `if (newCount === 0) return` is correct as written, but must not swallow the *failed* case once `aiFailed` is distinguishable.

---

## 6. PHASED PLAN

Every phase changes something a user can observe. Within a phase, one commit per distinct bug.

| # | Phase | Commits | Closes | Gate |
|---|---|---|---|---|
| **P1** | **Legacy fallback tail** | (a) `resolveChain` tail + partition + `LEGACY_TAIL_MAX` + `fromImplicitTail` + `clearTimeout` + `auth` short-circuit + `defaultModelId`; (b) `memory-extract` → `EXTRACT_CHAIN` | Defect A | New `resolveChain.legacy.test.ts` green; `resolveChain.test.ts`, `chainBudget.test.ts`, `latencyPolicy.test.ts`, `streamWithFallback.test.ts` unchanged and green |
| **P2** | **Sales Brain honest zero** | one | The day-one catch | `backfillTally.test.ts`; manual: bad key + "Also scan past calls" → red failed job after 3 calls, not green "Import complete." after 99 |
| **P3** | **Health store + Settings rollup** | (a) `purpose-health.ts` + store + IPC; (b) Model Assignment rollup + copy fix | Makes the condition knowable **and visible in Settings** | `purposeHealth.test.ts`; manual: force failures, see the rollup |
| **P4** | **Home banner + honest empty states** | (a) banner + aggregation + live suppression; (b) Memory Center empty-state variant | Requirement B, "impossible to miss" | Manual scenario §7.4 |
| **P5a** | `ASSIGNABLE_PURPOSES` + preload `AiPurpose` widened to 12 | one | A **silent write-failure bug**: `catalog-ipc.ts:45,63` return unmodified settings, which `ModelAssignmentSection.tsx:326` adopts as truth — the picker for Sales Brain extraction and coaching chat no-ops with no error | Manual: assign a model to Sales Brain extraction and see it stick |
| **P5b** | Onboarding interview honesty | one | Same bug class as P2 | Manual: bad key → interview does not claim "All set" |
| **P5c** | Stale copy/docs (`types.ts:47-51`, `ModelAssignmentSection.tsx:289-292`, `settings-nav.ts:82`); optional rename of `objection-scan-tally.ts` → `run-tally.ts` | one | Cleanup | — |

**Earliest close of the live correctness gap: P1.** Smallest diff, one function, provably zero effect on live-latency paths, stops the data loss.
**Earliest *detection*: P2**, which is fully independent — if you want detection before resilience, P2 can ship first.

**Why P1's two commits land together:** commit (a) alone, on your current config, turns 1 doomed Groq attempt into 3 doomed Groq attempts and recovers nothing. It is correct and it is not shippable alone.

---

## 7. VERIFICATION

Red-check discipline: each test states what **must fail** if the fix is reverted.

### 7.1 P1 — `src/main/ai/__tests__/resolveChain.legacy.test.ts` (new file, required)

A new file, not an addition: `resolveChain.test.ts:13` has `vi.mock('../index', () => ({ getActiveAIProvider: () => null }))`, which mocks the legacy branch out of existence. **Lines 155-156 are executed by zero tests today.**

| test | assertion | MUST FAIL on revert |
|---|---|---|
| tail exists | `aiProvider: 'groq'`, `memory-extract` `[]`, keys groq+google+openrouter → `length > 1` | **Yes** |
| legacy stays at index 0 | `[0].catalogId === 'legacy:groq'` | No — permanent regression guard for M16 parity |
| different provider first | `[1].providerId !== 'groq'` | **Yes** |
| at most one same-provider entry | `filter(s => s.providerId === 'groq').length <= 1` (excluding the head) | **Yes** |
| **no duplicate of the legacy model** | no step has `modelId === PROVIDER_REGISTRY['groq'].defaultModelId` | **Yes** — this is the single-key user's wasted request |
| key filter honored | only `GROQ_API_KEY` set → every step is groq | No — guards A2 |
| `knownStale` never in tail | no `groq-llama-4-scout` / `groq-qwen3-32b` | No — guards `:132-143` |
| caps | background ≤ 4 total; `other`/`coaching-chat` ≤ 2 | **Yes** |
| **live purposes unchanged** | `coaching-cue` with `chain: []` returns exactly `[legacy]` | No — anti-regression guard for M9/M24 |
| no-legacy branch unchanged | `getActiveAIProvider → null` → identical to today (except `memory-extract`, asserted separately) | No |
| `auth` short-circuit | first step throws `auth` → remaining same-provider steps never built (spy on `build`) | **Yes** |
| P1(b) | `resolveChain('memory-extract')` with groq+google+openrouter yields **≥2 distinct providers** | **Yes** |

Also amend `chainBudget.test.ts` to assert on **`resolveChain()`'s output**, not only on the `DEFAULT_CATALOG_CHAIN` constant (`:52-59`) — today's assertion cannot catch a resolution-time cap violation.

### 7.2 P2 — `src/main/memory/__tests__/backfillTally.test.ts`

| test | MUST FAIL on revert |
|---|---|
| `aiFailed: true` when `completeWithFallback` rejects | **Yes** — reverted returns a bare `[]` |
| `aiFailed: false, candidates: []` when the AI succeeds and finds nothing | **Yes** — indistinguishable when reverted |
| summary for 42 calls / 0 failures / 37 memories reads "learned 37 new things" | **Yes** — reverted is a constant |
| all-failed summary names failures + "stopped after repeated errors" | **Yes** |
| breaker stops after 3 consecutive `aiFailed` (spy: 3 calls, not 42) | **Yes** |
| contacts succeed + calls all fail → job **succeeds** with an honest summary | **Yes** |
| calls requested, **zero successful AI calls** → executor throws | **Yes** |
| **calls requested, all succeed, zero candidates → job succeeds** | No — guards against the first pass's wrong throw condition |

### 7.3 P3 — `src/main/ai/__tests__/purposeHealth.test.ts` (pure, no Electron)

| test | MUST FAIL on revert |
|---|---|
| 3 failures then 1 success → `consecutiveFailures === 0`, `failureEpisodes === 0` | **Yes** |
| **99 failures inside 26 seconds → `failureEpisodes === 1`, `severityOf === 'ok'`** | **Yes** — the burst case, from the real log |
| **3 failures inside 60s, evaluated 3 hours later → still `'ok'`** | **Yes** — this is the exact assertion the first pass's design would have shipped green while being wrong |
| 3 episodes spanning 20 min → `'failing'` | **Yes** |
| last failure 4 days ago → `'ok'` regardless of count | **Yes** |
| 1 episode + last success 3 days ago → `'ok'` (the Friday-blip case) | **Yes** |
| 2 episodes + never any success + first failure 49h ago → `'failing'` | **Yes** — the never-worked user |
| `featureEnabled: false` → `'ok'` even mid-streak | **Yes** |
| `no-key` + no text keys → `'not-configured'`; `no-key` + keys present → `'failing'` | **Yes** |
| 2 `fromImplicitTail` successes spanning 30 min → `'substituting'` | **Yes** |
| 2 successes at `chainIndex > 0` but `fromImplicitTail: false` → `'ok'` | **Yes** — the authored-chain case |
| a success at `chainIndex 0` clears `substitutingSince` | **Yes** |
| **precedence**: `substitutingSince !== null` **and** 3 failure episodes → `'failing'` | **Yes** — replaces the first pass's vacuous "cannot be both" test |
| replayed against the real 205-event log fixture → `'failing'` first at `2026-08-12T20:19:47Z` | **Yes** |

### 7.4 Manual scenarios

**P1 (resilience).** Point `GOOGLE_AI_API_KEY` at a deliberately invalid value (→ `auth`, deterministic, no waiting on a real rate limit), set `aiProvider: 'google'`, keep the real Groq/OpenRouter keys, `memory-extract` chain `[]`. Run a call with Sales Brain on. **Expect:** memories appear; `ai-fallback-events.jsonl` shows `legacy:google → <a non-google catalogId>` — a **non-null `toCatalogId`**, which today is *always* null. **Reverted:** zero memories, `toCatalogId: null`.

**P3/P4 (surfacing).** Invalidate every text-AI key. Run 3 calls over ≥15 minutes. **Expect:** one Home banner naming the provider and the reason with a next step; the Memory Center empty state changed to the failure variant; the Settings rollup showing episode count, attempt count, and since-when. Then save a valid key → banner clears **without a reload** (`aiHealth:changed`) and the streak resets. Then navigate to Home mid-call → **no banner**.

**P2 (honest zero).** With every key invalid, run "Import now" **with "Also scan past calls" ticked**. **Expect:** a red failed job with a Retry button and a summary naming the failures, stopped after 3 calls. **Reverted:** green "Import complete.", a full `99 / 99` readout, 99 wasted requests — which is literally what happened at 10:46 and 11:39 today.

---

## 8. OPEN QUESTIONS — every one with a recommendation

**Q1. `coaching-cue` and `deal-tier1` get no fallback tail. Agree?**
**Recommend: yes, keep 0.** It makes P1 provably zero-risk on the live paths; those two are the only purposes whose exhaustion is *already* visible (the LiveView banner); the log shows exactly **1** `coaching-cue` failure in three days. And per fact (2) both already have configured 2-entry chains on your machine, so this branch is unreachable for you. Reversible later with a latency measurement.

**Q2. Widen `memory-extract` past the speed lane (§2.3), accepting that its bundled-only chain grows to ≤10 attemptable entries (vs `summary`'s existing 9)?**
**Recommend: yes.** Without it P1 is cosmetic on your config. Cost: quality-lane models are slower and pricier for a per-call job — but it is fire-and-forget on the BATCH lane, so latency is free, and the alternative is learning nothing.

**Q3. `auth` failures skip every remaining step on the same provider — including inside your *configured* chains?**
**Recommend: yes.** An invalid key fails identically on every model of that provider, so those attempts are guaranteed-doomed. This is the change that makes A2's "just slower failure" false in the most common broken-key case. It does alter behavior for configured chains (your `scorecard` chain has 3 Groq entries), but only ever by *skipping* attempts that cannot succeed. Deliberately **not** extended to `rate-limit` — Groq and Gemini rate-limit per-model, so a different model on the same key really can work. If you know your Gemini quota is project-wide, tell me and `rate-limit` joins it.

**Q4. Tail sizes: 0 / 1 / 3?**
**Recommend: as tabled.** 4 total attempts crosses 2-3 providers on a typical key set while a doomed call costs 4 requests instead of 9. Note the cap deliberately does **not** apply to the bundled-only branch (fresh installs keep today's up-to-9) — change only what we mean to change.

**Q5. Is the failure banner dismissible?**
**Recommend: no** — it clears when the condition clears (`coachingPaused` / `BackupCard` precedent), and is suppressed during live calls. "Impossible to miss" and "dismissible" are in tension, and `MissingKeyBanner`'s per-session dismiss is too leaky for a 2-day condition. If it proves annoying, the right escape hatch is snooze-until-the-condition-changes, never a permanent dismiss.

**Q6. Does Tier 1 (sustained implicit-tail substitution, nothing actually broken) belong on Home, or Settings only?**
**Recommend: Home, in information tone, not warning tone.** With `fromImplicitTail` it is now rare by construction — it fires only when a provider you chose is down long enough that models you never picked are carrying the feature, which is precisely A1's sentence. **This is still the closest call in the document**; Settings-only is defensible and halves the noise budget.

**Q7. Add `defaultModelId` to `ProviderRegistryEntry`?**
**Recommend: yes** — reversed from the first pass. Verified that 6 of 8 providers' defaults are byte-identical to a catalog `modelId`, and the duplicate is *not* truncated away for exactly the single-key user A2 protects. Hoisting the config objects means zero duplicated string constants.

**Q8. Add `served` to `AICompletionResult` for per-artifact provenance ("which model wrote this summary")?**
**Recommend: defer.** This design does not need it; it is two non-breaking lines whenever it becomes a real requirement. **But flag:** deferring it, plus Tier 0 being log-only, means A1's literal "Something like 'Google unavailable, used Groq'" is delivered as an *aggregate, sustained* notice rather than a per-call one. That is a narrowing of your words and it needs your explicit sign-off, not my judgment.

**Q9. Is fixing `ASSIGNABLE_PURPOSES` in scope?**
**Recommend: yes, as P5a, and treat it as its own bug** — the picker for Sales Brain extraction and coaching chat resolves successfully, returns unmodified settings, and the UI adopts them as truth. Silent write failure. Needs `src/preload/index.d.ts:1720`'s `AiPurpose` widened to 12 first. Note the *framing* correction: this is not why your chains are empty — `DEFAULT_MODEL_ASSIGNMENTS` is empty for all twelve purposes by default, so empty is simply the unconfigured state.

**Q10. Did you switch `aiProvider` to `groq` at ~15:23 today, or did `maybeAutoSelectProvider` (`ai-keys.ts:98-104`) flip it?**
**Recommend: check, low stakes but worth knowing.** If it flipped automatically, that is a third silent behavior — your default provider changing under you with no notice — and it belongs on the list.

**Q11 (new). Should `other`/`summary` get per-feature health granularity (a caller tag on `AICompletionRequest`)?**
**Recommend: no, not now.** It is a real limitation (§4.4) but requires touching 12 call sites for purposes that all have configured chains on your machine. Revisit if a specific feature on those purposes ever fails silently.

---

## RESIDUAL RISK & WHAT STILL NEEDS EMPIRICAL VERIFICATION

Honest list. Nothing here blocks approval; all of it should be checked against the running app during the phase it belongs to.

1. **Is `memory-extract` still failing right now?** Every one of the 205 events says `legacy:google`; `aiProvider` is now `groq`, and Groq also rate-limits on this machine (55 + 16 events). The condition may be live, self-resolved, or merely relocated. **First thing to check in P1's manual run.** Note that with `chain: []` and `aiProvider: groq`, extraction is currently one attempt against an account the log shows failing on other purposes.
2. **Sub-second failure cadence vs. `EPISODE_GAP_MS`.** 60 seconds is calibrated on this log (196 of 204 inter-event gaps are under 2 seconds, and every real burst is a backfill). A provider that fails on a 90-second retry cadence would register as separate episodes and could trip in 3 × 90s ≈ 4.5 min — under the 15-minute span floor, so it still would not trip. I believe the pair of guards is robust; it is calibrated on one machine's data.
3. **`fromImplicitTail` correctness for the bundled-only branch.** I set it `false` there on the argument that no "primary" exists to substitute for. If a fresh-install user's first bundled entry chronically fails, they get no substitution notice. I think that is right (they chose nothing); it is a judgment, not a proof.
4. **Concurrency in the health store.** Jobs run concurrently (`LIVE: Infinity`, `INTERACTIVE: 2`) and `crm-note-generator-ipc.ts:118` fires two `other` calls via `Promise.all`. The in-memory-Map-authoritative + serialized-write design should hold, but it needs a deliberate test with overlapping records, not just sequential ones.
5. **`FallbackEvent` shape vs. the preload ambient type.** If the Settings rollup adds any field to the JSONL, `src/preload/index.d.ts`'s `AiFallbackEventView` (`:1523-1533`) must move in lockstep; nothing enforces that. Old lines parse fine, but a single malformed line takes `readRecentFallbackEvents` to `[]` via `.map(JSON.parse)` — worth a per-line try/catch while touching that file.
6. **Deliberately not fixed, pre-existing:** `streamWithFallback` has no `CHAIN_BUDGET` handling and does not forward `req.signal` (`:316-318`); `coaching-chat.ts`'s 5s race (`coaching-chat-ipc.ts:125-132`) is a bare `Promise.race` with no abort, so a losing chain runs to completion as orphaned spend. Both already exist today for configured and bundled chains. In scope only if you want them.
7. **`prep-brief` has no consumer** (`prep-brief.ts:151` passes `purpose: 'summary'`) yet is assignable and rendered as a card. Not a defect in this design; noted so nobody "fixes" it later by accident.