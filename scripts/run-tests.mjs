// M27 — run the test suite and KEEP the output.
//
// Why this exists: a full-suite run printed a stray `Errors  1 error` line
// alongside 1878 passing tests, and by the time anyone looked, the actual
// error text had scrolled out of the terminal. All that was left was a
// memory of a line — enough to know something happened, not enough to say
// what. That is the exact shape taxonomy species 4 warns about ("all tests
// passed" never implies "nothing went wrong"): the stray error is printed
// OUTSIDE any counted test, so it neither fails the run nor survives it.
//
// Now every run is written to test-output.log as well as the terminal, so
// the next occurrence is evidence instead of another "probably the known
// flake". Deliberately overwritten each run rather than appended — the
// question is always "what happened in the run I just did", and an
// ever-growing log in the repo root is its own hazard here (see below).
//
// PASS-THROUGH, NOT A WRAPPER WITH OPINIONS. Every argument is forwarded to
// vitest untouched (`npm test -- -t "some name"` still works), the child's
// stdout/stderr still stream live so the terminal experience is unchanged,
// and this process exits with the child's exact exit code so CI and shell
// chaining behave identically.
//
// THE EXIT CODE IS HALF THE POINT, verified with a deliberate canary (a test
// that passes while an unhandled error throws outside it): vitest exits
// NON-ZERO on a stray error even when every test passed. That means the
// earlier occurrence was always detectable — it was missed because the run
// was piped to `tail`, which reports the exit status of `tail`, not of
// vitest. So: never check this suite's result by eyeballing a piped tail.
// Either let it exit normally, or read $PIPESTATUS.
//
// THE LOG FILE'S LOCATION IS NOT ACCIDENTAL. `*.log*` is already in
// .gitignore, and electron-builder.yml excludes `**/*.log` from packaging —
// that exclusion exists because a stray file still being WRITTEN while
// electron-builder streams the asar silently corrupts the archive (every
// offset after it shifts, and the packaged app dies on startup with a bare
// exit 1). A `.log` extension is what keeps this file on the right side of
// both rules, so don't rename it to something else without checking both.
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const logPath = join(repoRoot, 'test-output.log')
const log = createWriteStream(logPath, { flags: 'w' })

// Spawns vitest's own JS entrypoint with THIS node binary — deliberately not
// `npx vitest` with `shell: true`. The shell route works, but on Windows npx
// is a .cmd, so it needs a shell, and Node then emits a DEP0190 deprecation
// warning about unescaped argument concatenation on every single run. That
// warning is both a real (if minor) injection footgun and permanent noise at
// the top of every test run — and a runner whose job is to make output
// trustworthy has no business adding junk to it. Resolving the .mjs directly
// needs no shell, so neither problem exists.
const vitestBin = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs')
const child = spawn(process.execPath, [vitestBin, 'run', ...process.argv.slice(2)], {
  cwd: repoRoot,
  stdio: ['inherit', 'pipe', 'pipe']
})

child.stdout.pipe(process.stdout)
child.stdout.pipe(log)
child.stderr.pipe(process.stderr)
child.stderr.pipe(log)

child.on('close', (code) => {
  // Written to the file only — printing it would add a line to the terminal
  // that isn't vitest's own output, which is the one thing this must not do.
  log.end(`\n[run-tests] vitest exited with code ${code}\n`, () => {
    process.exit(code ?? 1)
  })
})

child.on('error', (err) => {
  console.error('[run-tests] could not start vitest:', err)
  process.exit(1)
})
