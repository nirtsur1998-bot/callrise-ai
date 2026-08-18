// M27 — the canary that proves the test runner can actually FAIL.
//
// Deliberately NOT under src/: vitest.config.ts's `include` is
// `src/**/*.test.ts`, so this file is invisible to the normal suite. It is
// only ever run explicitly, by scripts/verify-runner.js.
//
// It reproduces taxonomy species 4/14's exact shape: a test that PASSES while
// an unhandled error is thrown outside any test. That is the situation where
// "1878 tests passed" and "something went badly wrong" are both true at once,
// and the only signal distinguishing them is the process exit code.
import { describe, expect, it } from 'vitest'

describe('canary', () => {
  it('passes, while an unhandled error throws outside the test', async () => {
    // Escapes the test's own call stack, so vitest reports it as an unhandled
    // error rather than a test failure — exactly like the real flake.
    setTimeout(() => {
      throw new Error('STRAY_ERROR_CANARY')
    }, 5)

    // THE AWAIT IS LOAD-BEARING, and its absence made the first version of
    // this canary FLAKY — which is the one thing a verifier must never be.
    // Without it the test returned immediately, and with only this one tiny
    // file to run, vitest sometimes finished and tore down the worker before
    // the 5ms timer ever fired: no unhandled error, no non-zero exit, and a
    // "the runner is broken!" report that was really just a race. Staying
    // alive well past the throw makes the stray error deterministic.
    //
    // Found by running the verifier twice and getting different answers —
    // not by reading the code. A canary you have only ever seen pass once is
    // not yet evidence of anything.
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(1).toBe(1)
  })
})
