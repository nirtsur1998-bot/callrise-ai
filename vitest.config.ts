import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    // Mirrors tsconfig.web.json's path mapping — renderer code imports its own
    // siblings via `@renderer/...` (CLAUDE.md convention), and any test that
    // pulls in such a file (even transitively) needs the same resolution
    // vite/electron-vite already give it at build time.
    alias: {
      '@renderer': fileURLToPath(new URL('./src/renderer/src', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    /**
     * 20s, raised from vitest's 5s DEFAULT on 2026-08-31 (M32).
     *
     * ⚠ THIS IS NOT A TIGHTENED-THEN-LOOSENED NUMBER. 5000 was never chosen for
     * this suite — it is vitest's out-of-the-box default, and it was too small
     * for the tests here that do real filesystem work on a SHARED CI disk.
     * Do not "restore" it thinking someone had picked it deliberately.
     *
     * WHAT WAS MEASURED, on the release workflow's own runners:
     *   - `conversations-fs.test.ts` — appendTurn and the concurrent-append
     *     test — timed out at 5000ms in CI. The same tests run in **15–86 ms**
     *     locally (measured, `--reporter=verbose`).
     *   - `assistant-ipc.turn.test.ts` — timed out at 5000ms in CI. Runs in
     *     **238–277 ms** locally, 586–724 ms under full-suite load.
     *
     * That is a 60–300x blow-up, not a slowdown, and it blocked a release twice
     * on two DIFFERENT files. These tests go through `writeJsonAtomic`, which
     * does two fsyncs plus a rename per write; a shared runner's disk can stall
     * on that in a way this machine's does not (a 600-sample probe here maxed
     * at 28ms — see BUG-141, where that elimination is now recorded as
     * LOCAL-ONLY rather than general).
     *
     * WHY 20s IS STILL A REAL GATE, not a way to make red go green: the tests
     * it protects take tens of milliseconds. A genuine hang — the thing this
     * budget exists to catch — still fails, with roughly 200x headroom over
     * their observed cost. Raising it removes an arbitrary default's false
     * positives without removing the signal.
     *
     * THE UNDERLYING STALL IS NOT EXPLAINED and this does not explain it. It
     * makes the gate usable while BUG-141 is investigated properly, CI-side.
     */
    testTimeout: 20_000
  }
})
