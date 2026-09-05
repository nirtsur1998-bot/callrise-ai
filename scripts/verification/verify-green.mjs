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
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const dash = args.indexOf('--')
const vitestArgs = dash >= 0 ? args.slice(dash + 1) : []
const flags = dash >= 0 ? args.slice(0, dash) : args
const doTypes = !flags.includes('--tests')
const doTests = !flags.includes('--types')
const cwd = process.cwd()
const isWin = process.platform === 'win32'

function run(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { cwd, shell: isWin, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { code: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

const verdicts = []

if (doTypes) {
  const r = run('npm', ['run', 'typecheck'])
  const errors = r.out.split('\n').filter((l) => /error TS\d+/.test(l))
  if (errors.length || r.code !== 0) {
    console.log(`TYPECHECK: ${errors.length} error line(s), exit ${r.code}`)
    for (const l of errors.slice(0, 40)) console.log('  ' + l.trim())
    verdicts.push(false)
  } else {
    console.log('TYPECHECK: no "error TS" lines, exit 0')
    verdicts.push(true)
  }
}

if (doTests) {
  const r = run('npx', ['vitest', 'run', ...vitestArgs])
  const files = r.out.split('\n').find((l) => /^\s*Test Files\s/.test(l))?.trim()
  const tests = r.out.split('\n').find((l) => /^\s*Tests\s/.test(l))?.trim()
  const failedNames = r.out.split('\n').filter((l) => /^\s*×/.test(l)).map((l) => l.trim())
  const green = r.code === 0 && !!files && !!tests && !/failed/.test(files) && !/failed/.test(tests)
  console.log(`SUITE: ${files ?? '(no "Test Files" summary line — the run did not finish)'}`)
  console.log(`SUITE: ${tests ?? '(no "Tests" summary line)'}`)
  console.log(`SUITE: vitest exit ${r.code}`)
  for (const l of failedNames.slice(0, 40)) console.log('  ' + l)
  verdicts.push(green)
}

const allGreen = verdicts.length > 0 && verdicts.every(Boolean)
console.log(allGreen ? 'VERDICT: GREEN' : 'VERDICT: NOT GREEN')
process.exit(allGreen ? 0 : 1)
