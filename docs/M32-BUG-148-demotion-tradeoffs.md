# BUG-148 — demotion policy: the tradeoffs

**M32 Stage 1b. Decision document. No code has been written.**
Written 2026-08-31 against `claude/m32-trust-evidence` @ `98d02ab`.

---

## What is actually broken

The chain *does* fall back within a single call. What it does not do is **learn between
calls**. A default provider whose key is rejected is attempt #1 on every call, for every
purpose, forever:

- `deadProviders` is declared **inside** the walk (`complete-with-fallback.ts:1078`) and
  dies with it.
- `markStructurallyBroken` **explicitly skips `auth`** (`:1238`), on the reasoning that
  auth "already gets a coarser, PROVIDER-wide skip" — which is true, and lasts exactly one
  walk.

So nothing persists, and `resolveConfiguredChain` rebuilds the identical order every time.
One guaranteed-doomed request per call, per purpose, until a human notices.

---

## The finding that reframes the whole thing

**Demote by REORDERING, never by REMOVING.**

The founder's stated trap — *"nothing ever retries a demoted provider"* — is real, and it
is a property of removal, not of demotion. A provider moved to the **back** of the chain is
still attempted whenever everything ahead of it fails. That single choice buys:

- **No orphaning.** It cannot get permanently stuck, because it keeps being tried.
- **A free restoration signal.** A success from the back of the chain is exactly the
  evidence needed to clear the demotion. No TTL guesswork required to generate it.
- **No new failure mode.** The worst case is the order we have today.

Every option below assumes reordering. Removal is not offered, because it is the version
that needs a TTL to be safe and still leaves the user worse off during an outage.

---

## ⚠ A FIFTH DECISION, not in the original four

**On `coaching-cue` and `deal-tier1` — the two purposes where you said this hurts most —
reordering alone is a NO-OP, and I would rather say so now than ship a fix that misses
them.**

`LEGACY_TAIL_MAX` is `0` for both, and `resolveConfiguredChain` short-circuits:

```ts
if (tailMax === 0) return [legacy]
```

The chain is *exactly one step long*. There is nowhere to demote to. The pre-walk rescue
does not help either: it fires only when `chain.length === 0`, and this chain has length 1.

So for the live paths, BUG-148 is only fixed if a demoted legacy step lets **one bundled
step take the lead in its place**. That is a real change to the live-call budget, which is
why it is a decision and not an implementation detail.

| Option | What happens mid-call | Cost |
|---|---|---|
| **5A. Leave them at 0** | Nothing changes for `coaching-cue`/`deal-tier1` | The fix skips the two purposes you called worst. Honest, and cheap, but partial |
| **5B. While demoted only, allow 1 bundled step to lead** *(recommended)* | A rejected default is replaced by one working model; the chain is still length 1 | The live budget is unchanged (still one attempt), but the attempt is now one that can succeed. Requires care that "while demoted" cannot leak into the normal path |
| **5C. Raise `LEGACY_TAIL_MAX` for live purposes** | Two attempts mid-call | Rejected on its own merits: `CHAIN_BUDGET` exists so a miss never means dead air. Do not spend the live budget on this |

**Recommendation: 5B.** It keeps the live path at exactly one attempt — the property
`CHAIN_BUDGET` protects — and only changes *which* one. A demoted step is one we have
positive evidence cannot succeed, so swapping it costs nothing and gains everything.

---

## Decision 1 — what counts as "keeps failing"

The codebase already contains a calibrated answer to this question for a *different*
signal. `purpose-health.ts` uses `FAILURE_EPISODE_LIMIT = 3` with `EPISODE_GAP_MS = 60_000`
— explicitly tuned against your real 205-event log so that a backfill loop producing 99
failures in 26 seconds counts as *one* episode, not 99.

**But auth is not that kind of signal.** Episode-gapping exists to avoid over-counting
bursts of *transient* failures. A 401 is deterministic: the same credential will be
rejected again, immediately, every time. Waiting for three episodes over three minutes is
protecting against a variance that auth does not have.

