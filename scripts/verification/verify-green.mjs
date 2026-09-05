#!/usr/bin/env node
// VERIFY-GREEN — one command that reads the ANSWER, not a number next to it.
//
// Three times in two days (2026-09-04/05) a verification was misread the same
// way: a wrapper's exit code taken as the suite's, a `grep -c` count taken as
// content, a count of "1" read as "clean". Taxonomy species 69 — reading a
// number adjacent to the answer instead of the answer. The founder's ask: a
// mechanical fix, not a rule to remember. So every gate this project uses is
// run here and reported in the only form that cannot be misread — the
// suite's OWN summary line, the typecheck's OWN error lines — and the verdict
// is one word at the end.
//
//   node scripts/verification/verify-green.mjs           # typecheck + full suite
//   node scripts/verification/verify-green.mjs --tests   # suite only
//   node scripts/verification/verify-green.mjs --types   # typecheck only
//   ... -- <vitest args>                                  # e.g. -- src/main/__tests__/x.test.ts
//
// Exit code: 0 only when every gate is green; otherwise 1. Nothing is piped
// through head/tail, so the exit code is this script's own.
//
// The two verdict functions are exported and tested (src/__tests__/
// verify-green.test.ts) — the gate has a red check of its own. Importing this
// file runs nothing: the gates run only when it is the command being executed.
import { spawnSync } from 'node:child_process'
import { closeSync, openSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** How a typecheck run is read: "error TS" lines are the answer; a non-zero
 *  exit with no such line is still not green (species 14). */
export function typecheckVerdict(out, code) {
  const errors = out.split('\n').filter((l) => /error TS\d+/.test(l))
  return { green: errors.length === 0 && code === 0, errors, code }
}

/** How a vitest run is read: both of its own summary lines must exist and
 *  say nothing of "failed"; an "Errors  N error" line (vitest's unhandled
 *  errors, printed BESIDE a passing count — species 4) is a failure; and the
 *  exit must be 0 — necessary, never sufficient (species 14). */
export function suiteVerdict(out, code) {
  const lines = out.split('\n')
  const files = lines.find((l) => /^\s*Test Files\s/.test(l))?.trim()
  const tests = lines.find((l) => /^\s*Tests\s/.test(l))?.trim()
  const errors = lines.find((l) => /^\s*Errors\s+\d+\s+error/.test(l))?.trim() ?? null
  const failedNames = lines.filter((l) => /^\s*×/.test(l)).map((l) => l.trim())
  const green =
    code === 0 && !!files && !!tests && !/failed/.test(files) && !/failed/.test(tests) && errors === null
  return {
    green,
    files: files ?? '(no "Test Files" summary line — the run did not finish)',
    tests: tests ?? '(no "Tests" summary line)',
    errors,
    failedNames,
    code
  }
}

/** Run a gate with its output streamed to a FILE, not a memory buffer. The
 *  first CI run died without a summary line: spawnSync's maxBuffer (64 MB)
 *  was exceeded by the suite's stderr chatter, the child was killed, and the
 *  gate could only say "the run did not finish". A file has no cap, the log
 *  survives for the tail, and the exit code is the child's own. */
function run(cmd, cmdArgs, cwd) {
  const logPath = join(tmpdir(), `verify-green-${process.pid}-${Date.now()}.log`)
  const fd = openSync(logPath, 'w')
  let status
  try {
    const r = spawnSync(cmd, cmdArgs, {
      cwd,
      shell: process.platform === 'win32',
      stdio: ['ignore', fd, fd]
    })
    status = r.status
    if (r.error) console.log(`GATE: could not run ${cmd}: ${r.error.message}`)
  } finally {
    closeSync(fd)
  }
  const out = readFileSync(logPath, 'utf8')
  console.log(`GATE: ${cmd} ${cmdArgs.join(' ')} -> exit ${status ?? 'null'}, ${out.length} chars captured (${logPath})`)
  return { code: status ?? -1, out }
}

export function main(argv) {
  const dash = argv.indexOf('--')
  const vitestArgs = dash >= 0 ? argv.slice(dash + 1) : []
  const flags = dash >= 0 ? argv.slice(0, dash) : argv
  const doTypes = !flags.includes('--tests')
  const doTests = !flags.includes('--types')
  const cwd = process.cwd()
  const verdicts = []

  if (doTypes) {
    const r = run('npm', ['run', 'typecheck'], cwd)
    const v = typecheckVerdict(r.out, r.code)
    if (v.green) console.log('TYPECHECK: no "error TS" lines, exit 0')
    else {
      console.log(`TYPECHECK: ${v.errors.length} error line(s), exit ${v.code}`)
      for (const l of v.errors.slice(0, 40)) console.log('  ' + l.trim())
    }
    verdicts.push(v.green)
  }

  if (doTests) {
    const r = run('npx', ['vitest', 'run', ...vitestArgs], cwd)
    const v = suiteVerdict(r.out, r.code)
    console.log(`SUITE: ${v.files}`)
    console.log(`SUITE: ${v.tests}`)
    if (v.errors) console.log(`SUITE: ${v.errors}   <- unhandled errors beside the count (species 4)`)
    console.log(`SUITE: vitest exit ${v.code}`)
    for (const l of v.failedNames.slice(0, 40)) console.log('  ' + l)
    if (!v.files.startsWith('Test Files')) {
      // The run did not reach its own summary. A refusal with no cause is a
      // dead end (learned on the first CI run): show the raw tail so the
      // crash, the missing dependency or the OOM is in the log.
      const tail = r.out.split('\n').filter((l) => l.trim()).slice(-60)
      console.log('SUITE: last lines of the raw output, because the run did not finish:')
      for (const l of tail) console.log('  | ' + l)
    }
    verdicts.push(v.green)
  }

  const allGreen = verdicts.length > 0 && verdicts.every(Boolean)
  console.log(allGreen ? 'VERDICT: GREEN' : 'VERDICT: NOT GREEN')
  return allGreen ? 0 : 1
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) process.exit(main(process.argv.slice(2)))
