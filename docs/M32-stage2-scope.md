# M32 Stage 2 — outcome tracking: the scope

**Decision document. No code. Written 2026-08-31 against `main` @ `27e0c5a`.**

---

## ⛔ READ THIS NUMBER FIRST: it is **8 in EACH ARM**, never 16 between them

The requirement is **8 won AND 8 lost** — two separate counts that must each be met.
"16 deals" is the number a reader will take away, and **it is wrong**, because it hides that
the binding constraint is almost always the *lost* arm.

**So the deals you need scale with your win rate:**

| Win rate | Closed deals needed to reach 8 lost |
|---|---|
| 50% | 16 |
| 60% | 20 |
| 70% | **27** |

A 12-and-2 split is **2**, not 14. Every count in this document that looks like it is
approaching a target should be read against the arm it belongs to.

### And the consequence, which is bigger than this stage

**At a normal win rate this analysis needs a volume of closed business that a solo founder
testing their own product will not produce for a long time — possibly never at this scale.**

That is not a reason to stop building it: the capture is the foundation, it is correct
regardless, and a user with real pipeline volume gets the analysis the day their data
supports it. **But it must be written down, because in six months a stuck counter will look
like a bug or like capture failing, and it will be neither.**

**The feature is designed for a user with pipeline volume. For this founder specifically it
is expected to stay dormant**, and that expectation is the design working, not the product
being broken.

## The finding that should shape this stage, before any design

I counted what is actually on the founder's machine, rather than designing against the
brief's description of it:

| | |
|---|---|
| Calls (not deleted) | **163** |
| …with a `contactId` | **67** |
| …**without** any contact | **96** |
| …with coaching analysis (the `talkRatio` / `questionCount` metrics) | **52** |
| Deals (not deleted) | **4** |
| …**won** | **4** |
| …**lost** | **0** |
| …open | **0** |
| Calls linkable to any deal (via `call.contactId` = `deal.contactId`) | **23** |

**There are zero lost deals. Correlation is not underpowered here — it is impossible.**
Every claim this stage could make is of the form *"your won deals differed from your lost
deals in X"*, and there is no second group to compare against. No threshold, no statistical
care, and no amount of careful wording changes that.

So the founder's instinct — build the collection, keep the analysis dormant — is not the
cautious option. **It is the only honest one**, and the data supports it more strongly than
the brief assumed.

### The binding constraint is not the threshold. It is that outcomes barely exist.

Four deals against 163 calls means the pipeline is not where the work is being recorded.
Stage 2's real problem is not *"how do we analyse outcomes"* but *"how does an outcome come
to exist at all, reliably, from a person who will be lazy about it"*.

---

## What already exists (so we build the missing half, not a parallel one)

Checked in source, not assumed:

- **`DealStage.kind` is already `'open' | 'won' | 'lost'`** (`deal-stages.ts`), and the
  default stages already include Won and Lost.
- **`stageHistory: { stageId, changedAt }[]`** already records every transition with a
  timestamp (`deals-fs.ts:39`), so *when* a deal closed is already captured.
- **Dragging a card on the Pipeline board already sets the stage in one action**
  (`DealsView.tsx:113`).
- The correlation inputs already exist per call: `talkRatio`, `questionCount`,
  `objectionsMined`, `commitments`, and per-dimension coaching scores.

**So "won/lost, with a date" is largely built.** What is missing is smaller and more
specific than the brief implies:

1. **no-decision** — not representable today. A stalled deal must be dragged to *Lost*,
   which is a different thing and would poison the eventual comparison by mixing "they said
   no" with "it evaporated".
2. **a reason** — no field exists.
3. **the call → deal link** — `calls-fs.ts` has **no `dealId`**. The only join is through
   `contactId`, which is *optional* (96 calls have none) and *ambiguous* (a contact may have
   several deals). This is the real data gap.

---

## Proposed scope

### 2a. Make an outcome representable and one-action

- **Add `'no-decision'` to `DealStageKind`**, with a default stage to match. Lost and
  no-decision stay distinct for good — the founder named this, and it is exactly the
  distinction that decides whether the eventual analysis is about losing or about stalling.
- **An optional free-text reason**, captured at the moment of closing and **never blocking
  it**. If a reason box can stop a deal being marked closed, the outcome data becomes
  biased toward the deals the founder felt like explaining.
