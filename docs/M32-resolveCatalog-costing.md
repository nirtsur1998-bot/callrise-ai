# `resolveCatalog` — costing the live availability check

**M32 Stage 1e. A costing, not a fix. No code has been written.**
Written 2026-08-31 against `claude/m32-trust-evidence` @ `b41783c`.

---

## The founder's framing, and where it needs correcting

> *"`resolveCatalog` checks model liveness and gates NOTHING. It labels the Settings
> picker while the chain reads a static `knownStale` flag, so the protection that flag is
> credited with does not exist at runtime for anything detected live."*

**The first half is exactly right. The second half overstates the exposure, and the
difference is the whole decision.**

`resolveCatalog` really does compute a live `available` per model and really does throw it
away for runtime purposes — its only consumer is the Settings picker's IPC
(`catalog-ipc.ts:132`). Nothing in `resolveConfiguredChain` ever reads it. That is true and
it is worth having found.

**But the chain is not unprotected — it is protected REACTIVELY rather than PROACTIVELY,
and that was already built.** Checked rather than assumed:

- a delisted model answers with a 404 / "no such model";
- `classifyFailureClass` maps `model-not-found` → `'structural'` (`failure-class.ts:31`);
- the walk's catch does `failureClass === 'structural' && reason !== 'auth'` →
  `markStructurallyBroken(...)` (`complete-with-fallback.ts:1238`);
- `STRUCTURAL_BREAK_MS` is **4 hours**, per `(purpose, catalogId)`.

**So a model that dies without anyone editing `knownStale` costs ONE failed request per
purpose per four hours, and then benches itself.** It is not attempted "forever". The
`knownStale` flag is an optimisation that saves the *first* request; the safety net under
it already exists.

### What the gap actually costs, per shape

| Shape | Real cost today |
|---|---|
| Durable purpose (`summary`, tail 3) | 1 wasted attempt, then the chain moves on within the same call. User sees nothing. |
| `coaching-cue` / `deal-tier1` (tail 0) | **1 missed cue**, then benched 4h. This is the only case that reaches the user. |
| Every purpose, after the first failure | Nothing, for 4 hours. |

**The honest exposure is: up to one missed live cue per dead model per four hours.** Worth
knowing. Not worth a rewrite of the hot path, which is what the rest of this costs out.

---

## What wiring the async check in would actually take

### Option A — make `resolveConfiguredChain` async

The literal reading of "wire the async check into the sync path".

- `resolveChain` → `resolveConfiguredChain` is called by `completeWithFallback` and
  `streamWithFallback` (both already async, so they could await) **and** by
  `capacity.ts`'s `hasUsableAiCapacity`, which is used to decide whether to defer
  background jobs.
- **The cost that kills it: a cold cache.** `resolveCatalog` caches for **10 minutes**
  (`CACHE_TTL_MS`). On a miss it issues **one `listModels()` HTTP round-trip per keyed
  provider** — up to 11 — and awaits all of them. `coaching-cue` has a **6-second total
  budget** and re-resolves every few seconds mid-call. The first cue of a call that starts
  more than ten minutes after the last Settings visit would spend its entire budget on
  catalog HTTP.
- **Blast radius:** 36 test files reference this chain; every one that calls
  `resolveConfiguredChain` synchronously would need updating.

**Verdict: no.** It converts a rare one-missed-cue into a reliable all-cues-missed at the
start of a call, which is strictly worse on the exact path the founder cares about.

### Option B — background refresh, synchronous read

Keep `resolveConfiguredChain` synchronous. `resolveCatalog` already computes `available`;
have it also write a module-level `Set<catalogId>` of live-unavailable entries, and have
the chain read that Set **synchronously** — a `Set.has`, no await, no latency.

- **Cost at call time: effectively zero.**
- **The real work is deciding when to refresh**, and this is where the option stops being
  cheap. Today `resolveCatalog` runs only when the user opens Settings. To be useful the
  Set needs refreshing on a schedule (app start + every N hours), which means: a new
  background job, N HTTP calls on a timer whether or not the user is doing anything, and a
  new decision about what happens when those calls fail (`listModels` returning null is
  already handled as "can't confirm" — that must NOT be read as "unavailable", or a
  provider with a flaky `/models` endpoint gets its whole roster benched).
- **What it breaks:** nothing structurally. The risk is behavioural — a false
  "unavailable" now removes a model from the chain *before* it is ever tried, which is a
  strictly stronger action than today's "try once, then bench". A wrong answer costs more.

**Verdict: viable, and the only option that delivers what was asked. Cost is roughly a day,
most of it in the refresh policy and its failure semantics, not in the read.**

### Option C — do nothing to the chain; tighten the reactive path

Accept that the first request is the check, and make the bench that follows it better:

- **Make the structural break for `model-not-found` GLOBAL rather than per-purpose.** A
  model that does not exist does not exist for any purpose — this is the same reasoning
  BUG-148 used for auth. Today `coaching-cue` must independently discover it mid-call even
  if `summary` found out an hour ago. **This single change removes most of the user-visible
  exposure**, because the live paths would inherit the discovery made on a durable path.
- Optionally surface it: the Settings picker already knows (`available: false`) — it could
  say "this model is not on your provider's current roster" more loudly than a label.

**Verdict: ~2 hours, no new subsystem, no timers, no new failure mode. Removes the cue-loss
case that is the only part reaching the user.**

---

## Recommendation

**Live with the gap, and take Option C.**

The documented protection is not absent — it is reactive, and it already bounds the damage
to one failure per purpose per four hours. The part that actually reaches you is a missed
live cue, and that exists only because the structural break is scoped per purpose. Making
`model-not-found` global costs a couple of hours and closes it, without a timer, without
background HTTP, and without touching the 6-second hot path.

**Option B stays available** if you later want a model to be skipped *before* its first
failure rather than after — but note it buys one request, and pays for it with a
permanently running refresh loop and a new class of wrong answer (benching a live model
because its provider's `/models` endpoint was flaky).

**Option A should be closed off explicitly**, so nobody re-derives it: it makes the live
path strictly worse.

## What is NOT in this costing

- No measurement of how often a catalog model actually goes stale in practice. The two Groq
  ids confirmed dead on 2026-08-30 are the only data points, and both were found by hand.
  If that is the true rate — twice in a month, caught by a human — the reactive path is
  amply sufficient and Option C is generous.
- No packaged-build verification of any of this. It is a reading of the code.
