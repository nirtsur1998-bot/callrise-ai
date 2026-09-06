# BUG-196 — the three fix shapes, with what each costs, for the founder's decision

**2026-09-06, evening.** Nothing here is built. The founder's two questions come first, because
they decide which shapes are even allowed.

## 1. Which rule is doing the discarding, and why it exists

**The rule:** in `extraction.ts`, `verifyCandidate` (formerly `verifyAndBuild`), the check now
named `category-scope-mismatch`:

```
const expectedKind = CATEGORY_SCOPE_KIND[category]
if (expectedKind !== scopeKind) return { rejected: 'category-scope-mismatch' }
```

The model returns two things per candidate: `scopeKind` ('rep' | 'business' | 'client' — *who this
fact is about*) and `category` (one of 14 fixed names). The taxonomy (`types.ts`,
`CATEGORY_SCOPE_KIND`) binds every category to exactly one scope kind: seven rep categories
(selling-pattern, skill-strength, skill-weakness, stated-goal, stated-struggle,
communication-style, preference), six business categories (product-or-service, pricing-model, icp,
objection-and-response, competitor, terminology), and **one** client category (client-fact). When
the model's claimed scope and its category's bound scope disagree, the rule drops the candidate.

**Why it exists — and it is not a consent or privacy rule.** Its purpose, from its own comment:
*"a mismatch (e.g. category 'client-fact' but scopeKind 'rep') means the model contradicted itself,
which is reason enough to drop the candidate rather than guess which half to trust."* It is a
**data-quality heuristic protecting scope attribution**: whose fact this is. The failure it guards
against is real and was found in the founder's store — BUG-166: the buyer's "my finance director
approves anything over $20k" stored as *"The rep's finance director signs off large purchases"*,
scope `rep`, feeding coaching and live cues as a fact about the founder. (It is still there: see
"The rep's finance director signs off large purchases · skill-strength" in the Memory Center tonight.)
The rule does not touch consent, exclusion, the recording gate, or what leaves the device; those
live elsewhere (`salesBrainExcluded`, `forgetCallContribution`, the consent guards) and none of the
three shapes below goes near them.

**What it actually catches, measured (run 11, the instrument):** 19 refusals, all this rule, 10 of
them ground-truth facts. The model files the buyer's budget as `pricing-model`, the buyer's go-live
date as `stated-goal`, the buyer's manual-notes pain as `stated-struggle`, the buyer's approval
process as `selling-pattern` — categories the taxonomy binds to business or rep — because **the
taxonomy gives a client fact exactly one name, `client-fact`, and the prompt never says so**: the
tool schema lists the 14 categories flat, and the scopeKind description says who the fact is about
but not that `client` narrows the category list to one. The model does the natural thing (a budget
IS pricing; a deadline IS a goal) and the rule reads it as a contradiction.

