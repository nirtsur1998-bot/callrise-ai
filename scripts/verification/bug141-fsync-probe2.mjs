/**
 * BUG-141 filesystem probe, MARK 2.
 *
 * WHY A SECOND PROBE. `bug141-fsync-probe.mjs` (2026-08-31) answered "can this
 * machine's disk stall for seconds?" with p50 7.8 ms / MAX 28.1 ms, and that
 * result was recorded as an elimination. It has a METHOD FLAW the entry never
 * named: its "15 workers" are 15 `Promise.all` branches inside ONE node
 * process. `fs.promises` calls are served by the libuv threadpool, which
 * defaults to FOUR threads — so at most 4 filesystem operations were ever in
 * flight, not 15. The real suite runs ~300 SEPARATE worker processes (measured
 * 2026-09-09: 303 processes for 409 files), each with its own 4-thread pool.
 * The old probe under-stressed the disk by roughly an order of magnitude.
 *
 * WHAT THIS ONE ADDS
 *   - real child PROCESSES, so the concurrency is genuine
 *   - per-SYSCALL timing (writeFile / readBack / open+fsync / rename), so a
 *     stall can be attributed rather than merely observed
 *   - a CHURN phase repeating (mkdtemp -> write files -> rm -r), counting rm
 *     failures by errno. That is what every suite afterEach does, and on
 *     Windows it is the ONLY signature of a third party holding a handle that
 *     is observable unelevated: a directory cannot be removed while any handle
 *     remains on a file inside it, even one already unlinked.
 *   - a RENAME-OVER-EXISTING phase counting EPERM — writeJsonAtomic's rename
 *     is the step that failed with EPERM under contention on 2026-09-09.
 *
 * WHAT IT DELIBERATELY DOES NOT MEASURE, and why. An earlier version timed how
 * long a deleted file's NAME lingered in readdir, on the theory that a
 * scanner's open handle would keep it listed. A positive control killed that:
 * Node on Windows 10+ deletes with POSIX semantics, so the name disappears
 * immediately even with a handle deliberately held open. The metric read a
 * clean 0 across 960 samples while being structurally incapable of reporting
 * anything else. It was removed rather than reported.
 *
 * Usage: node scripts/verification/bug141-fsync-probe2.mjs [procs] [writes]
 */
import { fork } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const PROCS = Number(process.argv[2] ?? 16)
const WRITES = Number(process.argv[3] ?? 60)

// --- child role -------------------------------------------------------------
if (process.env.BUG141_CHILD) {
  const n = Number(process.env.BUG141_CHILD_WRITES)
  const dir = await fs.mkdtemp(join(tmpdir(), 'bug141-probe2-'))
  const rows = []
  for (let i = 0; i < n; i++) {
    const target = join(dir, `c-${i}.json`)
    const tmp = `${target}.${randomUUID()}.tmp`
    const data = JSON.stringify({ i, pad: 'x'.repeat(2000) }, null, 2)
    const t = {}
    let s = process.hrtime.bigint()
    const lap = (k) => {
      const e = process.hrtime.bigint()
      t[k] = Number(e - s) / 1e6
      s = e
    }
    // The exact sequence writeJsonAtomic performs on win32.
    await fs.writeFile(tmp, data, 'utf8')
    lap('writeFile')
    JSON.parse(await fs.readFile(tmp, 'utf8'))
    lap('readBack')
    const h = await fs.open(tmp, 'r+')
    await h.sync()
    await h.close()
    lap('fsync')
    await fs.rename(tmp, target)
    lap('rename')
    rows.push(t)
  }

  // CHURN: the afterEach pattern, repeated. Counts rm failures by errno.
  const churn = {}
  for (let c = 0; c < 25; c++) {
    const d2 = await fs.mkdtemp(join(tmpdir(), 'bug141-churn-'))
    for (let k = 0; k < 6; k++) await fs.writeFile(join(d2, `f-${k}.json`), '{"a":1}', 'utf8')
    try {
      await fs.rm(d2, { recursive: true, force: true })
      churn.ok = (churn.ok ?? 0) + 1
    } catch (e) {
      const code = e.code ?? 'ERR'
      churn[code] = (churn[code] ?? 0) + 1
    }
  }

  // RENAME OVER AN EXISTING TARGET: the writeJsonAtomic step that hit EPERM.
  const ren = {}
  const live = join(dir, 'live.json')
  await fs.writeFile(live, '{}', 'utf8')
  for (let c = 0; c < 200; c++) {
    const t2 = `${live}.${randomUUID()}.tmp`
    await fs.writeFile(t2, `{"c":${c}}`, 'utf8')
    try {
      await fs.rename(t2, live)
      ren.ok = (ren.ok ?? 0) + 1
    } catch (e) {
      ren[e.code ?? 'ERR'] = (ren[e.code ?? 'ERR'] ?? 0) + 1
      await fs.unlink(t2).catch(() => {})
    }
  }

  let rmErr = null
  const tRm = process.hrtime.bigint()
  try {
    await fs.rm(dir, { recursive: true, force: true })
  } catch (e) {
    rmErr = e.code ?? String(e)
  }
  const rmMs = Number(process.hrtime.bigint() - tRm) / 1e6
  process.send({ rows, churn, ren, rmErr, rmMs })
  process.exit(0)
}

