// TWO unions in this feature are each declared THREE TIMES, independently,
// and nothing makes the copies meet:
//
//   DealStageKind    main/deal-stages.ts · renderer/features/deals/types.ts · preload/index.d.ts
//   BackfillAnswer   main/deal-outcomes.ts · renderer/features/deals/types.ts · preload/index.d.ts
//
// THIS TEST EXISTS BECAUSE THE DIVERGENCE WAS SILENT. On 2026-08-31, adding
// 'went-quiet' to main's DealStageKind left the other two untouched and
// `npm run typecheck` stayed **completely green** — the renderer simply went
// on describing a world with three outcomes while main had four. Nothing
// forces the declarations to agree, so nothing noticed.
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
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..', '..')
const RENDERER_TYPES = join(ROOT, 'src', 'renderer', 'src', 'features', 'deals', 'types.ts')
const PRELOAD_TYPES = join(ROOT, 'src', 'preload', 'index.d.ts')
const OUTCOMES = join(ROOT, 'src', 'main', 'deal-outcomes.ts')

const SOURCES = {
  main: {
    path: join(ROOT, 'src', 'main', 'deal-stages.ts'),
    re: /export type DealStageKind =([^\n]+)/
  },
  renderer: { path: RENDERER_TYPES, re: /export type DealStageKind =([^\n]+)/ },
  preload: { path: PRELOAD_TYPES, re: /export type DealStageKind =([^\n]+)/ }
}

/** `BackfillAnswer` is declared three times for exactly the same reason, and
 *  drifts exactly the same way. Same treatment. */
const ANSWER_SOURCES = {
  main: { path: OUTCOMES, re: /export type BackfillAnswer =([^\n]+)/ },
  renderer: { path: RENDERER_TYPES, re: /export type BackfillAnswer =([^\n]+)/ },
  preload: { path: PRELOAD_TYPES, re: /export type BackfillAnswer =([^\n]+)/ }
}

/** The quoted members of a union declaration, as a sorted set. Refuses rather
 *  than returning an empty set: a renamed type or a reformatted declaration
 *  must fail loudly here, not silently compare [] to [] and pass. */
function membersOf(path: string, re: RegExp): string[] {
  const src = readFileSync(path, 'utf8')
  const m = src.match(re)
  if (!m) {
    throw new Error(
      `Could not find ${re} in ${path}. If it moved or was renamed, update this test — ` +
        'do NOT delete it: it is the only thing keeping the three declarations in step, ' +
        'and they have already drifted once.'
    )
  }
  const members = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  if (members.length === 0) throw new Error(`No quoted members parsed from ${path}: ${m[1]}`)
  return members.sort()
}

const kindsIn = (name: keyof typeof SOURCES): string[] =>
  membersOf(SOURCES[name].path, SOURCES[name].re)

const answersIn = (name: keyof typeof ANSWER_SOURCES): string[] =>
  membersOf(ANSWER_SOURCES[name].path, ANSWER_SOURCES[name].re)

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

describe('BackfillAnswer is declared three times and they must agree', () => {
  it('main and the renderer declare the same answers', () => {
    expect(answersIn('renderer'), 'renderer/features/deals/types.ts has drifted').toEqual(
      answersIn('main')
    )
  })

  it('main and the preload bridge declare the same answers', () => {
    expect(answersIn('preload'), 'preload/index.d.ts has drifted').toEqual(answersIn('main'))
  })

  it("...and both 'dont-remember' and 'not-a-deal' really are among them", () => {
    // The control, and it guards something specific. These two are the answers
    // a well-meaning simplification deletes ("a skip is a skip"), and deleting
    // them is silent: the union narrows, all three copies narrow together, the
    // typecheck stays green, and the backfill quietly loses the only signal it
    // has for telling the founder their own sample cannot be trusted.
    for (const name of ['main', 'renderer', 'preload'] as const) {
      expect(answersIn(name), `${name} is missing 'dont-remember'`).toContain('dont-remember')
      expect(answersIn(name), `${name} is missing 'not-a-deal'`).toContain('not-a-deal')
    }
  })
})

