# M37 Stage 4 — the team layer: the design, and the uncomfortable question answered

**2026-09-07. Design only, as scoped. One constant and five assertions were built (`SHAREABLE_CATEGORIES`,
zero behaviour change); nothing else.** Four parallel readers surveyed the prior art, the privacy
mathematics, the employment law and our own scope model; three independent answers were written to
the founder's hard question, one of them arguing the feature cannot exist; three judges scored them
through different lenses.

---

## The answer, first

**Two different features have been sharing one name, and the honest answer is different for each.**

- A team brain over **business facts** — which objections recur, what pricing pushback sounds like,
  which competitor keeps appearing — **can exist honestly.** These are facts about the world. There
  is no individual in them to protect.
- A team brain over **rep facts** — `skill-weakness`, `stated-struggle`, `selling-pattern`,
  `communication-style`, `stated-goal`, `skill-strength`, `preference` — **cannot exist honestly at
  any team size this product sells into. Not "is hard". Cannot.** That includes the version that
  sounds safe: a de-identified aggregate.

So the founder's phrasing — *"is there a version where the team learns patterns without any
individual being readable?"* — has a precise answer: **yes for the business half, no for the rep
half, and the rep half is the one the question was really about.**

## Why the rep half cannot exist. Four walls, each fatal alone

**1. Arithmetic. At n=5 an aggregate is not anonymised, it is encoded.** Given the team mean and
the mean of the other four, one rep's exact value is `5·m5 − 4·m4`. That is not an attack; it is
subtraction, and it was recovered exactly in simulation. One rep on holiday for a week is the same
subtraction, and **the manager holds the roster.**

**2. Differential privacy stops the differencing and costs more than the signal is worth.** On a
team proportion at n=5 and ε=1, the Laplace noise standard deviation is **0.283 while one rep's
entire possible contribution is 0.200** — the noise is 1.4× larger than the biggest signal the
number can physically contain. The ratio depends on ε, not on n, so it does not improve by waiting.
A recurring team metric needs on the order of **250 reps** before the mathematics starts helping.
Google's and Apple's local-DP deployments run on millions of samples.

**3. Auxiliary knowledge, which no headcount fixes.** The manager already knows who owns which
account and who joined last month. On an eight-person team, *"the team's weakest area is
discovery"* with one obvious junior rep **is a name**.

**4. The market has already run this experiment, and no vendor solved it.** In this category
"private" is a term of art meaning *hidden from peers, visible to management*. Gong's own
documentation says both halves in one article: *"Private means only you can see the results"*, and
then that private scorecard results are visible to managers with team-stats access. Its call-level
privacy control explicitly does not remove the rep from analysis — *"Regardless of a call's privacy
setting, all calls are calculated in stats and analysis"* — and a manager can click a rep's name to
get their personal stats, **including how many of their own calls that rep listened to.** The rep's
self-coaching is itself a monitored metric. Avoma and Fireflies come closest with meeting-level
privacy, but both are administered by the buyer, and Avoma defaults external meetings — the actual
sales calls — to organisation visibility.

**And two forces decide this even if we don't.** The EU AI Act classifies AI used to monitor and
evaluate worker performance as **high-risk** (Annex III 4(b)), and **prohibits workplace emotion
recognition outright** (Art. 5(1)(f), in force since February 2025) — which lands directly on tone
and sentiment scoring of a rep. Separately, a 2022 HBR study found monitored employees became *more*
likely to break rules, because monitoring erodes their sense of agency. And reps game whatever is
scored: given a sub-50% talk-ratio target, they go silent at 49%.

**One precedent shows the honest version can survive.** Microsoft's Productivity Score shipped
named per-employee metrics, drew a public backlash in November 2020, and was rebuilt as Viva
Insights with the mechanism worth copying: a **minimum group size with a hard floor the admin
cannot lower**, metrics that are always de-identified, insights suppressed when fewer than the
minimum are active — and an end-user opt-out that removes you from row-level output but explicitly
**does not apply to aggregates**. That last clause is the honest part, and it is the one a rep will
read.

## The design, for the half that can exist

**"Publish, don't pool."** Two of three judges chose it; the third chose a close variant. The
mechanism:

