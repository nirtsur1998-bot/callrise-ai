// M27 — proves the test runner discriminates. A runner that cannot be shown
// to FAIL is a runner nobody should trust.
//
// This is the standing version of the one-off check that settled taxonomy
// species 14. The whole species is "the tool was right, and its verdict was
// discarded in transit" — so the thing worth guarding is not vitest (which
// was never broken) but the reporting path around it: that a stray error
// still produces a NON-ZERO exit, and that its text still reaches the log.
//
// Run it with `npm run verify:runner`. It is not part of the normal suite,
// deliberately: the canary throws an unhandled error on purpose, which would
// make every ordinary run exit non-zero.
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const canaryConfig = join(repoRoot, 'scripts', 'canary', 'vitest.canary.config.ts')
const logPath = join(repoRoot, 'test-output.log')

// Runs the REAL runner (run-tests.mjs), not vitest directly — the runner's
// reporting path is what's under test, not vitest itself.
//
// Via --config, NOT a positional path filter. The root config's `include` is
// scoped to src/**, so a filter pointing at the canary matches nothing and
// vitest exits 1 with "No test files found" — non-zero for entirely the
// wrong reason. The first draft of this script did exactly that, and only
// the SECOND assertion below (did the error text actually land?) caught it.
// A single-assertion version would have reported a confident pass while
// proving nothing.
const result = spawnSync(
  process.execPath,
  [join(repoRoot, 'scripts', 'run-tests.mjs'), '--config', canaryConfig],
  { cwd: repoRoot, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] }
)

const failures = []

// 1. The exit code is the signal that was being thrown away. If a stray
//    unhandled error can leave the process at 0, nothing downstream — CI, a
//    shell `&&`, a human — can tell a clean run from a broken one.
if (result.status === 0) {
  failures.push(
    'Expected a NON-ZERO exit when an unhandled error is thrown outside a test, got 0. ' +
      'Either vitest stopped treating stray errors as failures, or run-tests.mjs is no longer ' +
      'propagating the child exit code — both make every "green" run untrustworthy.'
  )
}

// 2. The text has to survive. The original incident was not "we did not know
//    something happened" — it was "we could not say WHAT happened", because
//    the output had scrolled.
if (!existsSync(logPath)) {
  failures.push(`Expected the run to write ${logPath}, but it does not exist.`)
} else {
  const log = readFileSync(logPath, 'utf8')
  if (!log.includes('STRAY_ERROR_CANARY')) {
    failures.push(
      'The stray error text did not reach test-output.log. Capture is the whole point of the ' +
        'runner — without it the next occurrence is another "probably the known flake".'
    )
  }
}

if (failures.length > 0) {
  console.error('\n[verify-runner] FAILED — the test runner cannot be trusted to report failure:\n')
  for (const f of failures) console.error(`  • ${f}\n`)
  process.exit(1)
}

console.log(
  '\n[verify-runner] OK — a stray unhandled error produces a non-zero exit AND its text is ' +
    'captured to test-output.log.\n'
)
