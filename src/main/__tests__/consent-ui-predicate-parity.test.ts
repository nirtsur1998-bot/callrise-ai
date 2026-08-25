// BUG-119 — PIN THE ONE CONDITION THAT HAD TO BE DUPLICATED.
//
// `coachingHistoryDropped` decides whether a call's coaching thread is dropped
// for lack of recording consent. The guard in src/main/calls-fs.ts uses it to
// decide what to strip; the renderer uses it to decide whether to explain the
// absence. They must agree, or the rep is either told nothing when their
// history was dropped, or told it was dropped when it never existed.
//
// The renderer cannot import the main-side copy: src/main is outside its
// tsconfig scope. This codebase meets that boundary in three other places
// (calendarMatch.ts, DetectionOverlay.tsx, holdsUnreviewedOutput.ts) and each
// resolved it with a duplicate and a "keep in sync" comment — principle 8's
// own tell for a correspondence that drifts, because a comment is an
// instruction to a future reader who will not read it.
//
// Derivation is unavailable across this boundary, so this is the strongest
// version that IS available: the duplicate stays, and divergence becomes RED
// instead of silent. Same move as `cancellable` defaulting to false — make
// forgetting fail loudly rather than trying to remember harder.
//
// THE PART THAT IS EASY TO GET WRONG, and what this test really protects:
// `consent != null &&`. applyConsentRetention early-returns when there is NO
// consent record, so a legacy call without one is never stripped.
// `recordOtherParty !== true` alone is TRUE for such a call. Dropping that half
// from either copy would tell every legacy call's owner that their coaching
// history had been discarded when nothing was touched — and nothing else in
// the suite would notice.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Pull the single return expression out of a `coachingHistoryDropped` body. */
function conditionFrom(source: string, file: string): string {
  const at = source.indexOf('export function coachingHistoryDropped')
  expect(at, `coachingHistoryDropped is gone from ${file}`).toBeGreaterThan(-1)
  const body = source.slice(at, source.indexOf('\n}', at))
  const ret = body.split('\n').find((l) => l.trim().startsWith('return '))
  expect(ret, `no return statement in ${file}'s coachingHistoryDropped`).toBeTruthy()
  return ret!.trim().replace(/\s+/g, ' ')
}

describe('BUG-119 — the duplicated consent predicate is pinned, not trusted', () => {
  const mainSrc = readFileSync(join(__dirname, '..', 'calls-fs.ts'), 'utf8')
  const rendererSrc = readFileSync(
    join(__dirname, '..', '..', 'renderer', 'src', 'features', 'calls', 'consentRetention.ts'),
    'utf8'
  )

  it('both copies compute the condition identically', () => {
    const mainCond = conditionFrom(mainSrc, 'src/main/calls-fs.ts')
    const uiCond = conditionFrom(rendererSrc, 'renderer/.../consentRetention.ts')
    expect(
      uiCond,
      'the renderer and the guard disagree about when coaching history is dropped'
    ).toBe(mainCond)
  })

  it('neither copy has lost the `consent != null` half', () => {
    // Asserted separately from equality on purpose: if BOTH copies dropped it,
    // they would still match each other and the test above would stay green
    // while every legacy call gained a false notice. Equality alone does not
    // protect a shared mistake.
    for (const [name, src] of [
      ['main', mainSrc],
      ['renderer', rendererSrc]
    ] as const) {
      const cond = conditionFrom(src, name)
      expect(cond, `${name} dropped the null-check — legacy calls will be mislabelled`).toContain(
        'consent != null'
      )
    }
  })

  it('the guard itself asks the predicate rather than re-testing the flag', () => {
    const body = mainSrc.slice(
      mainSrc.indexOf('function applyConsentRetention'),
      mainSrc.indexOf('\n}', mainSrc.indexOf('function applyConsentRetention'))
    )
    expect(body).toContain('coachingHistoryDropped(call)')
    // Comments stripped first. The guard's own comment legitimately EXPLAINS
    // the recordOtherParty flag; asserting against the raw text made this fail
    // on prose rather than on code — a test that reads documentation as
    // behaviour. Caught because it was red before the drift was introduced.
    const code = body
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')
    expect(code, 'the guard re-tests the raw flag instead of asking the predicate').not.toContain(
      'recordOtherParty'
    )
  })
})