- **Eligible by TYPE, not by permission.** Only the six business categories can ever be published.
  The seven rep categories and all six client categories are ineligible — not "off by default", not
  admin-configurable: **no code path**. Client scope is excluded for a non-obvious reason worth
  stating to the founder: the manager knows who owns Acme, so a client fact is attributable to one
  rep **at any headcount**.
- **The rep publishes, one item at a time**, seeing and editing the exact sentence that will leave
  their machine. This reuses a pattern already in the tree — the objection queue stages mined
  candidates and a person approves each one.
- **Only the `statement` travels. Evidence never does.** Every memory's evidence carries a verbatim
  transcript quote, so publishing the row would move a real buyer's recorded speech to a colleague
  *and* fingerprint the contributor. The shared item carries the sentence and its category, nothing
  else.
- **No contributor column and no contribution count.** This is the deliberate, load-bearing
  omission: if the store cannot say who published what, the product cannot be turned into a
  compliance dashboard.

**What the rep loses, stated plainly** — a design whose costs are hidden is just a nicer lie:
nothing accrues automatically (an empty commons is the pressure that later gets eligibility
relaxed); no credit, because contributions are not counted; and their account knowledge becomes a
company record that outlives their tenure.

**What the manager does not get**, and this should be said in the sales call because it *is* the
product: no per-rep view of anything, no ranking, no leaderboard, no "which reps are struggling"
list, no drill-down from team to individual, and **no aggregate over rep-scope facts either.**

### The strongest objection to our own answer

The judge who tested "would a manager buy it" put it sharply: **the sellable half and the honest
half are not the same half.** The team commons is the cheap part and the part a manager will not
pay much for; the per-rep visibility is what the budget holder actually wants. A rep-private design
sells only if the rep-private part is what makes the manager's aggregate trustworthy and legal —
which, given the EU AI Act position above, it increasingly is. That is a bet, and it should be made
knowingly rather than discovered.

## The one cheap decision — and a correction to the obvious version of it

Two of the three answers proposed the same thing: add a `share_class` column to `memories` now,
written at extraction time, defaulting to private, on the argument that it cannot be reconstructed
later.

**The third judge refuted that, and was right.** The classification *is* reconstructible: `category`
is already on every row and `CATEGORY_SCOPE_KIND` already binds it, and `source` already records
whether the rep typed a fact or the system inferred it. A `share_class` column would mostly restate
data the row already carries. **So it is not the cheap decision; it is a day of work for something
derivable.**

**What is genuinely unrecoverable is one field, and it is not the one they proposed.**

> **`evidence_speaker` — which microphone a quote came from.**

Extraction is told the transcript's "REP (the user)" and "OTHER PARTY (the client)" labels are
**authoritative, because they come from which microphone the audio arrived on** — and then the
stored evidence records `{ callId, quote, at }` and **not which of the two said it.** That fact
exists at write time, is never written down, and cannot be recovered afterwards for facts already
on disk. It matters for a team layer (a buyer's words and a rep's words carry different sharing
rules) and it matters today for BUG-196's whole class of scope-attribution errors.

**Adding it is a data-model change, so it is the founder's call.** It is one appended migration and
one write-site change, and the reason to do it now rather than in a year is that a year of facts
will have been written without it and there is no ground truth on disk to backfill from.

### What was built tonight, because it needed no decision

`SHAREABLE_CATEGORIES` in `src/main/memory/types.ts` — the six business categories, by name — plus
five assertions in `shareable-categories.test.ts`. **Zero behaviour change; nothing reads it.** It
costs an hour now, and it means that widening the line later requires **deleting a named assertion
in a diff** rather than editing a settings screen. One of the tests asserts a category added later
is not shareable by default, so the list is an allowlist rather than a snapshot.

## What I did not establish

- Whether a small team would in practice tolerate the honest version — no rep has been asked.
- The commercial question. The judge lens says a manager may not buy the honest design; that is an
  argument, not evidence, and only a sales conversation settles it.
- Anything about jurisdictions outside the EU/UK/US material the readers found.
- Whether `evidence_speaker` is cheap to populate at the write site in every path (chat-sourced
  memories have no microphone at all). That needs a design pass if the founder wants the column.
