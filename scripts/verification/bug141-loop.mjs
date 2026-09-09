/**
 * BUG-141 reproduction loop — run the FULL suite N times and record, per run,
 * the exit code, the wall clock, and (via bug141-instrument.setup.ts) a
 * per-test timing record for every one of the ~3900 tests.
 *
 * The point is NOT to wait for a 20 s timeout. It is to measure the TAIL: a
 * stall that reaches 20 s once in ~30 runs should show near-misses at 2-8 s far
 * more often, and near-misses are enough to name the mechanism. If the tail is
 * flat and the 20 s events are isolated spikes, that is itself a finding.
 *
 * The instrument was proved able to fire before it was trusted:
 *   - process._getActiveRequests() shows an in-flight fs op as FSReqPromise
 *     (positive control: a 300 MB write; negative control: nothing in flight).
 *   - A deliberately idle 5 s test produced a stall record with cpuMs 0 and no
 *     active requests; a fast test produced none.
 *   - A first version buffered records and lost them; the self-test caught that
 *     and the flush moved to a per-file afterAll.
 *
 * Usage: node scripts/verification/bug141-loop.mjs <runs> [logDir]
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, createWriteStream } from 'node:fs'
import { join } from 'node:path'

const RUNS = Number(process.argv[2] ?? 10)
const LOG = process.argv[3] ?? join(process.cwd(), '.bug141')
mkdirSync(LOG, { recursive: true })
const SUMMARY = join(LOG, 'runs.jsonl')

const one = (n) =>
  new Promise((resolve) => {
    const dir = join(LOG, `run-${String(n).padStart(3, '0')}`)
    mkdirSync(dir, { recursive: true })
    const out = createWriteStream(join(dir, 'stdout.log'))
    const t0 = Date.now()
    const child = spawn(
      process.execPath,
      ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.bug141.config.ts'],
      {
        env: { ...process.env, BUG141_LOG: dir, BUG141_RUN: String(n), CI: '' },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    child.stdout.pipe(out)
    child.stderr.pipe(out)
    child.on('close', (code) => {
      const rec = { run: n, code, ms: Date.now() - t0, at: new Date().toISOString() }
      appendFileSync(SUMMARY, JSON.stringify(rec) + '\n')
      console.log(`run ${n}: exit ${code} in ${(rec.ms / 1000).toFixed(1)}s`)
      resolve(rec)
    })
  })

for (let n = 1; n <= RUNS; n++) await one(n)
console.log('done')
