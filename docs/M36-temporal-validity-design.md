# M36 Stage 3, item 5 — temporal validity for memories: the design, for the founder's approval

**2026-09-06.** The founder: *"a memory system that overwrites rather than dates its facts will
confidently tell me something that was true in July. Bring me: what gets dated, what happens to
existing rows, what 'as of' answers look like, and what breaks."* This is that, against the module
as it reads today. Nothing here is built.

## What exists today (read from the code)

- A memory has `createdAt`, `lastConfirmedAt`, and — since item 4 — `lastRetrievedAt`. All three are
  **when we learned or touched it**, not when it was true.
- A contradiction does not overwrite: the old row stays, status `invalidated`, with `invalidatedBy`
  (the new row's id) and `invalidatedAt` (when we learned the new fact). History is preserved but
  only in *system time*.
- Evidence carries a `callId` (and a quote), never a date. The call's own date is on the call
  record in `calls/`, not on the memory.
- Retrieval ranks by vector distance alone; no recency term, no validity window.

So "what was the budget in June?" is unanswerable not because the June fact is gone — it is there,
invalidated — but because nothing says *June*, and nothing lets a question carry a time.

## What gets dated

Two timestamps, both **event time**, on every memory row, nullable:

| Field | Meaning | Set by |
|---|---|---|
| `valid_from` | the earliest moment this fact is known to have been true | the date of the call (or chat) the first evidence came from; for a user-stated fact, the moment they stated it |
| `valid_until` | the moment it stopped being true; NULL = still true as far as we know | the date of the call that produced the contradicting fact — **not** `invalidatedAt`, which is when we *learned* it |

That is the bi-temporal split the Zep/Graphiti line of work uses: **event time** (`valid_from` /
`valid_until`) beside **system time** (`createdAt` / `invalidatedAt`). Both are kept; neither is
overwritten.

Also dated: **evidence**. `MemoryEvidence` gains `at?: string` — the call's start time — so a
fact with three evidence episodes can show *when* each one happened, and `valid_from` is derivable
(the earliest `at`) rather than a fourth thing to keep consistent.

Not dated: `importance`, `confidence`, scope, category. They describe our belief, not the world.

## What happens to existing rows

- Migration 5 adds the two columns, nullable. Existing rows get `valid_from` **backfilled from
  the earliest evidence call's start time** where the call record still exists (a one-time pass in
  the migration's follow-up job, not in the migration itself — the calls store is outside the
  memory db), and NULL otherwise. `valid_until` is backfilled for `invalidated` rows from the
  **invalidating memory's `valid_from`** when that is known, else NULL.
- A NULL `valid_from` means "true since at least when we learned it"; retrieval treats NULL as
  `createdAt` for ordering and says nothing about June it cannot support.
- No row is rewritten in place; no statement text changes. The backfill is reversible (drop the
  two columns) and is measured before it runs: count of rows that can be dated, count that cannot,
  printed by the job and written to the tracker.

## What "as of" answers look like

Three shapes, from cheapest to richest:

1. **Retrieval carries a time.** `retrieveRelevantMemoriesStructured(question, { asOf })` filters
   to rows with `valid_from ≤ asOf` and (`valid_until` IS NULL or `valid_until > asOf`). Without
   `asOf` the default is "now", i.e. exactly today's behaviour minus the invalidated rows it already
   excludes — **no change to any existing caller's results.**
2. **The question carries a time.** A small, deterministic parser (`"in June"`, `"last quarter"`,
   `"before the proposal"`, `"as of March 3"`) sets `asOf` for Rise; unparsed questions get no
   `asOf`. Same discipline as client inference: from the words typed, never guessed, tested on a
   corpus of dated questions.
3. **The answer says which fact and when.** Retrieved memories already surface as tappable
   citations in Rise; each citation gains its validity window, so the model's context reads
   *"Budget ceiling is around $40k (true from 2026-03-14; superseded 2026-07-02 by: budget raised to
   $55k)"*. The prompt instruction: when a question is about a time, answer from the fact valid at
   that time and name the window; when the current fact differs, say so in one clause.

An "as of" question with no dated fact in range returns nothing for that client and the existing
refusal notice applies: *"I can't tell you what was true then — the earliest fact I have is from
{valid_from}."*

## What breaks, honestly

- **Every consumer of `Memory` that constructs one by hand** (fixtures in ~30 test files) needs
  the two optional fields tolerated — optional, so nothing breaks at the type level, but the
  contradiction tests must be extended to assert `valid_until` is set from the *new fact's* event
  time, not the learning time.
- **Consolidation's contradiction path** must know the new fact's call date to set the old fact's
  `valid_until`. Today it receives a candidate with evidence `callId`s only; it will need the call's
  start time passed in (or resolved from the calls store, which is outside the memory db — the
  cleaner path is the caller passing `evidence.at`).
- **The retrieval harness** needs a dated corpus: today's questions carry no time and the
  expected answers no windows. The item-5 measurement is a new fixture, `retrieval-eval-temporal`,
  with at least ten "as of" questions and their windows, run before and after.
- **Export / backup** (`snapshot.ts`, the Sales Brain export) carry the db file whole, so the new
  columns travel; the memory-center UI's table needs the two new columns shown or it will look
  like the data vanished.
- **Decay** should not archive a fact whose `valid_until` is set — it is not stale, it is
  *historical*; those rows leave the decay loop and stay retrievable only through `asOf`.

## What it costs and what it is worth

Two nullable columns, one migration, one backfill job, one parser, one prompt clause, one new
fixture. The value is the sentence the founder wrote: a system that dates its facts can say *"that
was true in July, and here is what changed"*, and a sales tool without that will eventually
contradict the rep in front of a buyer. Recommendation: approve the design; build in the order
(1) columns + backfill + measured counts, (2) contradiction sets `valid_until`, (3) `asOf` in
retrieval + the dated fixture, (4) the question parser, (5) the citation window and prompt clause.
