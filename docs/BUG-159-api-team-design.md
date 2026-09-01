# BUG-159 — "like a team": every configured key covers for every other

**Status: designed, NOT implemented. Three implementation attempts were made and
all three were reverted, for reasons recorded below so the next attempt starts
from the constraints rather than rediscovering them.**

Founder, 2026-09-01:

> "I want all keys to work and if one fails for the system to direct the work to
> it and won't deny a job from the user and have any failures (EVEN WITHOUT A
> PAID API)."
>
> "If a user has 10-12 active APIs in his CallRise account and one fails, the
> rest should cover for his job and do the heavy lifting for him. Like a team."

---

## What is measured today

Against the founder's real key set (anthropic, cloudflare, groq, huggingface,
with huggingface pinned as the default provider):

| purpose | steps | providers reachable in one walk |
|---|---|---|
| **coaching-cue** | **1** | huggingface |
| **deal-tier1** | **1** | huggingface |
| other | 2 | huggingface, groq |
| coaching-chat | 2 | huggingface, groq |
| the other nine | 4 | huggingface, groq, cloudflare, anthropic |

Nine of thirteen features already behave like a team. The two that do not are
exactly the two reported broken, and the single provider they are pinned to is
the one out of quota and returning malformed structured output.

Pinned by `bug159-no-single-point-of-failure.test.ts`, which enumerates purposes
from `LATENCY_POLICY` (an exhaustive Record over `AIPurpose`) so a purpose added
later is covered without editing the test.

**Cues are not dead.** `ai-purpose-health.json` at the time of the founder's
report: `substituteSuccesses: 8`, and a success 16 seconds before the failure
they screenshotted. `groq-gpt-oss-120b` intermittently returns
`400 Tool choice is required, but model did not call a tool`. With a one-step
chain, every such flake is a missed cue.

---

## The four changes the goal needs

1. **`LEGACY_TAIL_MAX` 0 → 1 for the two live purposes.** `CHAIN_BUDGET` already
   declares `maxChainLength: 2` for them; `LEGACY_TAIL_MAX: 0` meant the second
   budgeted attempt could never be spent whenever a default provider was pinned.
   The two tables disagreed and the stricter silently won. Latency is unaffected:
   `completeWithFallback` divides `remainingBudgetMs` by remaining entries, so
   two attempts share the 6s rather than doubling it.

2. **An UNUSABLE default must give up the front, not only an auth-demoted one.**
   BUG-154's substitution lives inside the `tailMax === 0` branch, which change 1
   skips entirely — so without this, an exhausted or cooling default silently
   leads again. Demotion is provider-scoped (a rejected key), usability is
   step-scoped (a cooling model); both must be consulted.

3. **`SPEED_CHAIN` must reach every provider.** It excludes `google` and
   `openrouter` outright, so a user holding only those keys has no cue fallback
   at all — the same gap `zai`/`huggingface` had before BUG-154. Quality-lane
   models on a live path is a deliberate last resort, bounded by the 6s budget.

4. **A benched model must not squat the capped tail slot.** The tail is 1–3 slots
   and a benched step holds one forever: the walk skips it at attempt time, so it
   never fails again in a way that would move it, and everything behind it is
   unreachable. Measured: with four keys configured, coaching-cue "never
   attempted despite holding a key: anthropic, huggingface".

Changes 1–3 are self-contained. **Change 4 is the hard one** and is what sank
all three attempts.

---

## Why change 4 is hard: it collides with the capacity signal

`hasUsableCapacityForPurpose` (ai/capacity.ts) reads the SAME resolution:

```js
const { capable } = resolveChain(purpose, { needsTool: true })
if (capable.length === 0) return true      // "nothing configured" => capacity exists
return capable.some((step) => isUsableFor(step.catalogId, now, tier, { purpose }))
```

That early return is correct for its own question ("is this user set up at all?")
and fatal to any change that shortens the chain.

**Attempt A — filter unusable steps out of the tail.** Works for reachability.
Breaks capacity: the chain goes empty exactly when everything is cooling, hits
`capable.length === 0`, and returns `true` — capacity EXISTS — precisely when
there is none. Background jobs stop deferring and hammer providers. Caught by
`capacityForPurpose.test.ts` (`expected true to be false`). This is the failure
mode that actively harms the user, and it is why none of this shipped.

