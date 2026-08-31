# M32 Stage 2 — outcome tracking: the scope

**Decision document. No code. Written 2026-08-31 against `main` @ `27e0c5a`.**

---

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
the founder’s diligence.** It would mean either that deals are not being recorded (a capture
problem this stage failed to solve) or that deals do not close often enough for a
deal-outcome-based analysis to ever work (a premise problem, and the feature should be
reconsidered rather than waited on). Check it deliberately; do not let it quietly wait
forever.

## What Stage 2 will NOT deliver, said now

- **No insight, for months.** With 0 lost deals, the counter will read *"nothing can be
  compared yet"* on the day it ships, and will keep reading that until roughly 8 lost deals
  have been recorded with linked calls. **That is the honest output of this stage**, and if
  it is not an acceptable thing to ship, this is the moment to say so rather than after it
  is built.
- **No retroactive analysis of the 96 unlinked calls.** They stay unlinked.
- **No backfill of outcomes from before today**, beyond marking the 4 existing deals.

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
