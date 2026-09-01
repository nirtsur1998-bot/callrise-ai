// The dev-only userData override, pinned.
//
// `CALLRISE_USER_DATA_DIR` lets a DEV build run against a copy of the profile
// so that driving write-heavy screens (the outcome backfill creates deals and
// rewrites call records) does not mutate the real one. That is a good seam and
// a dangerous one: an env var that relocates userData is, in a packaged build,
// a way to point a real user's app at an empty directory — their calls, deals
// and contacts would appear to have vanished, with nothing broken to find.
//
// So the gate is `app.isPackaged`, and this test is what keeps it that way.
// Read as TEXT rather than by importing index.ts: that module pulls in the
// whole Electron main process at import time, and a test that cannot run is a
// test that protects nothing.
//
// The same-shaped guarantee as the "structurally unflaggable switches" rule —
// the safe behaviour is not enforced by a check that could be inverted, it is
// enforced by the packaged build having no code path to the variable at all.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const INDEX = join(__dirname, '..', 'index.ts')
const src = readFileSync(INDEX, 'utf8')

describe('CALLRISE_USER_DATA_DIR is unreachable in a packaged build', () => {
  it('the variable is read exactly once', () => {
    // A second read is the realistic regression: someone adds a convenience
    // lookup elsewhere, and only one of the two is behind the gate.
    const reads = src.match(/CALLRISE_USER_DATA_DIR/g) ?? []
    expect(reads.length, 'more than one read site — each would need its own gate').toBe(1)
  })

  it('that read is gated on app.isPackaged, on the same expression', () => {
    // Anchored to the whole assignment, so moving the read out from behind the
    // ternary fails here even if the words stay in the file.
    expect(src).toMatch(
      /const devProfileOverride = app\.isPackaged \? undefined : process\.env\['CALLRISE_USER_DATA_DIR'\]/
    )
  })

  it('the packaged path is still the real profile directory', () => {
    // ONE regex anchoring the WHOLE expression — the first version paired a
    // toContain for the join(...) string with a separate toMatch for the
    // assignment head, and nothing tied them to the same line: a fallback
    // pointing somewhere new, with the old string quoted in a nearby comment,
    // passed both. Workflow finding on this test.
    expect(src).toMatch(
      /const userDataDir = devProfileOverride \|\| join\(app\.getPath\('appData'\), 'sales-os'\)/
    )
  })

  it('...and the assertions above are anchored to text that really is present', () => {
    // Guards against the whole file being renamed or restructured out from
    // under this test, which would leave three passing regex checks against a
    // string that no longer describes anything.
    expect(src.length, 'index.ts read as empty — every check above is vacuous').toBeGreaterThan(
      5000
    )
    expect(src).toContain("app.setPath('userData', userDataDir)")
  })
})
