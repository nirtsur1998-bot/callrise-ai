// AUDIT FIX (2026-08-24) — the capability-needs shape, split out so
// capability-copy.ts can stay a dependency-free leaf (see its header for why
// that matters to the tests). complete-with-fallback.ts re-exports this type
// so no existing import path had to change.

export interface ChainCapabilityNeeds {
  needsTool?: boolean
  /** M28 Part 3 — the request carries images; only vision-capable steps may run it. */
  needsVision?: boolean
  /** AUDIT FIX (2026-08-24) — the request carries a PDF. Previously nothing
   *  set this need, so documents went to every model in the chain and each
   *  rejection blacklisted a model for four hours across every purpose. */
  needsDocument?: boolean
  /** BUG-259 — the whole answer is meant to be ONE SHORT LINE (a call title,
   *  a label), so a model that emits chain-of-thought until it hits the
   *  ceiling cannot serve it at any budget. Measured on nemotron-3.5-lightning
   *  2026-09-10: 60, 400 and 1500 tokens all came back mid-thought, and the
   *  bigger budgets were worse — at 1500 a reasoning fragment slipped past the
   *  title validator. Excludes catalog entries flagged `unboundedReasoning`. */
  needsBoundedOutput?: boolean
}
