/**
 * BUG-141 reproduction under DELIBERATE CONTENTION.
 *
 * The baseline loop (bug141-loop.mjs) runs one suite at a time on an otherwise
 * idle machine and does not reproduce the stall. One run in that series
 * accidentally overlapped a second full suite, and that run alone showed the
 * target test's cold-import phase go from ~550 ms to 3098 ms — a ~5x blow-up
 * from roughly 2x machine load, while the suite's own aggregate transform time
 * moved only 1.9x. That super-linear response is what this script pushes on.
 *
 * It runs K full suites CONCURRENTLY, R times. Every suite is instrumented, so
 * every one is an observation, not just load. The question it is trying to
 * answer is not "is the suite slower" (obviously) but: does any single test
 * cross the 20 s testTimeout, and if it does, WHERE was it stopped?
 *
 * Usage: node scripts/verification/bug141-load.mjs [rounds] [concurrency] [logDir]
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, createWriteStream } from 'node:fs'
import { join } from 'node:path'

const ROUNDS = Number(process.argv[2] ?? 4)
const K = Number(process.argv[3] ?? 3)
const LOG = process.argv[4] ?? join(process.cwd(), '.bug141-load')
mkdirSync(LOG, { recursive: true })
const SUMMARY = join(LOG, 'runs.jsonl')

const one = (tag) =>
  new Promise((resolve) => {
    const dir = join(LOG, `run-${tag}`)
    mkdirSync(dir, { recursive: true })
    const out = createWriteStream(join(dir, 'stdout.log'))
    const t0 = Date.now()
    const child = spawn(
      process.execPath,
      ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.bug141.config.ts'],
      {
        env: { ...process.env, BUG141_LOG: dir, BUG141_RUN: tag, CI: '' },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    child.stdout.pipe(out)
    child.stderr.pipe(out)
    child.on('close', (code) => {
      const rec = { run: tag, code, ms: Date.now() - t0, at: new Date().toISOString() }
      appendFileSync(SUMMARY, JSON.stringify(rec) + '\n')
      console.log(`  ${tag}: exit ${code} in ${(rec.ms / 1000).toFixed(1)}s`)
      resolve(rec)
    })
  })

for (let r = 1; r <= ROUNDS; r++) {
  console.log(`round ${r} of ${ROUNDS}: ${K} concurrent suites`)
  await Promise.all(
    Array.from({ length: K }, (_, i) =>
      one(`${String(r).padStart(2, '0')}${String.fromCharCode(97 + i)}`)
    )
  )
}
console.log('done')
