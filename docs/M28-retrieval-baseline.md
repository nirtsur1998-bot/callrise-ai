# M28 Phase 2 — retrieval quality: baseline → fix → after

Environment for every number here: this Windows dev machine, worktree
`callrise-m28`, real local MiniLM-L6-v2 embeddings (no API key), a real
sqlite-vec database seeded from the golden corpus
(`src/main/memory/__tests__/fixtures/retrieval-eval-corpus.ts`: 24 memories
across rep/business/two client scopes incl. 3 hypotheses + 4 distractors),
14 questions incl. paraphrase, proper-noun, hypothesis-gated, and
scope-isolation controls. Harness:
`src/main/memory/__tests__/retrieval-quality-eval.test.ts` — report written
to `retrieval-eval-report.log` at the repo root on every run.

## The finding (BUG-080)

`vec_memories` is a plain `vec0` virtual table, so distances are EUCLIDEAN
(L2). `rag.ts`'s `MAX_DISTANCE = 0.6` was written in cosine-distance terms;
in L2 on unit vectors it demands ~82% cosine similarity — near-verbatim
restatement. Diagnostic probe: a verbatim query scores distance 0.0000 and
the correct answer ranks FIRST for every probe, but natural paraphrases land
at L2 ~1.0–1.25 and were all rejected. **Shipped behavior since M25: the
coaching chat's question-scoped memory retrieval returns nothing for
essentially every real question.** The profile injection (compiled profiles)
masked it — the chat still knew things, it just never used question-scoped
recall.

Consolidation's `DUPLICATE_VECTOR_DISTANCE_THRESHOLD = 0.35` lives on the
same L2 scale and is deliberately UNCHANGED: dedupe/contradiction should
demand near-identity, and loosening it would silently change C1 semantics.

## Baseline (shipped 0.6)

| Config | recall@5 | MRR | empty answers | scope violations |
|---|---|---|---|---|
| active-only (coaching chat) | 0/14 (0%) | 0.00 | 13/13 | 0 |
| active+hypotheses (Rise) | 0/14 (0%) | 0.00 | 13/13 | 0 |

## Threshold sweep (active+hypotheses)

| maxDistance | recall@5 | MRR | empty | violations |
|---|---|---|---|---|
| 0.6 (shipped) | 0% | 0.00 | 13/13 | 0 |
| 1.0 | 14% | 0.15 | 11/13 | 0 |
| 1.1 | 36% | 0.38 | 7/13 | 0 |
| 1.2 | 79% | 0.72 | 2/13 | 0 |
| 1.25 | 86% | 0.72 | 2/13 | 0 |
| **1.3 (chosen)** | **93%** | **0.79** | **0/13** | **0** |
| 1.4 | 93% | 0.79 | 0/13 | 0 |

1.4 adds nothing over 1.3; 1.3 eliminates empty answers entirely. Chosen: 1.3.

**Why this is an operating point rather than a tuned number (stated explicitly, founder 2026-08-24).** 1.3 sits at the **start of a plateau**: 1.25 gives 86%, 1.3 gives 93%, and 1.4 gives 93% again — the curve flattens, so the choice is where the gain stops rather than where a target is met. That distinction is what makes the number trustworthy or not, so it should not be left implicit: a threshold picked to hit a goal moves whenever the goal moves, while an operating point picked off a plateau is stable under re-measurement and is falsifiable — if a future embedding or ranking change moves the plateau, the sweep says so on the next run. **The sweep is re-run in full on every harness run, including the 0.6 row**, so the pre-M28 collapse is re-measured every time rather than remembered.

## After (1.3)

| Config | recall@5 | MRR | empty answers | scope violations |
|---|---|---|---|---|
| active-only (coaching chat) | 12/14 (86%) | 0.76 | 0/13 | 0 |
| active+hypotheses (Rise) | 13/14 (93%) | 0.79 | 0/13 | 0 |
| **Rise, UNSCOPED conversation** | **8/14 (57%)** | **0.53** | **0/13** | **0** |

The +1 between the first two configs is exactly the hypothesis-gated question
— the Rise configuration's designed win, now demonstrated by measurement.

### Read the 93% correctly (added 2026-08-24)

The first two rows supply each question's own `contactId`. That models a
conversation **already bound to exactly the client being asked about**. Rise
passes `scope?.contactId ?? null` (`assistant-ipc.ts:270`), so a conversation
with no client bound — the default "New chat" — sends `null`, and
`rag.ts:105` builds its scope list as
`['rep','business', ...(contactId ? [clientScope(contactId)] : [])]`. Every
`client:*` memory is then unreachable **by construction**.

That is the third row: **57%**, with all six lost questions being the client
ones. Both numbers are real; they describe different situations, and only the
third describes the default one.

The recall drop is not the dangerous part. **Empty answers stay 0/13** — the
client questions do not come back empty, they come back with generic
business-scope memories. Asked *"who makes the buying decisions at Acme?"* in
an unscoped chat, retrieval returns `b-icp`, `b-objection-impl`, `b-product`,
and Rise answers confidently from the wrong context instead of saying it does
not know. That is the credibility trap `M28-rise.md:54-58` describes, reached
through a different door than the one that doc guards.

The harness now measures and gates this configuration, floored at its current
value (8) as a collapse detector rather than an aspiration, plus an invariant
that scoped recall can never fall below unscoped. Raising 57% is Phase 2
design work — see the ranking weaknesses below, and note that scope selection
is now the larger of the two problems.

## Known remaining weaknesses (measured, deliberately not "fixed" tonight)

- `q-acme-tool` still misses (`ca-current-tool` outranked by business-scope
  competitor memories) — a RANKING problem, not a threshold problem. The
  reranking / importance-weighting work the brief schedules for Phase 2
  starts from this number.
- Distractors appear mid-list at 1.3 (e.g. `d-tuesday-hyp` above
  `r-weak-close` on one question) — same ranking bucket.
- Proper-noun questions pass here because scope narrowing carries them;
  cross-client keyword search (no FTS fallback) remains untested territory.
