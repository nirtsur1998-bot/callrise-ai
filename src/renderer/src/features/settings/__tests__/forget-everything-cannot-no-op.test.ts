// BUG-237 — a destructive button that silently does nothing.
//
// FOUND ON THE PACKAGED BUILD during the M37 release walk, one step before
// someone pressed it. The Memory Center rendered its enabled danger button
// "Forget everything" even with Sales Brain SWITCHED OFF, under a confirm
// dialog reading "This cannot be undone". The handler's first line is
// `if (!isSalesBrainEnabled()) return { ok: false }`, and the renderer threw
// the result away:
//
//     await window.api.salesBrain.memories.forgetEverything()
//     refresh()
//
// So: confirm an irreversible action, nothing happens, screen unchanged, no
// message. The user cannot tell "erased" from "did nothing".
//
// That is the SAME SHAPE as two bugs this milestone already fixed — BUG-204 (a
// delete filtered to zero rows returning byte-identical success) and BUG-228 (a
// title failure indistinguishable from the feature being off) — sitting in the
// erase path the milestone was largely about. Three instances of one shape is
// what makes it worth a guard rather than a fix.
//
// A source-level guard rather than a render test on purpose: both halves are
// structural (which branch renders, and whether a return value is read), and
// both are the kind of thing a later refactor silently undoes.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE = readFileSync(
  join(__dirname, '..', 'MemoryCenterSection.tsx'),
  'utf8'
)
const HANDLER = readFileSync(
  join(__dirname, '..', '..', '..', '..', '..', 'main', 'memory', 'memory-center-ipc.ts'),
  'utf8'
)

describe('BUG-237 — Forget everything cannot silently no-op', () => {
  it('the HANDLER still refuses when Sales Brain is off, which is what makes the UI guard necessary', () => {
    // The code half, asserted FIRST (species 90): if this refusal ever goes
    // away, the UI guard below is protecting against nothing and this test
    // should be the thing that says so.
    const fn = HANDLER.slice(HANDLER.indexOf("'salesBrain:memories:forgetEverything'"))
    expect(fn.slice(0, 600)).toContain('if (!isSalesBrainEnabled()) return { ok: false }')
  })

  it('the destructive button is not OFFERED when Sales Brain is off', () => {
    // The whole card is behind salesBrainOn. Asserted on the branch, not on
    // the button's disabled prop: a disabled button under a "cannot be undone"
    // dialog would still be the wrong thing to show.
    expect(SOURCE).toMatch(/\{salesBrainOn \? \(/)
    const offBranch = SOURCE.slice(SOURCE.indexOf('Sales Brain is switched off, so there is nothing'))
    expect(
      offBranch.slice(0, 400),
      'the off-state should explain why there is nothing to forget'
    ).toContain('Turn it on above')
  })

  it('the result of the erase is READ, not discarded', () => {
    // Comments stripped FIRST. The first version of this guard matched the
    // call quoted inside its own explanatory comment and reported the bug it
    // was written to prevent — the same mistake the locality guard made, and
    // the reason that one strips comments too.
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
    const call = /await window\.api\.salesBrain\.memories\.forgetEverything\(\)/.exec(code)
    expect(call, 'the erase call moved — update this guard with it').not.toBeNull()
    const line = code.slice(code.lastIndexOf('\n', call!.index) + 1, call!.index + call![0].length)
    expect(
      /\b(const|let|var)\s+\w+\s*=\s*await/.test(line),
      `the erase result is discarded again: "${line.trim()}"`
    ).toBe(true)
  })

  it('a failed erase says so instead of looking like a success', () => {
    expect(SOURCE).toContain('setForgetError')
    expect(SOURCE).toContain('Nothing was erased')
    // and it must say the data is still there — "failed" alone leaves the user
    // unsure whether a partial erase happened.
    expect(SOURCE).toContain('Your memories are still here')
  })
})