**The direction, which decides how safe a remap is:** the refused statements are all about the
client ("The client expects a budget…", "Client wants the tool implemented by end of Q2…"), so the
model almost certainly claimed `scopeKind: client` with a rep/business category — the SAFE
direction (a client fact filed too specifically), not the dangerous one (a client fact claimed as
the rep's, which is BUG-166). Since run 12 the instrument prints the claimed scope on every refused
row; the run that would have confirmed it hit BUG-195 on every attempt. **The first Gemini run
confirms or refutes this before anything is built.**

## 2. The three shapes

### (a) Prompt — tell the model the client scope has one category

Add to the tool schema and the guardrail prompt: *"A fact about the CLIENT (scopeKind 'client')
must use category 'client-fact' — the other categories describe the rep or the rep's business."*
Optionally list the mapping explicitly.

- **Cost:** one afternoon; a prompt edit plus the harness before/after. No schema change, no
  migration, no guardrail touched.
- **What it fixes:** the model stops contradicting itself for the common case.
- **What it cannot fix:** it is model-dependent (a weaker model will still slip), and it does
  nothing for the 73 memories already in the store — those were extracted without it and the
  facts it would have kept were never stored. It also loses information: "budget" and "timeline"
  collapse into `client-fact`, indistinguishable from "prefers email".
- **Risk to privacy direction:** none. The guardrail stays exactly as it is.

### (b) Remap — in the guardrail, one direction only

When the model claims `scopeKind: client` and a rep/business category, store the candidate as
`client-fact` **in the client scope** (`client:<contactId>`), keeping the model's scope claim and
discarding its over-specific category. The reverse — a `client-fact` category with scopeKind `rep`
or `business`, or any category with a scope the contact guard does not allow — stays a drop.
`client-fact-without-contact` stays a drop.

- **Cost:** half a day; ~15 lines in `verifyCandidate`, a new `CandidateRejectReason` split into
  `category-scope-mismatch-client-remapped` (kept, counted) vs `category-scope-mismatch` (dropped),
  tests for both directions, the harness before/after.
- **What it fixes:** recovers the 10 of 19 on the fixture regardless of the model's discipline,
  because the decision moves from the model to the rule.
- **What it cannot fix:** the same information loss as (a) — everything becomes `client-fact`.
  Also nothing for the existing store.
- **Risk to privacy direction:** none by construction — the fact lands in the client's own scope,
  which is the most restricted scope (bound chats and named-client inference only; the cross-scope
  invariant throws on any leak). The dangerous direction is not remapped. This is the shape I would
  build first: it is the smallest change that makes the number move, and it is measurable.

### (c) Taxonomy — give client facts the categories the product needs

Add client categories: `client-budget`, `client-timeline`, `client-decision-process`,
`client-current-state` (their tools/process today), `client-risk` (single points of failure,
blockers), alongside `client-fact` as the residual. Bind each to the `client` scope kind. Extend
the prompt and tool enum. Consumers that switch on category (profile compilation, the Memory
Center's filters, onboarding's per-topic allowed sets) learn the new names.

- **Cost:** two to three days, and it is a **data-model change** — yours by the standing rule. New
  category strings in `MEMORY_CATEGORIES` (no SQL migration: category is a TEXT column), a
  migration-shaped pass if existing `client-fact` rows should be re-classified (I would not: leave
  them, they are honest as they are), tests across extraction, consolidation, profile injection,
  Memory Center; the harness before/after.
- **What it fixes:** everything (a) and (b) fix, and it stops the information loss — a budget is
  retrievable AS a budget, which is what a sales tool exists to hold, and what temporal questions
  ("what was the budget in June") actually need.
- **What it cannot fix:** the existing 73 memories still hold what the old extractor kept; only
  re-extraction (the import, `rescanAll`) would recover the rest, and that is a decision about your
  data.
- **Risk to privacy direction:** none in the rule; the new categories are all bound to `client`, so
  the mismatch check gets stricter, not looser. The risk is scope creep — five new names is a
  product decision about what the Sales Brain is for.

## 3. How each is measured, and the prerequisite

All three are measured the same way: `CALLRISE_EVAL=1 CALLRISE_EVAL_MODEL=<model>` on
`memory-quality-eval.test.ts`, three runs before and three after, same model pinned (the harness
now fails a run served by any other model). The numbers that must move: recall on the 15
ground-truth facts, "refused by the guardrails / of which would have hit", and forbidden-topic false
positives staying at 0. The report lists every refused candidate with its claimed scope and reason,
so the direction question in §1 is answered by the first run, not assumed.

**Prerequisite (BUG-195):** the free models in the chain fail structured output often enough
(gpt-oss-120b on Groq: 2 of 3 runs, then 3 of 3 attempts; Nemotron benched; OpenRouter default no
tool output) that no before/after is credible on them. Gemini Flash is the right choice: it is first
in the bundled QUALITY_CHAIN already, so a `GOOGLE_AI_API_KEY` in the user environment makes it the
model that serves every scenario with no code change, and its forced tool calling is dependable in
this app's own history. The key is not yet in the environment (checked by name and length at
19:05: only GROQ and OPENROUTER are set).

## 4. Recommendation

Build **(b)** first, measured, because it moves the number without touching the model's discipline
or your data model, and its privacy direction is provable by test. Ship **(a)** with it because it
is free. Decide **(c)** on the harness numbers from (b): if `client-fact` recall is high but the
temporal and Rise answers still cannot tell a budget from a preference, (c) is the next milestone's
first item.