describe('the gate is only reachable through evaluateGate', () => {
  // STAGE 2 ITEM 4, and the reason it is a test rather than a convention.
  //
  // `Insight` is a discriminated union so that "there is not enough data" is a
  // different SHAPE from "here is a finding" — the insufficient arm has no
  // analysis number on it to leak. But a union only protects what goes through
  // it. Any file that hand-builds { status: 'ready', ... }, or re-derives the
  // bar with its own comparison against MIN_PER_ARM, has routed around the gate
  // entirely — and nothing in the type system would notice, because the object
  // it produced still typechecks perfectly.
  const SRC = join(ROOT, 'src')

  function walk(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...walk(full))
      // .js/.mjs/.cjs too — three plain-JS files already live under src and
      // electron-vite bundles them like any other module. An extension filter
      // that admits only TypeScript is a door the scan never watches.
      else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) out.push(full)
    }
    return out
  }

  // Enumerate the CONTAINER, not a hand-written list of files. A filename test
  // cannot fail on a filename nobody thought of — and that is precisely the
  // file that would route around the gate.
  const files = walk(SRC).filter((f) => !f.includes('__tests__'))

  it('the whole source tree is actually being searched', () => {
    // The control. Without it a broken walk() returns [] and both assertions
    // below pass by searching nothing at all.
    expect(
      files.length,
      'walk() found no source files — the checks below would be vacuous'
    ).toBeGreaterThan(100)
    expect(files.some((f) => f.endsWith('deal-outcomes.ts'))).toBe(true)
  })

  // DECLARING the shape is not CONSTRUCTING one. The renderer and the preload
  // bridge both have to declare `Insight` — they cannot import main's copy,
  // which is the whole reason the lockstep suites above exist — so a bare
  // search for `status: 'ready'` flags them, and the first version of this
  // test did. What must not exist anywhere else is a VALUE: an object literal
  // in a return, an assignment, or an arrow body.
  //
  // Stated plainly, because a guard that overstates its reach is worse than a
  // narrow one: this catches `return { status: 'ready' … }`,
  // `const x = { status: 'ready' … }` and `() => ({ status: 'ready' … })`. It
  // would not catch a value assembled field-by-field across several
  // statements. That is a deliberate trade — those three forms are how a
  // shortcut actually gets written, and a looser pattern re-flags the two
  // declarations it took this comment to exclude.
  // [\s\S]{0,400}? rather than [^}]*: the original stopped at the first
  // closing brace, so a literal whose NESTED object came before the status
  // key — return { usable: { won: 8 }, status: 'ready' } — slipped through.
  // Double quotes accepted for the same reason. The declaration shapes stay
  // excluded because a union arm is preceded by '|', which none of the
  // construction openers here match. Workflow finding on the test itself.
  const CONSTRUCTS_READY = /(?:return|=>?)\s*\(?\s*\{[\s\S]{0,400}?status:\s*['"]ready['"]/

  it("nothing outside deal-outcomes.ts constructs a 'ready' insight", () => {
    const offenders = files.filter(
      (f) => !f.endsWith('deal-outcomes.ts') && CONSTRUCTS_READY.test(readFileSync(f, 'utf8'))
    )
    expect(
      offenders.map((f) => f.slice(SRC.length + 1)),
      'a file builds a ready insight without going through evaluateGate'
    ).toEqual([])
  })

  it('the pattern matches the ONE real construction site, exactly once', () => {
    // Ties the pattern to the live discriminant. Without this, renaming
    // 'ready' in deal-outcomes.ts would leave the offenders scan matching
    // nothing anywhere, permanently green, with its string-fixture control
    // still passing — a scan of the whole tree for a word the tree no longer
    // contains. Workflow finding: the control never touched the real site.
    const src = readFileSync(join(SRC, 'main', 'deal-outcomes.ts'), 'utf8')
    const matches = src.match(new RegExp(CONSTRUCTS_READY.source, 'g')) ?? []
    expect(
      matches.length,
      "deal-outcomes.ts's own ready-construction no longer matches the pattern — the scan is blind"
    ).toBe(1)
  })

  it('...and that pattern really does recognise a constructed one', () => {
    // The control for the check itself. Without it, a pattern tightened until
    // it matched nothing would look exactly like a clean tree — which is the
    // precise mistake that produced the version this replaced, in reverse.
    expect(CONSTRUCTS_READY.test("return { status: 'ready', counts, usable }")).toBe(true)
    expect(CONSTRUCTS_READY.test("const fake: Insight = { status: 'ready', counts, usable }")).toBe(
      true
    )
    expect(CONSTRUCTS_READY.test("const f = () => ({ status: 'ready', counts, usable })")).toBe(true)
    // The two evasions the first pattern missed:
    expect(
      CONSTRUCTS_READY.test("return { usable: { won: 8, lost: 8 }, status: 'ready' }"),
      'a nested object before the status key evaded the scan'
    ).toBe(true)
    expect(CONSTRUCTS_READY.test('return { status: "ready", counts }')).toBe(true)
    // ...and does NOT flag the union declaration the mirrors are required to have.
    expect(
      CONSTRUCTS_READY.test(
        "export type Insight =\n  | { status: 'insufficient'\n      counts: OutcomeCounts\n    }\n  | { status: 'ready'\n      counts: OutcomeCounts\n    }"
      )
    ).toBe(false)
  })

  it('nothing outside deal-outcomes.ts re-derives the per-arm bar', () => {
    // STATED LIMIT (workflow finding, accepted): this scan sees only the
    // NAME. A second gate written with the literal — usable.won >= 8 — is
    // invisible to it, and no grep can distinguish that 8 from any other. The
    // real defence is the review habit this comment plants: a hand-copied bar
    // is two gates that disagree the moment one is edited.
    // MIN_PER_ARM may be READ anywhere — the counter prints it, and printing
    // the real constant is exactly right. What may not happen anywhere else is
    // a second COMPARISON against it: that is a second gate, and two gates
    // disagree the moment one of them is edited.
    const offenders = files.filter(
      (f) =>
        !f.endsWith('deal-outcomes.ts') &&
        /[<>]=?\s*MIN_PER_ARM|MIN_PER_ARM\s*[<>]=?/.test(readFileSync(f, 'utf8'))
    )
    expect(
      offenders.map((f) => f.slice(SRC.length + 1)),
      'a second implementation of the gate exists'
    ).toEqual([])
  })
})