| Option | Doomed requests before it stops | Risk |
|---|---|---|
| **1A. One auth rejection** | 1 | A single misclassified error demotes. Fastest, most exposed to `classifyReason` being wrong |
| **1B. Two auth rejections on separate walks** *(recommended)* | 2 | One extra doomed request **in total**, not per call. Immune to a one-off misclassification |
| **1C. Three episodes, 60s apart (reuse purpose-health's numbers)** | 3+, spread over ≥2 min | Consistent with existing tuning, but slow for a signal that is deterministic. Mid-call, 2 minutes is several cues |

**Recommendation: 1B**, and only ever on `reason === 'auth'` — never on rate limits, quota
exhaustion, timeouts or 5xx. Those already have cooldowns built for them and are about
capacity, not about the credential being wrong.

**This is what dissolves your "punishes a restored key" concern**, and it is newly possible
because of Stage 1a: **saving a key now validates it**. So the restore path can clear the
demotion the instant a good key is saved — the user fixes the key and the demotion is gone
before they leave the screen. That hook did not exist a week ago.

---

## Decision 2 — how long a demotion lasts

Given reordering, the demotion clears itself through evidence rather than a clock:

1. **Any success from that provider clears it.** Guaranteed to be reachable, because a
   reordered step is still attempted.
2. **A successful key save/validation clears it immediately** (Stage 1a's `probeKey`).
3. **A TTL as a backstop only** — proposed 4h, the same `STRUCTURAL_BREAK_MS` this module
   already chose, for the same stated reason: nothing wires a manual clear, so a
   wrongly-classified break must be able to expire on its own.

### Persist to disk, or keep in memory?

**Recommendation: in memory, matching `model-cooldown.ts`'s existing deliberate stance.**

Two reasons, and the second is yours:

- The reported harm — "attempt #1 on every call" — is entirely within a session. In-memory
  fixes it completely.
- **A persisted demotion is a claim about the past presented as the present.** That is
  precisely the reasoning you used an hour ago to decline persisting key verdicts. A
  provider that rejected us last Tuesday is not necessarily rejecting us now, and a restart
  is a natural, honest boundary at which to stop assuming.

---

## Decision 3 — per-purpose or global

The codebase scopes structural breaks **per purpose** (`breakKey(purpose, catalogId)`) with
good reasoning: *"A break proven by ONE purpose's request says nothing about whether a
background summarisation job can use the model."* That reasoning is about **request shape**
— a tool-schema 400, a model that cannot do this kind of call.

**Auth is not request-shaped. A credential is either accepted or it is not, and that is
identical for every purpose.** The code already agrees: `deadProviders` is provider-wide
within a walk, and the comment at `:1239` calls auth's treatment "a coarser, PROVIDER-wide
skip".

**Recommendation: global, per provider — for auth only.**

The practical argument is stronger than the theoretical one: with per-purpose scoping,
`coaching-cue` would have to fail on its own, **mid-call**, before it learned anything —
the worst possible place to gather evidence. Global means a summary that fails at 09:00
protects the 10:00 call.

---

## Decision 4 — hard pointer, or a preference the scheduler may override

This is the product decision, and I want to narrow what is actually being asked, because
the honest version is less invasive than it sounds.

**Nothing here proposes changing your stored setting.** `aiProvider` keeps pointing exactly
where you pointed it. What changes is only the **order of attempts**, and only while we
hold positive evidence that the provider is rejecting our credential.

| Option | Behaviour | Cost |
|---|---|---|
| **4A. Hard pointer (today)** | The default is always attempted first, no matter what | Every user with one bad key pays a doomed request per call, forever. This is the bug |
| **4B. Silent preference** | The scheduler reorders on evidence, says nothing | Fixes it, and the app now does something other than what the screen says. Species 44 — an automatic change to user-visible behaviour that is never announced |
| **4C. Preference + visible state** *(recommended)* | The scheduler reorders on auth evidence, and **the app says so**: the Settings card shows the provider is being skipped and why, with "Test key" right there | One more piece of UI to build and keep honest |

**Recommendation: 4C.** BUG-143's fix already set this precedent — auto-selection reports
what it did rather than doing it silently — and Stage 1a's whole thesis is that the app
must not quietly know something the screen contradicts. A demotion the user cannot see is a
second hidden state, which is the thing this milestone exists to remove.

Framed plainly: **we are not overriding your choice. We are declining to spend the first
attempt of every call on a credential the provider just told us is invalid, and we are
telling you that we did.**

---

## What building this touches

- `resolveConfiguredChain` — ordering only (`complete-with-fallback.ts:331`).
- The walk's `auth` branch (`:1190`) — record the rejection instead of discarding it.
- A small demotion store beside `model-cooldown.ts`, in-memory, same shape as the maps
  already there.
- A clear-on-success hook, and a clear-on-key-save hook into `probeKey`'s result.
- Settings copy for 4C.

**Blast radius: 36 test files reference this chain**, and `complete-with-fallback.ts` is the
most heavily pinned file in the repo. The specific hazard is that this changes **which step
is attempted first**, and ordering is exactly what a `toEqual`→`toContain` "correction" got
wrong here on 2026-08-30. Every ordering assertion gets red-checked against the ORDER, not
the membership.

---

## The recommended set, in one line each

1. **Two auth rejections on separate walks**, auth only.
2. **Clears on any success, on a validated key save, and on a 4h backstop. In memory.**
3. **Global per provider**, because a credential is not purpose-shaped.
4. **A preference the scheduler may override on auth evidence — visibly.** The stored
   setting never changes.
5. **5B** — while demoted, one bundled step may lead on `coaching-cue`/`deal-tier1`, or
   those two purposes are not fixed at all.
