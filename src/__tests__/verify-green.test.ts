// The gate's own verdict, tested. Taxonomy species 4 (green suite, stray
// error line), 14 (the signal discarded in transit — a wrapper's exit read as
// the suite's) and 69 (a number adjacent to the answer read as the answer)
// all live in how a test run's OUTPUT is read. verify-green.mjs is the one
// reader; these pin what it must and must not accept.
import { describe, expect, it } from 'vitest'
// @ts-expect-error — an .mjs script with no declaration file; the shape is asserted below
import { suiteVerdict, typecheckVerdict } from '../../scripts/verification/verify-green.mjs'

const CLEAN = `
 RUN  v4.1.10 C:/x

 Test Files  10 passed (10)
      Tests  100 passed (100)
   Start at  00:00:00
   Duration  1.00s
`

describe('suiteVerdict — reads the suite\'s own lines, not the wrapper', () => {
  it('green only when both summary lines exist, neither says failed, and the exit is 0', () => {
    expect(suiteVerdict(CLEAN, 0).green).toBe(true)
  })
  it('exit 0 with a "failed" summary is NOT green (species 14: never trust the exit alone)', () => {
    const out = CLEAN.replace('Test Files  10 passed (10)', 'Test Files  1 failed | 9 passed (10)')
    expect(suiteVerdict(out, 0).green).toBe(false)
  })
  it('a clean summary with a non-zero exit is NOT green', () => {
    expect(suiteVerdict(CLEAN, 1).green).toBe(false)
  })
  it('no summary line at all (the run did not finish) is NOT green, and says so', () => {
    const v = suiteVerdict(' RUN  v4\n\nSome crash\n', 0)
    expect(v.green).toBe(false)
    expect(v.files).toMatch(/did not finish/)
  })
  it('species 4: an "Errors  1 error" line beside a passing count is NOT green', () => {
    const out = CLEAN.replace('      Tests  100 passed (100)\n', '      Tests  100 passed (100)\n     Errors  1 error\n')
    const v = suiteVerdict(out, 0)
    expect(v.green).toBe(false)
    expect(v.errors).toBe('Errors  1 error')
  })
  it('reads a summary wrapped in ANSI colour codes and CRLF line endings (what the CI runner writes to the file)', () => {
    const esc = String.fromCharCode(27)
    const crlf = String.fromCharCode(13, 10)
    const coloured =
      `${esc}[2m Test Files ${esc}[22m ${esc}[1m${esc}[32m10 passed${esc}[39m${esc}[22m${esc}[90m (10)${esc}[39m${crlf}` +
      `${esc}[2m      Tests ${esc}[22m ${esc}[1m${esc}[32m100 passed${esc}[39m${esc}[22m${esc}[90m (100)${esc}[39m${crlf}`
    const v = suiteVerdict(coloured, 0)
    expect(v.green).toBe(true)
    expect(v.files).toBe('Test Files  10 passed (10)')
  })

  it('lists the failed test names it saw', () => {
    const out = CLEAN.replace('Test Files  10 passed (10)', 'Test Files  1 failed | 9 passed (10)') + '     × the one that failed 3ms\n'
    expect(suiteVerdict(out, 1).failedNames).toEqual(['× the one that failed 3ms'])
  })
})

describe('typecheckVerdict — error TS lines are the answer, exit code is the tiebreak', () => {
  it('no "error TS" lines and exit 0 is green even if the output contains a bare "1"', () => {
    // species 69: a "1" next to the answer was once read as one error
    expect(typecheckVerdict('> tsc --noEmit\n1\n', 0).green).toBe(true)
  })
  it('one "error TS" line is NOT green and is reported', () => {
    const v = typecheckVerdict("src/a.ts(3,1): error TS2322: Type 'x' is not assignable.\n", 2)
    expect(v.green).toBe(false)
    expect(v.errors).toHaveLength(1)
  })
  it('a non-zero exit with no error lines is still NOT green', () => {
    expect(typecheckVerdict('tsc crashed\n', 1).green).toBe(false)
  })
})
