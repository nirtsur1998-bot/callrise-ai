# M36 Stage 3, item 2 — the lexical channel: what was built, what was measured, what it did not show

**2026-09-06.** The founder's brief: *"Items 2 and 3: go. No decisions needed, both measured before and
after,"* and *"Say what corpus size makes the lexical channel measurable so we know when to revisit."*
This is the before/after and the corpus-size answer. The headline is honest and smaller than the
brain comparison predicted.

## Headline

**The proper-noun gap predicted in `M36-brain-comparison.md` did not appear on any instrument
at the sizes measured.** MiniLM-384 ranks "Sam Okafor is the internal champion" first for "Who is Sam
Okafor?" even among twenty same-shaped statements that differ only in the name. The channel earns one
extra hit per bound harness row and one in option B, all from a common-word match (`unhappy`,
`tool`), and it recovered one buried-name case in the shape sweep. Zero cross-scope violations in
every row, before and after. The channel is built, green, and behind a migration that changes the
user's `memory.db` — which is why the merge is the founder's call, with the numbers below.

## What was built

| Piece | Where | What it does |
|---|---|---|
| FTS5 index | migration 5, `migrations/index.ts` | `memories_fts` over `memories.statement`, external-content (the text lives in `memories` only), three triggers keep it in step, `rebuild` indexes every existing row at upgrade. `unicode61 remove_diacritics 2`: case- and accent-folded, no stemming, no prefixes. |
| Question terms | `lexical-terms.ts` | Every word that is not a function word, lower-cased, ≥ 3 chars, deduplicated. Deterministic; nothing invented. Each term quoted in the MATCH expression so an FTS5 operator typed as a word stays a word. |
| Store half | `memories-store.ts` `searchMemoriesByText` | Same scope and status filters as the vector search; bm25-ranked; every row carries its **true** L2 distance from the question (a lexical hit never gets a made-up distance) and the terms it matched. |
| Fusion | `rag.ts` `fuseChannels` | Reciprocal-rank fusion, k = 60, per memory across the two channels; ties break on distance; results gain `via: vector \| lexical \| both` and `matchedTerms`. A question of only function words skips the channel and behaves exactly as before. The cross-scope invariant runs over the fused list, so it covers both channels. |

Tests: `lexical-terms.test.ts` (10), `lexical-channel.test.ts` (7, real FTS5 + sqlite-vec: a name found
by string with the vector channel blinded to √2 distance; "priyanka" does not match "priya"; scope and
status respected; the index follows deletes; accents; operators as words; the end-to-end refusal of a
name in the unbound client; **the migration backfill on a version-4 file**), `rag.structured.test.ts`
(+5, fusion and the invariant over lexical results).

## Before and after, the harness

Corpus grew first (commit with this document): 10 proper-noun statements, 10 questions that ask by the
noun, 2 controls, and **16 per-client distractors** — the last because the vector channel asks
sqlite-vec for k = 5 per scope and only then applies the 1.3 cut, so a scope of five or six facts comes
back whole for any question and no miss can show. With 13–14 facts per client scope, measured on this
machine, the lexical channel stashed and then live:

| Row | Before | After |
|---|---|---|
| coaching chat, active-only, client-bound | 21/24 (88%), MRR 0.83 | **22/24 (92%)**, MRR 0.83 |
| Rise, client-bound | 22/24 (92%), MRR 0.83 | **23/24 (96%)**, MRR 0.86 |
| Rise, unscoped (the default "New chat") | 13/24 (54%), MRR 0.54 | 13/24 (54%), MRR 0.54 |
| Rise, unscoped + option B inference | 18/24 (75%), MRR 0.65 | **19/24 (79%)**, MRR 0.69 |
| scope/relevance violations, every row | 0 | 0 |

The extra hit in each row is `q-acme-tool` ("Why is Acme unhappy with the tool they use today?" →
"Currently using FleetPilot and unhappy with support response times"): a common-word match the
vector channel had ranked sixth. **All ten proper-noun questions were already hits in the bound rows
before the channel.** The four proper-noun misses in the unscoped rows (Priya, Tellus, Marseille,
Okafor) are client facts in an unbound chat whose names are not client-directory keys — unreachable by
design, and unchanged by this channel; that is the inference directory's limit, not retrieval's.

The relevance control (a first draft listed the Lisbon goal as must-not-surface on an Oslo question)
was redrawn as a scope control: the vector channel surfaces Lisbon for Oslo, a relevance wobble, and
the harness counts must-not-surface as a scope violation — the draft would have failed option B's
invariant for the wrong reason.

## What corpus size makes it measurable — four sweeps, real MiniLM, real db

1. **Scope size, unrelated distractors** (6 → 240 facts in one client scope, six name questions):
   vector-only 6/6 at every size. Sheer size does not break the vector channel; an unrelated fact is far
   from a name question no matter how many there are.
2. **Same-shaped decoys** (0 → 20 per fact, "Marta Kowalski wants the SOC 2 report by Q1" beside
   Priya's): vector-only 6/6, mean rank 1.00, at every count. The name's sub-word pieces are shared
   between question and statement and dominate the similarity.
3. **Question shapes at 10 decoys** (surname only, first name only, possessive, one-word): all rank 1
   in both channels — except **the name buried in a 30-word statement with ten equally long decoys
   plus eleven short ones on the same topic: vector MISS, hybrid rank 3 via lexical.** One case, and it
   is the shape extraction produces (long statements, many facts per topic).
4. **Long statements, decoys 0 → 20**, all six names buried in a preamble: vector-only 6/6 again.
   The miss in sweep 3 needs the short same-topic statements to crowd the top five; length alone is not
   enough.

So: **measurable when at least five statements on the same topic outrank the right one** — many short
facts about the same document, contract or site, and the fact being asked for the longest of them.
That is a density condition, not a size condition, and the corpus does not have it. Revisit when a
real store shows a client scope with more than five facts per topic; I could not measure the
founder's own store (the sandbox cannot read the app profile directory — **not measured**).

## What this means for the decision

- The channel is correct, tested at every layer, costs a migration, and adds ~1/24 on the harness. The
  brain comparison's gap claim was wrong at these sizes and this document supersedes it.
- The migration is the part that is the founder's: it adds an index (derived, dropping it restores the
  file) to every user's `memory.db`. My recommendation is to **keep it**: the cost is one migration
  already proven reversible and backfilled, and the failure it insures against (dense topics, long
  statements) is the shape a store grows into after a year, which no fixture of ours can yet show. The
  alternative — hold the commit until a real store shows the miss — is also defensible and loses
  nothing today.
- Item 3 (extraction baseline) still needs `OPENROUTER_API_KEY` in the founder's own terminal.
