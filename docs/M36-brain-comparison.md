# M36 Stage 3 — the Sales Brain against the frontier: what we have, what is missing, what to close first

**2026-09-06, overnight.** "What we have" is read from `src/main/memory/` tonight, not from
the M25 spec. "Frontier" is the 2025–26 literature and the products that publish their mechanisms:
Mem0's extract-then-ADD/UPDATE/DELETE/NOOP update loop, Zep/Graphiti's bi-temporal graph, Letta
(MemGPT) tiers, MemoryOS's short/mid/long layers with decay, MemoryBank/SAGE's Ebbinghaus forgetting,
MemGuard on contamination, and the LoCoMo benchmark family
([survey of persistent memory and governance](https://arxiv.org/pdf/2606.30306),
[adaptive memory structures](https://arxiv.org/pdf/2602.14038),
[multi-layered memory evaluation](https://arxiv.org/html/2603.29194v1),
[temporal semantic memory](https://arxiv.org/pdf/2601.07468),
[MemGuard](https://arxiv.org/pdf/2605.28009),
[HyMem dynamic retrieval scheduling](https://arxiv.org/pdf/2602.13933),
[Cognee's framework comparison](https://www.cognee.ai/blog/guides/open-source-memory-frameworks-llm-agents),
[Awesome-Memory-for-Agents](https://github.com/TsinghuaC3I/Awesome-Memory-for-Agents)).

## The honest table

| Capability | Frontier shape | What this repo has (from the code) | Gap |
|---|---|---|---|
| **Extraction** | LLM extracts facts; update loop decides ADD/UPDATE/DELETE/NOOP against existing memories (Mem0) | `extraction.ts`: fixed category allowlist (hard guardrail), evidence quote verified against the transcript with a minimum-length floor; `consolidation.ts`: `consolidateNewCandidate` = dedupe/merge/contradict decisions by model, structure by code | Same shape. **Precision/recall never measured** — the harness exists (`memory-quality-eval.test.ts`) and needs any provider key. |
| **Retrieval** | hybrid lexical + vector, reranking, retrieval gating (retrieve only when it helps), multi-hop | `rag.ts`: one local MiniLM-384 embedding + sqlite-vec L2 per scope, distance cut 1.3, top-5; scopes rep / business / one client | **Proper nouns are MiniLM's documented weakness and the corpus stress-tests them.** No lexical channel, no reranker, no gating. Unbound-chat client scope: fixed tonight as option B (57%→93%, OFF, the founder's switch). |
| **Consolidation** | dedupe, merge, episodic→semantic promotion, nightly reflection | present: promotion, nightly reflection (`nightly-consolidation-job.ts`, once per ~20 h, visible as a job), L4 profile compiler (`profile-injection.ts` reads precompiled rows, never an AI call on the hot path) | Same shape. Reflection quality never measured. |
| **Contradiction** | new fact invalidates old; both kept with provenance; some systems keep "as of" versions | statuses `active / hypothesis / invalidated / archived`; `invalidateMemory` when a later fact contradicts; a contradiction test corpus exists (`consolidation.contradiction-hypotheses.test.ts`) | Present. **No "as of" — the old value is invalidated, not dated**, so "what was the budget in June?" cannot be answered. |
| **Temporal reasoning** | bi-temporal (event time vs. recorded time), validity intervals, recency weighting at retrieval (Zep/Graphiti, temporal semantic memory) | evidence carries a `callId`; rows carry write-time timestamps | **Missing.** No `validFrom/validUntil`, no event time, no recency term in ranking. A data-model change — the founder's. |
| **Forgetting / decay** | Ebbinghaus-style decay driven by access and time; pruning of obsolete items | decay in the nightly pass: unreconfirmed hypotheses lose confidence → `hypothesis` → `archived`; archived never surfaces | Present in shape; **decay is time-only, not usage-aware** (a fact retrieved and useful every week decays like one never touched). |
| **Confidence** | per-fact confidence, surfaced to the model with hedging | `confidence` + `importance` per row; hypotheses arrive flagged so callers hedge (spec §5) | Present. Calibration never measured (does 0.4 mean 40%?). |
| **Promotion** | hypothesis → fact on reconfirmation; episodic → semantic | present (deterministic code) | Present. |
| **Contamination / false memory** | MemGuard-style checks; LoCoMo reports a false-memory rate | evidence-quote verification at extraction; exclusion/forget paths tested (`exclusion-forgets.test.ts`) | **False-memory rate never measured.** |
| **Scope isolation** | per-user/per-entity partitions | rep / business / client scopes; cross-client invariant by construction; harness asserts zero violations | Strong. Kept at zero tonight under option B. |

**Summary:** the shapes are all here — this module is not behind the frontier in architecture.
It is behind in three places that are each a measurement first: retrieval on proper nouns, time,
and the extraction/false-memory numbers that have never been taken.

## What to close, in order, each with its number

1. **Option B** — done tonight, measured 57% → 93%, zero violations. Switch is the founder's.
2. **A lexical channel beside the vector one** (BM25/FTS5 over statements and evidence, fused
   with the vector rank). The corpus's proper-noun questions are the measurement; the harness
   already prints per-question hits, so the before/after is one run. No data-model change: FTS5
   is an index over existing columns.
3. **Extraction baseline** — one command once a key is in the environment
   (`CALLRISE_EVAL=1 npx vitest run src/main/memory/__tests__/memory-quality-eval.test.ts`).
   Precision, recall per category, and — added to the harness — a false-memory count (facts
   extracted that no transcript sentence supports). Before any prompt change.
4. **Usage-aware decay** — a `lastRetrievedAt` touch on retrieval and a decay term that respects
   it. Data-model change (one column) → the founder's decision; measured on the longitudinal
   fixture (`longitudinal.test.ts`) as "useful facts that survive N nights".
5. **Temporal validity** — `validFrom/validUntil` on facts, event time from the call date, a
   recency term at retrieval, and "as of" answers. The largest change and a data-model change;
   its measurement is a new corpus of dated contradictions (the contradiction fixture extended
   with dates).
6. **Confidence calibration** — once (3) exists: bucket extracted confidences and count how often
   each bucket survives reconfirmation.

Items 2 and 3 need no decision; 4 and 5 need the founder; 6 needs 3.

## What this document does not claim

No number here beyond tonight's harness rows is measured. The frontier descriptions are from the
cited papers' own abstracts and product pages, not from running those systems. LoCoMo-style
figures quoted in the literature are not comparable to this repo's harness (different corpus,
different questions) and are not used as targets.
