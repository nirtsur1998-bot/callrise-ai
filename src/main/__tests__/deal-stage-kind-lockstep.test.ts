// `DealStageKind` is declared THREE TIMES, independently, and nothing makes
// the copies meet.
//
//   1. src/main/deal-stages.ts                      — the real one
//   2. src/renderer/src/features/deals/types.ts     — renderer cannot import main
//   3. src/preload/index.d.ts                       — ambient, imports nothing
//
// THIS TEST EXISTS BECAUSE THE DIVERGENCE WAS SILENT. On 2026-08-31, adding
// 'went-quiet' to (1) left (2) and (3) untouched and `npm run typecheck`
// stayed **completely green** — the renderer simply went on describing a world
// with three outcomes while main had four. Nothing forces the declarations to
// agree, so nothing noticed.
//
// That is taxonomy principle 8, independently-wrong agreement: every layer
// narrowed the same way, so they agreed with each other instead of with
// reality. Same remedy as `provider-lockstep.test.ts` uses for the preload
// bridge's inline unions — read the other files as TEXT and assert they match,
// because a type system that cannot see across the boundary will never do it.
//
// Deliberately compares the SET, not the source text: reordering the members
// or re-wrapping the line is not drift, and a guard that fails on formatting
// gets deleted by the first person it annoys (species 57's lesson).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..', '..')

const SOURCES = {
  main: {
    path: join(ROOT, 'src', 'main', 'deal-stages.ts'),
    re: /export type DealStageKind =([^\n]+)/
  },
  renderer: {
    path: join(ROOT, 'src', 'renderer', 'src', 'features', 'deals', 'types.ts'),
    re: /export type DealStageKind =([^\n]+)/
  },
  preload: {
    path: join(ROOT, 'src', 'preload', 'index.d.ts'),
    re: /export type DealStageKind =([^\n]+)/
  }
}

/** The quoted members of a union declaration, as a sorted set. Refuses rather
 *  than returning an empty set: a renamed type or a reformatted declaration
 *  must fail loudly here, not silently compare [] to [] and pass. */
function kindsIn(name: keyof typeof SOURCES): string[] {
  const { path, re } = SOURCES[name]
  const src = readFileSync(path, 'utf8')
  const m = src.match(re)
  if (!m) {
    throw new Error(
      `Could not find "export type DealStageKind =" in ${path}. If it moved or was ` +
        'renamed, update this test — do NOT delete it: it is the only thing keeping the ' +
        'three declarations in step, and they have already drifted once.'
    )
  }
  const members = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  if (members.length === 0) throw new Error(`No quoted members parsed from ${path}: ${m[1]}`)
  return members.sort()
}

describe('DealStageKind is declared three times and they must agree', () => {
  it('main and the renderer declare the same kinds', () => {
    expect(kindsIn('renderer'), 'renderer/features/deals/types.ts has drifted from main').toEqual(
      kindsIn('main')
    )
  })

  it('main and the preload bridge declare the same kinds', () => {
    expect(kindsIn('preload'), 'preload/index.d.ts has drifted from main').toEqual(kindsIn('main'))
  })

  it("...and 'went-quiet' really is among them, in all three", () => {
    // The control. Without this the three could agree on a stale set and every
    // assertion above would pass while the feature was gone — three copies of
    // the same wrong answer is exactly principle 8's failure mode, and equality
    // alone cannot tell "all correct" from "all identically wrong".
    for (const name of ['main', 'renderer', 'preload'] as const) {
      expect(kindsIn(name), `${name} is missing 'went-quiet'`).toContain('went-quiet')
    }
  })

  it('the closed-outcome list covers every non-open kind', () => {
    // CLOSED_STAGE_KINDS is derived once in main so callers stop hand-writing
    // "the closed ones". If a fifth kind is added and left out of it, a real
    // outcome silently stops counting as closed — which would make the Stage 2
    // counter under-report and the gate never open.
    const src = readFileSync(SOURCES.main.path, 'utf8')
    const m = src.match(/CLOSED_STAGE_KINDS: readonly DealStageKind\[\] = \[([^\]]+)\]/)
    expect(m, 'CLOSED_STAGE_KINDS not found in main/deal-stages.ts').toBeTruthy()
    const closed = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort()
    const nonOpen = kindsIn('main').filter((k) => k !== 'open')
    expect(closed, 'a kind exists that is neither open nor listed as closed').toEqual(nonOpen)
  })
})