// --- parent role ------------------------------------------------------------
const results = await Promise.all(
  Array.from(
    { length: PROCS },
    () =>
      new Promise((resolve) => {
        const c = fork(SELF, [], {
          env: { ...process.env, BUG141_CHILD: '1', BUG141_CHILD_WRITES: String(WRITES) },
          stdio: 'inherit'
        })
        let got = null
        c.on('message', (m) => (got = m))
        c.on('exit', () => resolve(got))
      })
  )
)

const rows = results.flatMap((r) => r?.rows ?? [])
const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y)
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : NaN
}
console.log(`${PROCS} PROCESSES x ${WRITES} atomic writes = ${rows.length} samples`)
for (const k of ['writeFile', 'readBack', 'fsync', 'rename']) {
  const a = rows.map((r) => r[k])
  console.log(
    `  ${k.padEnd(10)} p50 ${pct(a, 50).toFixed(1)}ms  p99 ${pct(a, 99).toFixed(1)}ms  MAX ${Math.max(...a).toFixed(1)}ms  >1000ms: ${a.filter((x) => x > 1000).length}  >5000ms: ${a.filter((x) => x > 5000).length}`
  )
}
const total = rows.map((r) => r.writeFile + r.readBack + r.fsync + r.rename)
console.log(
  `  TOTAL      p50 ${pct(total, 50).toFixed(1)}ms  p99 ${pct(total, 99).toFixed(1)}ms  MAX ${Math.max(...total).toFixed(1)}ms  >1000ms: ${total.filter((x) => x > 1000).length}  >5000ms: ${total.filter((x) => x > 5000).length}`
)
const merge = (key) => {
  const out = {}
  for (const r of results)
    for (const [k, v] of Object.entries(r?.[key] ?? {})) out[k] = (out[k] ?? 0) + v
  return out
}
console.log(
  `\nCHURN  (mkdtemp -> 6 files -> rm -r) x25 per process: ${JSON.stringify(merge('churn'))}`
)
console.log(
  `RENAME over an existing target       x200 per process: ${JSON.stringify(merge('ren'))}`
)
const rmErrs = results.filter((r) => r?.rmErr)
console.log(
  `final rm of the probe dir: ${results.length} attempts, ${rmErrs.length} failed${rmErrs.length ? ' (' + rmErrs.map((r) => r.rmErr).join(', ') + ')' : ''}, max ${Math.max(...results.map((r) => r?.rmMs ?? 0)).toFixed(1)}ms`
)
