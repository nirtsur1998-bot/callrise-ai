// M35 Stage 3 — the CI gate is pinned the way the release job's BUG-120 step
// is: by what the workflow file actually runs, in the order it runs it.
// Species 9 (the hollow verification command trusted as the gate) and 41 (CI
// ran the tests before the build, so gated tests skipped silently on every
// release ever cut) are both orderings a reader cannot see from a green badge.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// CRLF-normalised: the CI runner's checkout writes CRLF, and a search for a
// line ending in a bare newline came back "not found" there (first CI runs).
const NORMALISE = true
const raw = readFileSync(join(__dirname, '..', '..', '.github', 'workflows', 'verify.yml'), 'utf8')
const wf = NORMALISE ? raw.replace(/\r\n?/g, '\n') : raw

describe('verify.yml — the gate runs on every push and PR, and refuses', () => {
  it('triggers on push to any branch and on pull requests', () => {
    expect(wf).toMatch(/on:\s*\n\s*push:\s*\n\s*branches: \['\*\*'\]\s*\n\s*pull_request:/)
  })
  it('runs verify-green itself, not a tail of it (species 14)', () => {
    expect(wf).toMatch(/run: node scripts\/verification\/verify-green\.mjs\s*$/m)
    expect(wf).not.toMatch(/verify-green\.mjs[^\n]*\|/)
  })
  it('builds the native addon and the bundles BEFORE the gate (species 41)', () => {
    const native = wf.indexOf('npm run native:build:win')
    const bundle = wf.indexOf('npx electron-vite build')
    const gate = wf.indexOf('run: node scripts/verification/verify-green.mjs\n')
    expect(native).toBeGreaterThan(-1)
    expect(bundle).toBeGreaterThan(native)
    expect(gate).toBeGreaterThan(bundle)
  })
  it('runs the instruments\' own self-tests as a named step', () => {
    for (const f of [
      'verify-green.test.ts',
      'tracker-status.test.ts',
      'no-uncollected-test-files.test.ts',
      'frozen-modules-have-no-production-callers.test.ts',
      'packaged-files.test.ts',
      'release-notes.test.ts'
    ]) expect(wf).toContain(`src/__tests__/${f}`)
  })
})
