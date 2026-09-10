// BUG-259 — a model that never stops thinking cannot serve a one-line purpose.
//
// MEASURED 2026-09-10 against the app's own title prompt
// (scripts/verification/bug259-maxtokens.cjs):
//
//   qwen3.8-27b     7-9 output tokens, answers straight away
//   gpt-oss-20b     80-135; at the shipped ceiling of 60 it returned EMPTY
//   gpt-oss-120b    151-199; same — all the budget went to a `reasoning`
//                   field, so the app got nothing and fell back to the date
//   nemotron-3.5    NEVER finishes: 60, 400 and 1500 all came back
//                   mid-thought, first line literally "Here's a thinking
//                   process:" — the string that reached the founder's list.
//                   At 1500 its reasoning even produced a fragment ("Yes, 5
//                   words") that PASSED the title validator.
//
// So the two fixes are different: the gpt-oss family needed a bigger ceiling,
// nemotron needed removing from the chain. A bigger budget made it worse.
import { describe, expect, it } from 'vitest'
import { MODEL_CATALOG } from '../model-catalog'

describe('BUG-259 — the unboundedReasoning flag', () => {
  it('is set on the model that produced the founder’s garbage titles', () => {
    const nemotron = MODEL_CATALOG.find((m) => m.id === 'openrouter-nemotron-3.5-lightning')
    expect(nemotron).toBeDefined()
    expect(nemotron?.unboundedReasoning).toBe(true)
  })

  it('is NOT set on the models a bigger ceiling rescued', () => {
    // These are excluded from nothing: they answer correctly at 400. Flagging
    // them would remove three working models to fix one broken one.
    for (const id of ['groq-gpt-oss-120b', 'groq-qwen3.8-27b']) {
      const m = MODEL_CATALOG.find((x) => x.id === id)
      expect(m, id).toBeDefined()
      expect(m?.unboundedReasoning, id).toBeUndefined()
    }
  })

  it('is a POSITIVE flag — undefined means "assumed to terminate"', () => {
    // Same discipline as supportsVision, opposite of supportsToolCalling. A
    // newly added entry is never silently excluded from a bounded purpose;
    // exclusion always requires someone to have measured it and said so.
    const flagged = MODEL_CATALOG.filter((m) => m.unboundedReasoning === true)
    expect(flagged.length).toBeGreaterThan(0)
    expect(flagged.length).toBeLessThan(MODEL_CATALOG.length)
    for (const m of MODEL_CATALOG) {
      expect([true, undefined]).toContain(m.unboundedReasoning)
    }
  })
})

describe('BUG-259 — the title call declares what it needs', () => {
  it('asks for a bounded answer and a ceiling big enough for the measured worst case', async () => {
    // Pinned as SOURCE rather than behaviour on purpose: the alternative is
    // mocking the whole provider chain to observe two numbers, and the numbers
    // are the claim. 199 is gpt-oss-120b's measured spend; 400 is the ceiling.
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../../call-title.ts', import.meta.url), 'utf8')
    expect(src).toContain('const MAX_TITLE_TOKENS = 400')
    // BOTH attempts — the tool path and the prose path. The prose path is the
    // one that produced the garbage, but a reasoning model calling the tool
    // would put its reasoning in the title field just as happily.
    expect(src.match(/needsBoundedOutput: true/g)?.length).toBe(2)
    expect(src.match(/maxTokens: MAX_TITLE_TOKENS/g)?.length).toBe(2)
    // And the old ceiling is genuinely gone, not merely shadowed.
    expect(src).not.toContain('maxTokens: 60')
  })
})
