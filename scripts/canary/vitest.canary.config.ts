// M27 — config for the runner-verification canary ONLY (npm run verify:runner).
//
// The root vitest.config.ts scopes `include` to `src/**/*.test.ts`, which is
// exactly why the canary lives outside src/: it must never join the normal
// suite, since it throws an unhandled error on purpose and would make every
// ordinary run exit non-zero.
//
// But that scoping also means passing the canary's path as a positional
// filter does nothing useful — vitest matches filters AGAINST `include`,
// finds nothing, and exits 1 with "No test files found". That still exits
// non-zero, so a check that only asserted "exit != 0" would have passed
// while proving nothing at all — red for entirely the wrong reason, which is
// the trap this whole taxonomy exists to catch. (verify-runner.mjs's second
// assertion — that the stray error TEXT reached the log — is what caught it.)
//
// So the canary gets its own include instead of a filter.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/canary/*.canary.ts']
  }
})
