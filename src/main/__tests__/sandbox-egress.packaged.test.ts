// @vitest-environment node
//
// BUG-263 — the guard must be UNREACHABLE in a packaged build.
//
// It patches `globalThis.fetch` and node's http/https. That is an acceptable
// thing to do to a dev sandbox and an unacceptable thing to do to a real user's
// process: a bug in the classifier would take their sync, their calendar and
// their transcription down at once, and the failure would look like a network
// outage. So the whole feature hangs off `devProfileOverride`, which
// `index.ts` computes as `app.isPackaged ? undefined : process.env[...]`.
//
// This reads index.ts as text, the same instrument `dev-profile-override.test.ts`
// uses for the sibling claim, and for the same reason: there is no way to boot
// two Electron main processes in a unit test, so the alternative is asserting
// nothing.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { installSandboxEgressGuard, resetSandboxEgressForTests } from '../sandbox-egress'

const src = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8')
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

describe('BUG-263 — a packaged build is never patched', () => {
  it('installSandboxEgressGuard is called exactly once in index.ts', () => {
    expect((code.match(/installSandboxEgressGuard\(/g) ?? []).length).toBe(1)
  })

  it('that call sits inside the devProfileOverride branch', () => {
    // The branch, not merely "somewhere after the variable is defined".
    const branch = code.match(/if \(devProfileOverride\) \{[\s\S]*?\n\}/)
    expect(branch, 'expected an `if (devProfileOverride) { … }` block').not.toBeNull()
    expect(branch?.[0]).toContain('installSandboxEgressGuard(')
  })

  it('devProfileOverride is still gated on app.isPackaged', () => {
    // Restated here rather than relied upon from the sibling test: this claim
    // ("a real user is unpatched") is only as strong as that one, and a claim
    // that depends on another file's assertion should say so out loud.
    expect(code).toMatch(
      /const devProfileOverride = app\.isPackaged \? undefined : process\.env\['CALLRISE_USER_DATA_DIR'\]/
    )
  })

  it('CALLRISE_SANDBOX_ALLOW is read once, in index.ts, and nowhere else in main', () => {
    expect((src.match(/CALLRISE_SANDBOX_ALLOW'/g) ?? []).length).toBe(1)
  })
})

describe('BUG-263 — installing is idempotent and reversible', () => {
  it('a second install does not double-wrap (which would double-count refusals)', () => {
    resetSandboxEgressForTests()
    const real = globalThis.fetch
    const un1 = installSandboxEgressGuard(new Set())
    const afterFirst = globalThis.fetch
    const un2 = installSandboxEgressGuard(new Set())
    expect(globalThis.fetch).toBe(afterFirst)
    un2()
    un1()
    expect(globalThis.fetch).toBe(real)
  })
})
