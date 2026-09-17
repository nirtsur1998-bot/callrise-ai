// Run a command so that its EXIT CODE and its OUTPUT cannot be misread.
//
// WHY THIS EXISTS — two failures, both in one session (2026-09-17, M40), both
// already described in this directory's README, and both committed anyway by
// someone who had read it an hour earlier. Remembering a rule is not the same
// as running it, so these two are now mechanical:
//
//   1. `cmd | tail -N` followed by `echo $?` reports TAIL's exit code. A failing
//      command reads as a passing one. run-tests.mjs's own header already warns
//      about exactly this ("never check this suite's result by eyeballing a
//      piped tail"), and species 69 is the general case: read the answer, not a
//      number next to it.
//
//   2. `cmd | tail -45` DISCARDS the beginning — which is where the failure
//      reasons live. A verify-green run was truncated to its last 45 lines, the
//      error text was gone, and the next twenty minutes were spent looking for
//      an explanation that had already been thrown away. The README's own
//      section is titled "Your own `| tail -N` can hide half the problem".
//
// HOW IT PREVENTS THEM, rather than discouraging them:
//   - There is no pipe. The child's stdout/stderr go to a file; nothing is
//     truncated, ever.
//   - The exit code printed is the CHILD's, read from the child, on its own
//     labelled line — and this process exits with that same code, so `$?` after
//     THIS command is still the child's.
//   - Any elision is stated: "showing last N of M lines" plus the log path. You
//     cannot look at the output and not know that something was hidden.
//
// USAGE
//   node scripts/verification/run.mjs -- npm run typecheck
//   node scripts/verification/run.mjs --tail 80 -- npx vitest run src/main
//   node scripts/verification/run.mjs --grep "error TS" -- npm run typecheck
//
//   --tail N   how many trailing lines to show (default 40; 0 shows none)
//   --grep S   also print every line containing S, with a count. Printed as
//              "N matching lines" followed by the LINES THEMSELVES — never a
//              bare count, which is the species-69 shape this file exists to
//              avoid.
//   --log P    where to write the full output (default: a temp file, path printed)
//
// It is deliberately a PASS-THROUGH with no opinions about what it runs, the
// same contract scripts/run-tests.mjs chose: every argument after `--` is
// forwarded untouched, and the exit code is the child's exact code.
import { spawn } from 'node:child_process'
import { createWriteStream, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function parseArgs(argv) {
  const dash = argv.indexOf('--')
  if (dash === -1 || dash === argv.length - 1) {
    console.error('usage: node scripts/verification/run.mjs [--tail N] [--grep S] [--log P] -- <command> [args...]')
    process.exit(2)
  }
  const opts = { tail: 40, grep: null, log: null }
  for (let i = 0; i < dash; i++) {
    const a = argv[i]
    if (a === '--tail') opts.tail = Number(argv[++i])
    else if (a === '--grep') opts.grep = argv[++i]
    else if (a === '--log') opts.log = argv[++i]
    else {
      console.error(`unknown option: ${a}`)
      process.exit(2)
    }
  }
  if (!Number.isFinite(opts.tail) || opts.tail < 0) {
    console.error('--tail must be a non-negative number')
    process.exit(2)
  }
  return { opts, cmd: argv[dash + 1], args: argv.slice(dash + 2) }
}

const { opts, cmd, args } = parseArgs(process.argv.slice(2))
const logPath = opts.log ?? join(mkdtempSync(join(tmpdir(), 'run-')), 'output.log')

// Refuse rather than run blind: if the log cannot be opened we would lose the
// full output and be back to reading a truncated tail, which is the thing this
// script exists to make impossible.
let sink
try {
  sink = createWriteStream(logPath)
} catch (err) {
  console.error(`REFUSING: cannot write the full-output log at ${logPath}: ${err.message}`)
  process.exit(2)
}

const child = spawn(cmd, args, { stdio: ['inherit', 'pipe', 'pipe'] })
child.stdout.pipe(sink)
child.stderr.pipe(sink)

child.on('error', (err) => {
  console.error(`REFUSING: could not start "${cmd}": ${err.message}`)
  process.exit(2)
})

child.on('close', (code, signal) => {
  sink.end(() => {
    const text = readFileSync(logPath, 'utf8')
    // A trailing newline would otherwise be counted as an extra empty line and
    // make "showing last N of M" quietly wrong.
    const lines = text.length === 0 ? [] : text.replace(/\n$/, '').split('\n')

    console.log(`\n=== ${cmd} ${args.join(' ')}`)
    console.log(`=== full output: ${logPath}  (${lines.length} lines)`)

    if (opts.grep !== null) {
      const hits = lines.filter((l) => l.includes(opts.grep))
      console.log(`\n--- ${hits.length} lines matching ${JSON.stringify(opts.grep)} ---`)
      for (const h of hits) console.log(h)
      if (hits.length === 0) {
        // A zero here means the pattern did not match. That is a claim about
        // the pattern until the full log says otherwise — say so, rather than
        // letting an empty section read as "nothing went wrong".
        console.log('(zero matches is a claim about the PATTERN, not about the run — read the log)')
      }
    }

    if (opts.tail > 0 && lines.length > 0) {
      const shown = Math.min(opts.tail, lines.length)
      const hidden = lines.length - shown
      console.log(
        hidden > 0
          ? `\n--- last ${shown} of ${lines.length} lines (${hidden} HIDDEN — read the log above) ---`
          : `\n--- all ${shown} lines ---`
      )
      for (const l of lines.slice(-shown)) console.log(l)
    }

    // The child's own code, labelled so it cannot be confused with a wrapper's,
    // and re-exited so `$?` after this command is still the child's.
    if (signal) {
      console.log(`\n=== KILLED BY SIGNAL: ${signal}`)
      process.exit(1)
    }
    console.log(`\n=== EXIT CODE OF "${cmd}": ${code}`)
    process.exit(code ?? 1)
  })
})