- **One action, from where they already are.** Dragging to a closed column *is* the action —
  the reason prompt appears after, and dismissing it leaves the outcome recorded. Marking
  never depends on the second step.

### 2b. Make an outcome *possible* — the call → deal link

Without this, 2a produces outcomes attached to nothing measurable.

- **Add `dealId?` to the call record.** Explicit, not inferred, so a contact with two deals
  is not silently attributed to one.
- **One action from the call**, where the founder already is after a call.
- **Retroactively**: offer the link where it is unambiguous (a call whose contact has
  exactly one deal — today that covers all 23 linkable calls), and **leave the other 96
  alone**. Guessing a link is worse than not having it: a wrong attribution is
  indistinguishable from a real one in every later analysis.

### 2c. The counter — what it is collecting toward

Because the founder should never be entering data into a void:

> **Outcomes recorded: 4 won · 0 lost · 0 no-decision.**
> *Comparisons need at least 8 won and 8 lost with call data attached. Not there yet.*

Rules for it:
- **Counts only. Never a direction, never a number from the analysis**, not even a hint.
- Shows the *binding* arm ("you have won deals but no lost ones — nothing can be compared
  yet"), because "12 of 16" hides that 12 and 0 is not 12.
- Counts only deals that would actually qualify — a closed deal with no linked call carrying
  metrics contributes nothing and must not inflate the number.

### 2d. The analysis — designed, dormant, not built

Specified now so the collection captures the right things; **built later, when the counter
says it can be.** Nothing renders until then.

---

## The threshold, and how it is a gate rather than a warning

### Where the line sits

**Two conditions, both required, per claim:**

1. **At least 8 in each arm** — 8 won and 8 lost, each with a linked call carrying the
   metric in question. Not 8 closed deals total. A 12-and-2 split is 2.
2. **Leave-one-out stability** — the direction of the finding must survive deleting any
   single deal. If removing one deal reverses or erases it, it shows nothing regardless of
   count.

**Condition 2 is the real gate; condition 1 is a cheap pre-filter.** I would rather propose
a criterion that is *checkable* than a number that sounds authoritative. "8" is a judgment
and I will not pretend otherwise — but *"one deal must not be able to flip the answer"* is a
property of the actual data, it is computable, and it fails loudly on exactly the small,
lopsided samples that produce confident nonsense.

**Founder's call on the 8.** My reasoning: below roughly that, a single deal is a large
fraction of an arm, and condition 2 will usually fail anyway — so 1 mostly saves the work.
If you would rather it were 10 or 12, that costs nothing but time.

### How it is structural, not a check someone can forget

The founder asked for this specifically, so it is a type-level property, not a guard clause:

- An insight is a **discriminated union**, and the not-ready arm **carries no numbers at
  all**:

  ```
  type Insight =
    | { status: 'insufficient'; wonCount: number; lostCount: number; needPerArm: number }
    | { status: 'ready'; claim: string; wonN: number; lostN: number; … }
  ```

- **The only constructor is the one that applies the gate.** There is no path that produces
  a `'ready'` insight without having passed both conditions, because the raw comparison
  function is not exported.
- **The renderer cannot display what it is not given.** The `'insufficient'` arm has no
  effect size, no direction, no percentage — so there is nothing to accidentally render, no
  caveat to attach to a number, and no number to attach a caveat to. *A caveat next to a
  number gets read as a number*, so the number must not exist.
- **Pinned by tests** in the shape this repo already uses for
  [[structurally-unflaggable-switches]]: an import-graph test proving no renderer module
  reaches the raw comparison, and a test asserting the `'insufficient'` arm has no numeric
  display field. Both red-checked.

### What it must never do

- **Never a weak signal with a caveat.** Below the gate: nothing.
- **Never "your closed deals had X" phrased as "do X to close deals".** Every ready claim
  states its sample size inline and is worded as an observation about the past.
- **Never a p-value or a confidence interval.** This data will not support them, and they
  are the most effective way to make a weak claim look strong.

---

## ⚠ THE LINKING WORK DOES NOT UNLOCK THE ANALYSIS. READ THIS BEFORE PLANNING AROUND IT.

**Stage 2’s honest output is “come back in some months.”**

Measured, not estimated: 94 of the 96 contactless calls DO have transcripts, so most could be
linked retroactively. **It changes nothing.** Only 21 of them carry coaching metrics, and
more decisively — **the analysis counts DEALS, not calls.** The gate needs ~8 won and ~8
lost. There are **4 deals, all won, zero lost.**

Link every one of the 163 calls perfectly, backfill coaching on all of them, and the counter
still reads *nothing to compare*: 4 data points in one arm, zero in the other.

**So nobody should read the call→deal linking work as the thing standing between the founder
and an insight.** It is what makes a future insight POSSIBLE. What makes it ARRIVE is closed
deals, which only time and selling produce. The linking is necessary and insufficient, and
those are different claims.

**And a note for later, at the founder’s instruction:** if a long stretch passes — say a year
— and the counter has genuinely not moved, **that is a signal about the product, not about
the founder’s diligence.** Three possible causes, and the THIRD is the one to check first:

1. deals are not being recorded — a capture problem this stage failed to solve;
2. deals do not close often enough — a premise problem;
3. **the threshold design assumed a pipeline volume this product's users do not have.**

(3) is the likeliest and the easiest to mistake for (1). It would be a finding about the
FEATURE, not about the data or the founder — and the remedy would be to redesign what the
analysis needs, not to wait longer. Check it deliberately; do not let it quietly wait
forever.

## The backfill: worth doing, and it will NOT cross the line. Both halves matter.

The founder asked, before spending an evening on it, what the realistic number is. Measured:

Of the **19** contacts with at least one coached call — the ceiling on deals backfillable
from existing history — by how many calls exist with them in total:

| Calls with that contact | Count | What it probably is |
|---|---|---|
| 1 | **8** | could be anything: a one-off, a support call, a test |
| 2 | **4** | |
| 3+ | **7** | a repeated conversation — most likely a real pursuit |

Only **1 of 36 contacts** has a company recorded, so there is no CRM signal to lean on.

**A realistic count of genuine, rememberable deals is therefore around 7–11, not 19.**

### ⚠ And the gate is harder than 19 ≥ 16 makes it look

**The gate needs 8 in EACH ARM — 8 won AND 8 lost. Not 16 between them.** That reframes the
whole calculation, because the binding constraint is the *lost* arm:

| Win rate | Deals needed to reach 8 lost |
|---|---|
| 50% | 16 |
| 60% | 20 |
| 70% | **27** |

The founder's four existing deals are **all won**. That is weak evidence — four deals, and
possibly a recording habit rather than a win rate — but it points the wrong way for this
purpose. If the real win rate is high, the lost arm needs *many* more deals than the total
count suggests.

**So: ~7–11 realistic backfilled deals, probably win-skewed, against a requirement of 8
lost. The backfill does not unlock the analysis, and must not be described as though it
might.** Best case — 19 deals splitting near 50/50 — it just barely would; that case is not
the likely one.

### Why build it anyway

- It is the **foundation regardless**: every future closed deal lands on top of it, and the
  work is not repeated.
- It establishes the capture habit and the data shape while the stakes are zero.
- **The “I don't remember” count is itself a finding.** If most of the 19 come back
  unremembered, that says the backfill cannot be trusted — and the counter should say so
  rather than counting them.
- It is a one-evening cost, once.

### The design constraint that is not negotiable

**List-driven, never memory-driven.** The founder's reasoning, and it is the reason this
flow exists in this shape:

> *A memory-driven backfill selects on memorability, produces clean-looking counts, passes
> leave-one-out, and is silently poisoned in exactly the category we just added
> `went-quiet` to capture. No gate catches that, because nothing is wrong with the numbers.*

So the sample is **"every contact I have coached calls with"**, not "every deal I recall".
The flow shows all 19 rows up front with progress, because a list that reveals its length one
row at a time gets abandoned halfway — **and a half-finished list-driven backfill is a
memory-driven one wearing better clothes.** "I don't remember" is a first-class answer,
distinct from an unanswered row. One entry point, findable, and **no reminders** — if the
founder does 10 and stops, the counter reflects what exists rather than prompting toward a
number.

## ⚠ RELEASE-ORDERING CONSTRAINT: whatever ships this must not be casually downgraded

**Not a bug — a property of the change, and it needs saying in the release notes.**

A stage with `kind: 'went-quiet'` read by **1.6.0 or earlier** is coerced to `'open'`, because
`sanitizeKind` in those builds knows only `won`/`lost` and falls back to `open` for anything
else. That fallback is correct — an unknown kind from a NEWER build should degrade to "still
in play" rather than silently marking live deals closed — but it has a consequence:

**A user who rolls back after this ships sees their closed "Went quiet" deals reappear in an
OPEN column.** The deals are intact and the stage is still there; only its meaning is lost.
Nothing is destroyed and nothing goes red.

Three things follow:

1. **The release carrying Stage 2 should be one people do not downgrade from casually**, and
   the notes should say so plainly rather than leaving it to be discovered.
2. **Do not "fix" the old fallback.** Coercing an unknown kind to `open` is the safe
   direction; the alternative — guessing it is closed — would hide live deals.
3. **Check this again for any future kind.** The same coercion will apply to the next one,
   and the same rollback will produce the same surprise.

## What Stage 2 will NOT deliver, said now

- **No insight, for months.** With 0 lost deals, the counter will read *"nothing can be
  compared yet"* on the day it ships, and will keep reading that until roughly 8 lost deals
  have been recorded with linked calls. **That is the honest output of this stage**, and if
  it is not an acceptable thing to ship, this is the moment to say so rather than after it
  is built.
- **No retroactive analysis of the 96 unlinked calls.** They stay unlinked.
- **No backfill of outcomes from before today**, beyond marking the 4 existing deals.

## The single-arm question: asked, answered, DROPPED — with one candidate kept on the shelf

The founder asked whether there is a version of this analysis that needs only won deals,
since the *lost* arm is what binds. Considered properly, and the answer is no for the version
as posed.

### Why *"here's what your won calls have in common"* is the bad version

**Base rates eat it.** If 80% of all calls sit near a 0.5 talk ratio, then 80% of the WON
calls do too. Reporting that as a property of winning is **describing the founder's habits
and calling it a strategy** — and with no comparison group there is no way to separate the
two after the fact.

**And wording cannot fix it.** A number with no claim attached still reads as a target.
*"Your won calls averaged 42% talk ratio"* will be read as *"aim for 42%"*, because that is
the only actionable reading available. This is exactly the problem Stage 1 solved by making
the number **not exist**, and the same remedy applies: refuse the surface, not the phrasing.

**So the version as posed is precisely the confident nonsense this stage exists to refuse.**

### The one candidate worth designing, IF a low-N version is ever wanted

**Within-deal trajectory — each deal as its own control.**

> *"In your won deals, questions-per-call rose between the first call and the last."*

That is a **paired** comparison: each deal measured against itself, so base rates cancel, and
it needs far fewer deals because within-deal variance is much smaller than between-deal
variance. It is a real technique rather than a dressed-up description.

**Its ceiling, which must travel with it:** it describes **how won deals progressed**. It
cannot say that is **why they closed** — losing deals might show the identical shape, and
without them nobody will ever know. The honest claim is *"this is the shape of the deals that
closed"*, which is genuinely narrower than *"this is what closes deals"*, and the difference
is the whole point.

### ⚠ THE PRESSURE THAT WOULD PRODUCE THE BAD VERSION, WRITTEN DOWN ON PURPOSE

**Building a low-N analysis BECAUSE the real analysis is far away is exactly the pressure
that produces the dishonest one.**

The reasoning will not feel dishonest at the time. It will feel like pragmatism — *the
founder has been waiting, the counter has not moved, surely something is better than
nothing.* **Something is not better than nothing here.** A confident wrong claim about the
founder's own selling is the failure mode this entire stage was scoped to prevent, and it
arrives dressed as helpfulness, never as a shortcut.

If the trajectory version is ever built, it should be because it is **independently worth
building**, not because the gate has not opened.

## Open questions for the founder

1. **The 8.** Approve, or raise it.
2. **Linking from the deal side — ANSWERED, and it needs no extra structure.** `call.dealId`
   is one field with two entry points: from the call (*“which deal is this?”*) and from the
   deal (*“which calls belong to this?”*). The deal-side view is a query for calls whose
   `dealId` matches — no join table, no second source of truth, and the two surfaces cannot
   disagree because they write the same field. Both will be built.
3. **Where the counter lives** — Coaching, Rise, the Pipeline board, or the deal itself. My
   recommendation: **the Pipeline board**, because that is where an outcome gets recorded,
   so the progress bar sits next to the action that moves it.
3. **`no-decision` wording** — "No decision", "Stalled", "Went quiet"? This is the founder's
   language, not mine, and it will appear on the board.
4. **Does the reason prompt appear for won deals too**, or only lost/no-decision? Won-reasons
   are the more useful half for coaching and the more annoying half to fill in.