**Attempt B — reorder unusable steps to the back instead (BUG-148's own "reorder,
never remove" principle).** Keeps every step present, so capacity still sees the
full set. Still breaks the same tests, because `.slice(0, tailMax)` truncates a
REORDERED list — membership changes even though nothing was deleted.

**Attempt C — change 1 alone, no tail changes.** Capacity stays clean. Cost: 12
tests across `bug148-demotion`, `resolveChain.legacy`, `modelCooldown` and
`bug159` encode the one-step contract and need coordinated updates. `bug148`'s
describe block is literally titled "decision 5B", the founder's own call of
2026-08-31 — reversing it is legitimate now that the founder has weighed a missed
cue as worse, but it is a deliberate edit, not a sweep.

---

## The shape of a correct fix

The collision is not really between reachability and capacity. It is that ONE
function answers two different questions from one resolution:

- *which steps should this walk attempt, in what order?* — wants unusable steps
  demoted or dropped
- *does this purpose have any capacity at all right now?* — wants the complete
  configured set, unfiltered

**Separate them.** Give capacity its own view — the full configured chain,
unordered, unsliced — and let the walk's view be filtered/reordered freely. Then
change 4 is unblocked and `capable.length === 0` recovers its original meaning
("no keys configured"), which is the only thing it was ever supposed to mean.

Concretely: an exported `configuredStepsFor(purpose)` that returns every
credentialed, non-stale step ignoring cooldowns, used by `capacity.ts`; and
`resolveChain` free to order and cap for the walk.

## What to verify, whatever the implementation

1. `bug154-eventually-tries-every-key` passes for **coaching-cue as well as the
   durable purposes** — that is the founder's requirement, executable.
2. `capacityForPurpose.test.ts` stays green, especially "goes false for an
   exhausted chain". Red-check it: a capacity signal that cannot go false is the
   harmful failure.
3. `modelCooldown`'s six "attempt nothing while cooling" assertions. These are
   too COARSE rather than wrong — they assert the whole attempt list is empty,
   while each test's own title is about ONE model not being retried. Verified
   during this session: the models attempted after the change were
   `groq/openai/gpt-oss-120b` and `openrouter/(provider default)` — neither is
   the model that was cooled. There is in-repo precedent for exactly this
   correction (`deadProvidersPhase2`: "CORRECTED, NOT RELAXED (BUG-142) ... the
   guarantee in its own title is about ONE PROVIDER").
4. Drive a real call afterwards and read `ai-purpose-health.json` —
   `substituteSuccesses` rising with `consecutiveFailures` at 0 is the outcome
   that matters, not a green suite.

---

## Attempt D — separate the two views (2026-09-01, partially landed)

The design above was implemented as far as it goes, and the useful half is now
on the branch:

**LANDED, green:** `configuredStepsFor(purpose)` in complete-with-fallback.ts —
the full credentialed, non-stale set for a purpose, uncapped and unordered,
ignoring cooldowns entirely. `hasUsableCapacityForPurpose` now asks IT the
"is this user set up at all?" question, instead of asking the walk's chain. That
decoupling is correct on its own terms and is a prerequisite for change 4;
capacity + jobs suites: 137 passed.

**STILL BLOCKED:** applying change 4 on top of it STILL turns
`capacityForPurpose` red. The design missed a layer.

    const judged = capable.length > 0 ? capable : configured

`capable` never actually goes empty, because **the tail filter does not touch
the LEGACY step** — `resolveChain` always returns at least `[legacy]` when a
default provider is pinned. So the `configured` fallback never fires, and
capacity judges usability over a one-element list containing a step the filter
never examined.

**What the next attempt must handle.** The legacy step is outside every
filtering decision in this function — `tailMax === 0`'s substitution, the tail
construction, and now change 4 all reason about `usable`/`tail` while `legacy`
is spliced on afterwards. Any "the chain contains only attemptable steps"
invariant has to include it, or the emptiness test that capacity depends on can
never be reached. Either:

- give capacity a third question ("is any configured step usable right now")
  that never consults the walk's chain at all — simplest, and arguably what it
  always meant; or
- bring the legacy step inside the same filter, which changes what
  `resolveChain` returns for every purpose and needs its own pass.

Three attempts have now been reverted for the same underlying reason, in three
different disguises. The reason is not the filter. It is that `resolveChain` is
load-bearing for two callers with incompatible needs, and only one of them has
been separated so far.
