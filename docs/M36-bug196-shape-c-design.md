# BUG-196 shape (c) — client categories: the design, for the founder's decision

**2026-09-06, night. APPROVED by the founder the same night ("build it before re-extraction";
"check contradictions across the whole client family — do that") and BUILT on `claude/m36-shape-c`:
the five categories + residual in `types.ts`, the rule stated once for the tool schema and the
prompt (`CLIENT_CATEGORY_RULE`), the family-wide contradiction check in `consolidation.ts`
(red-checked: the test fails with the change stashed), the three leak pins plus two controls in
`shape-c-client-categories.test.ts`, the residual's share in the Memory Center, and the harness's
"category on hits" line. NOT measured live: that is the pinned Gemini run once the paid key exists.**
The founder asked for the design, not the direction:
what the categories are, what happens to existing rows, what a miscategorised fact costs, what
breaks — and two things they will weigh: whether a category can be wrong in a way that leaks
across clients, and whether the categories are ours or the user's.

## 0. The one-paragraph version

Five named client categories plus the existing `client-fact` as the residual. Every one of them
is bound to the `client` scope kind, so a category can never move a fact between scopes, and the
scope itself is still built from the call's contact id and nothing the model says — the
cross-client invariant is untouched by construction and pinned by a test. Existing rows do not
change. The one real cost of a wrong category is that two facts filed under different categories
are not contradiction-checked against each other, and I would close that by checking
contradictions across the whole client family rather than within one category. The categories are
ours (a fixed list), the sixth kind of fact goes to the residual and is never dropped, and the
signal that a user's business needs a category we lack is a measurable one: the residual's share
of their store.

## 1. What the categories are

They are the five topics the extraction harness has scored since M27, when it was written
(`memory-quality-eval.test.ts`: budget / timeline / decision-maker / pain-point / objection — an
eval-only keyword classifier, because the schema had no such names). The 32 refused proposals from
today's real runs (`fixtures/bug196-refused-proposals.json`) fall into them as follows. This is my
hand classification, not a measurement:

| Category | Bound scope | What goes in | Of the 32 refused rows |
|---|---|---|---|
| `client-budget` | client | money: budget, expected spend, price sensitivity | 4 ("expects to spend $40–50k per year", "tight budget this quarter") |
| `client-timeline` | client | any dated intent: go-live, deadline, follow-up date, "before peak season" | 7 ("live by end of Q3", "implemented by end of Q2") |
| `client-decision` | client | who decides, approval thresholds, the process | 6 ("IT director has final authority", "Finance must approve over a few thousand") |
| `client-need` | client | the pain and the goal it implies: current tools, process, constraints, what they want fixed | 10 ("relies on manual notes after each call", "wants better visibility into calls", "limited bandwidth for a rollout") |
| `client-concern` | client | what they are worried about, hesitant on, objecting to | 1 ("IT director's primary concerns are security posture and integration") |
| `client-fact` | client | **the residual**: everything else about the client | 4 (3 preferences: "prefers a technical brief", "follow-up in a couple of weeks"; "rolling out to about fifteen reps") |

One row of the 32 was a genuine business fact about the rep's product (Meridian Flow's payroll
push), claimed as `business/product-or-service` — a different refusal, not this bug's.

Rules the model is given, in the tool schema and the prompt, verbatim: a fact about the client
uses one of the six `client-*` names and nothing else; a fact with a date or a period is
`client-timeline` even when it is also a goal; a client fact that fits none of the five is
`client-fact` — **never refuse a client fact for not fitting a bucket**.

What I deliberately left out: a `client-preference` category (how they like to be sold to). Three
of the 32 rows are preferences, they are useful to a rep, but no consumer in the app would do
anything with the name today, and five is the cap the founder named. It is the first one to add if
the residual fills up with them. And no `client-product`/"what they use today" — that is
`client-need` when it is a pain and `client-fact` when it is not.

## 2. What happens to existing rows

**Nothing.** `category` is a TEXT column; the 73 memories keep the names they have. `client-fact`
stays a valid name (it is the residual), so every existing client row is still well-formed with no
migration. `CATEGORY_SCOPE_KIND` gains five entries, all `client`; `MEMORY_CATEGORIES` gains five
strings. No SQL migration, no new table, no backfill.

I would **not** re-classify the existing `client-fact` rows automatically. It costs one model call
per row, it could be wrong silently, and the rows are honest as they are. Re-classification
happens only through re-extraction (decision 2), where the new extractor files each fact fresh and
the old row is reinforced or superseded through the normal path — and that is the reason **(c)
must be decided before the re-extraction runs, not after**: re-extracting first would file every
recovered fact as `client-fact` and then need re-classifying anyway.

Shape (b)'s remap stays exactly as it is: a client-claimed rep/business category still lands in
`client-fact`, the residual. The remap never guesses a topic; the prompt does that work, and the
remap is the floor under it.

## 3. What a miscategorised fact costs

Where `category` is read, from the code:

| Consumer | What it does with category | Cost of a wrong one |
|---|---|---|
| `consolidation.ts` `detectContradiction` | compares a new fact only against active facts in the **same scope and category** | **the one real cost**: a budget filed as `client-need` and a later budget filed as `client-budget` are never checked against each other, so the old one is not superseded, its temporal window never closes, and both answer "what was the budget" |
| `consolidation.ts` `buildProfileText` | ignores it (ranks by importance × confidence) | none |
| `rag.ts` retrieval | none; retrieval is by scope, vector and text | none: the fact is still found |
| `MemoryCenterSection.tsx` | shows it as a small label; filters are by scope only | a wrong label |
| `coaching-chat.ts` | the coach's own memory-filing tool lists the enum | none for reading; it learns the new names |
| `onboarding.ts` | per-topic allowed sets, rep/business only | none: it never files client facts |

So the cost is bounded to contradiction pairing, and I would remove it: for any `client-*`
category, contradiction-check against **all** `client-*` facts in that client's scope. A client
scope holds 13–14 facts in the founder's store, so the check stays cheap (it is one model call
with a short list), and a wrong category then costs a label and nothing else. That change is part
of (c), measured by the existing contradiction tests plus one new one: budget-as-need vs
budget-as-budget must still supersede.

## 4. The two things the founder is weighing

**Can a category be wrong in a way that leaks?** No, by construction, and pinned:

- The scope of a client fact is `client:<contactId>` where `contactId` is the call record's
  contact, passed in by the caller. The model never names a contact; it cannot put a fact in
  another client's bucket because it has no way to say which client. This is true today and (c)
  does not touch it.
- Every `client-*` category is bound to scope kind `client`. A `client-budget` claimed with
  `scopeKind: rep` is the reverse direction and stays a drop (`category-scope-mismatch`), exactly as
  `client-fact` does now — so a client category can never land in the rep or business scope, where
  it would feed coaching as a fact about the rep (BUG-166's shape).
- Retrieval's cross-scope invariant (`rag.ts`, throws on any result outside the asked scopes) does
  not read category at all, so no category value can widen a retrieval.
- Pinned by tests: (i) every category whose name starts with `client-` maps to `client` in
  `CATEGORY_SCOPE_KIND`, enumerated over the list so a sixth name cannot be added unbound; (ii)
  `verifyCandidate` with contact A and any client category never yields a scope other than
  `client:A`, over every category; (iii) the reverse direction drops, over every client category.

**Are the categories ours or the user's?** Ours: a fixed list. The reason is the contradiction
pairing above and the prompt: a user-defined category is a name the model has never seen and the
consolidator cannot pair. The sixth kind of fact — a rep whose business runs on something we did
not name — goes to `client-fact` and is kept, retrieved and shown like any other; the only thing it
loses is the label. The signal that the list is wrong for a user is measurable: the residual's
share of their client facts. I would add that count to the Memory Center's summary line ("N of M
client facts have no category") so the question "do we need a sixth" is answered from stores, not
from taste. If it ever matters, per-user categories are a product decision for another day; this
design does not preclude them.

## 5. What breaks

- `CATEGORY_SCOPE_KIND` is typed `Record<MemoryCategory, …>`, so adding to `MEMORY_CATEGORIES`
  fails typecheck until every consumer is updated — the compiler enumerates the blast radius.
- The extraction tool schema and guardrail prompt (`extraction.ts`), and the coach's memory-filing
  tool (`coaching-chat.ts` line ~270) list the enum; both change.
- Tests that count categories or list them exhaustively (the taxonomy tests, the remap test's
  fixture expectations, the harness's classifier which can now read `candidate.category` instead of
  keyword-matching) — all updated, and the harness gains a category-accuracy line.
- **Downgrade:** a v1.10 app opening a store written by this build reads `client-budget` rows fine
  (the cast in `memories-store.ts` does not validate) and pairs contradictions by string equality,
  so nothing is lost; it would only decline to file *new* candidates under the new names, which it
  never proposes anyway.
- **The 73 memories:** unchanged until re-extraction, per §2.
- Nothing in consent, exclusion, the recording gate, or what leaves the device is touched.

## 6. Cost and how it is measured

Two to three days: types + prompt + schema (half a day), the family-wide contradiction check (half
a day), tests including the three leak pins (half a day), the Memory Center residual count and the
harness's category line (half a day), before/after runs.

Measured the same way as (b): the offline replay over the 32 refused rows (kept / recovered /
category agreement with my hand classification above), then `CALLRISE_EVAL=1` with the model
pinned, three runs before and three after — recall on the 15 ground-truth facts, the harness's
per-topic recall (which becomes a real category measurement for the first time), forbidden-topic
false positives at 0, and the refusal count for "did not fit a category" at 0.

## 7. Recommendation

Build it, in this order: (c) → harness reliable → re-extraction. The 18-of-19 from shape (b) is a
recall number; it says the facts come back, not that the store can tell a budget from a preference,
and the temporal work built today ("what was the budget in June") is exactly the question a
residual-only store cannot answer. The design's whole risk is in §3, and §3 is closed by the
family-wide contradiction check, which I would build first.
