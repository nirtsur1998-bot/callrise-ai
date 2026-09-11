// @vitest-environment node
//
// THE RULE THE FOUNDER MADE STRUCTURAL, 2026-09-11:
//
//   "Any verification script that renders something the product also renders
//    should call the product's function or fail. If that isn't possible for a
//    given check, the report says 'measured by re-implementation' beside the
//    number, every time, so a reader knows which kind of evidence they're
//    holding."
//
// WHY. It cost three findings in one milestone, all the same shape:
//   1. `m39-dossier-measure.ts` resolved the deal stage from deal-stages.json
//      while `dossier-store.ts` passed `stageLabel: null`. The MEASURED dossier
//      had a stage; the shipped one did not, for three commits and one
//      screenshot sent to the founder (BUG-269).
//   2. The same script timed `buildClientDossier` over arrays already in
//      memory — 0.07 ms, reported as "0.00% of the baseline" — while the
//      function the product calls reads five directories first: 281–441 ms.
//   3. `m39-render-dossier.tsx` reproduced the null-stage bug faithfully, so
//      the screenshot agreed with the broken product by accident and would
//      have disagreed with the fixed one silently.
//
// A verification script that re-implements a step leaves that step unverified
// BY CONSTRUCTION. No amount of care inside the script changes that; the only
// fixes are to enter where the product enters, or to say out loud that you
// did not.
//
// ─── WHAT THIS TEST CAN AND CANNOT DO ──────────────────────────────────────
// It is a REGISTRY, not an analysis. It knows about the builder→entry-point
// pairs listed below and nothing else; a re-implementation of some function
// nobody has registered passes silently. That is a real limit and the reason
// the registry lives here, where adding a pair is one line, rather than in a
// comment somebody has to remember. It is strictly better than the note at the
// top of a file it replaces, and strictly weaker than a checker that could
// understand what a script is doing.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const SCRIPTS = join(__dirname, '..', '..', '..', 'scripts', 'verification')

/** The label a script must print beside its numbers when it genuinely cannot
 *  enter at the product's entry point. Exact string, because a reader greps
 *  for it. */
export const REIMPL_LABEL = 'measured by re-implementation'

/**
 * Each row: a function that ASSEMBLES something the product also assembles, and
 * the entry point the product actually calls. A script importing the builder
 * must either import the entry point too, or carry the label.
 *
 * Add a row whenever a new builder gains a product-side wrapper that does more
 * than the builder does — reads records, resolves an id, applies a cap.
 */
const PAIRS: { builder: string; entry: string; why: string }[] = [
  {
    builder: 'buildClientDossier',
    entry: 'ensureDossier',
    why: 'ensureDossier reads five directories and resolves the deal stage; the builder does neither'
  }
]

const files = readdirSync(SCRIPTS).filter((f) => /\.(ts|tsx|mjs|js)$/.test(f))

/** Comments stripped: a guard that matches the paragraph explaining the guard
 *  is a guard flagging its own documentation, which has happened three times
 *  in this milestone. The LABEL is matched against the original text, because
 *  a script prints it at runtime and may well explain it in a comment too. */
const strip = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

describe('verification scripts enter at the product, or say they did not', () => {
  it('found the verification scripts (a silent zero would make this vacuous)', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  for (const { builder, entry, why } of PAIRS) {
    it(`any script using ${builder} either calls ${entry} or is labelled`, () => {
      const offenders: string[] = []
      for (const f of files) {
        const raw = readFileSync(join(SCRIPTS, f), 'utf8')
        const code = strip(raw)
        if (!new RegExp(`\\b${builder}\\b`).test(code)) continue
        if (new RegExp(`\\b${entry}\\b`).test(code)) continue
        // The escape hatch — deliberate, and it costs the script a visible
        // admission in its own OUTPUT, not a comment.
        if (raw.includes(REIMPL_LABEL)) continue
        offenders.push(f)
      }
      expect(
        offenders,
        `These scripts call ${builder} without going through ${entry}.\n` +
          `  ${why}.\n` +
          `Either route the script through ${entry}, or print the exact string\n` +
          `  "${REIMPL_LABEL}"\n` +
          `beside every number it reports, so a reader knows which kind of\n` +
          `evidence they are holding. See BUG-269 for what this costs when it\n` +
          `goes unnoticed.`
      ).toEqual([])
    })
  }

  it('the escape hatch is used by a script that prints it, not merely mentions it', () => {
    // A script that "carries the label" must put it where the READER of the
    // output sees it. Checking that it appears inside a console.log — rather
    // than anywhere in the file — is the difference between an admission and a
    // comment nobody reads.
    for (const f of files) {
      const raw = readFileSync(join(SCRIPTS, f), 'utf8')
      if (!raw.includes(REIMPL_LABEL)) continue
      const printed = new RegExp(
        `console\\.(log|error|warn)\\([^)]*${REIMPL_LABEL.replace(/ /g, '\\s')}`,
        's'
      ).test(raw)
      expect(printed, `${f} carries the label but never prints it`).toBe(true)
    }
  })
})
