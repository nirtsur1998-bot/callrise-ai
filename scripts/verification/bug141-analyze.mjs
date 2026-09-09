/**
 * BUG-141 analysis — read every JSONL record produced by bug141-loop.mjs and
 * answer, with numbers rather than impressions:
 *   1. how many full-suite runs per failure (the occurrence rate)
 *   2. what the TAIL of test durations looks like, suite-wide
 *   3. whether the FIRST test in a file is systematically dearer than the rest
 *      (the cold-module-graph hypothesis)
 *   4. what the worker was actually doing during any stall (cpu / event-loop
 *      delay / in-flight filesystem requests)
 *   5. for the target test, where its wall time went (import vs the turn)
 *
 * Usage: node scripts/verification/bug141-analyze.mjs [logDir]
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const LOG = process.argv[2] ?? join(process.cwd(), '.bug141')
const TARGET = 'assistant-ipc.turn.test.ts'

const runs = existsSync(join(LOG, 'runs.jsonl'))
  ? readFileSync(join(LOG, 'runs.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  : []

const tests = []
const stalls = []
for (const d of readdirSync(LOG).filter((x) => x.startsWith('run-'))) {
  for (const f of readdirSync(join(LOG, d)).filter((x) => x.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(LOG, d, f), 'utf8').split('\n')) {
      if (!line.trim()) continue
      let r
      try {
        r = JSON.parse(line)
      } catch {
        continue
      }
      if (r.kind === 'test') tests.push(r)
      else if (r.kind === 'stall') stalls.push(r)
    }
  }
}

const pct = (arr, p) => {
  if (!arr.length) return NaN
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
const short = (f) => String(f).split('/').pop()

console.log('=== RUNS ===')
console.log(
  `completed: ${runs.length}   failures (exit!=0): ${runs.filter((r) => r.code !== 0).length}`
)
if (runs.length) {
  const ms = runs.map((r) => r.ms)
  console.log(
    `wall per run: p50 ${(pct(ms, 50) / 1000).toFixed(1)}s  min ${(Math.min(...ms) / 1000).toFixed(1)}s  max ${(Math.max(...ms) / 1000).toFixed(1)}s`
  )
}
for (const r of runs.filter((x) => x.code !== 0)) {
  const log = join(LOG, `run-${String(r.run).padStart(3, '0')}`, 'stdout.log')
  const txt = existsSync(log) ? readFileSync(log, 'utf8') : ''
  const lines = txt
    .split('\n')
    .filter((l) => /timed out|FAIL |✕|AssertionError/.test(l))
    .slice(0, 12)
  console.log(`\n  run ${r.run} exit ${r.code}:`)
  for (const l of lines) console.log('    ' + l.trim().slice(0, 160))
}

console.log('\n=== TEST DURATION TAIL (all files, all runs) ===')
const durs = tests.map((t) => t.dur)
console.log(`records: ${tests.length}`)
console.log(
  `p50 ${pct(durs, 50)}ms  p90 ${pct(durs, 90)}ms  p99 ${pct(durs, 99)}ms  p99.9 ${pct(durs, 99.9)}ms  max ${Math.max(...durs)}ms`
)
for (const th of [1000, 2000, 5000, 10000, 15000]) {
  console.log(`  tests over ${th}ms: ${durs.filter((d) => d > th).length}`)
}

console.log('\n=== SLOWEST 20 TEST RECORDS ===')
for (const t of [...tests].sort((a, b) => b.dur - a.dur).slice(0, 20)) {
  console.log(
    `  ${String(t.dur).padStart(6)}ms cpu=${String(t.cpuMs).padStart(5)} elMax=${String(t.elMax).padStart(5)} run=${t.run} idx=${t.idx} ${short(t.file)} :: ${String(t.name).slice(0, 60)}`
  )
}

console.log('\n=== FIRST TEST IN FILE vs THE REST (cold module graph?) ===')
const first = tests.filter((t) => t.idx === 0).map((t) => t.dur)
const rest = tests.filter((t) => t.idx > 0).map((t) => t.dur)
console.log(
  `  idx==0 : n=${first.length} p50 ${pct(first, 50)}ms p90 ${pct(first, 90)}ms p99 ${pct(first, 99)}ms max ${Math.max(...first)}ms`
)
console.log(
  `  idx>0  : n=${rest.length} p50 ${pct(rest, 50)}ms p90 ${pct(rest, 90)}ms p99 ${pct(rest, 99)}ms max ${Math.max(...rest)}ms`
)

console.log('\n=== STALL RECORDS (watchdog fired) ===')
console.log(`count: ${stalls.length}`)
for (const s of [...stalls].sort((a, b) => b.waited - a.waited).slice(0, 30)) {
  console.log(
    `  waited=${s.waited} elapsed=${s.elapsed} cpu=${s.cpuMs} elMax=${s.elMax} reqs=${JSON.stringify(s.reqs)} phases=${JSON.stringify(s.phases ?? {})} run=${s.run} idx=${s.idx} ${short(s.file)} :: ${String(s.name).slice(0, 50)}`
  )
}

console.log(`\n=== TARGET FILE: ${TARGET} ===`)
const tt = tests.filter((t) => String(t.file).includes(TARGET))
const t0 = tt.filter((t) => t.idx === 0)
if (t0.length) {
  const d = t0.map((t) => t.dur)
  console.log(
    `  first it(), n=${d.length}: p50 ${pct(d, 50)}ms p90 ${pct(d, 90)}ms max ${Math.max(...d)}ms`
  )
  const imp = t0.map((t) => t.phases?.import ?? 0)
  const conv = t0.map((t) => t.phases?.createConversation ?? 0)
  const mk = t0.map((t) => t.phases?.mkdtemp ?? 0)
  console.log(
    `    phase import           : p50 ${pct(imp, 50)}ms p90 ${pct(imp, 90)}ms max ${Math.max(...imp)}ms`
  )
  console.log(
    `    phase createConversation: p50 ${pct(conv, 50)}ms p90 ${pct(conv, 90)}ms max ${Math.max(...conv)}ms`
  )
  console.log(
    `    phase mkdtemp          : p50 ${pct(mk, 50)}ms p90 ${pct(mk, 90)}ms max ${Math.max(...mk)}ms`
  )
  const worst = [...t0].sort((a, b) => b.dur - a.dur).slice(0, 8)
  console.log('    worst instances:')
  for (const w of worst)
    console.log(
      `      ${w.dur}ms  phases=${JSON.stringify(w.phases ?? {})} run=${w.run} state=${w.state}`
    )
}
const rd = tt.filter((t) => t.idx > 0).map((t) => t.dur)
if (rd.length)
  console.log(
    `  rest of file, n=${rd.length}: p50 ${pct(rd, 50)}ms p90 ${pct(rd, 90)}ms max ${Math.max(...rd)}ms`
  )

console.log('\n=== FILES WITH THE FATTEST FIRST-TEST TAIL ===')
const byFile = new Map()
for (const t of tests.filter((x) => x.idx === 0)) {
  const k = short(t.file)
  if (!byFile.has(k)) byFile.set(k, [])
  byFile.get(k).push(t.dur)
}
const rows = [...byFile.entries()].map(([k, v]) => [k, pct(v, 50), Math.max(...v), v.length])
for (const [k, p50, max, n] of rows.sort((a, b) => b[2] - a[2]).slice(0, 15)) {
  console.log(`  max ${String(max).padStart(6)}ms  p50 ${String(p50).padStart(5)}ms  n=${n}  ${k}`)
}

console.log('\n=== TARGET IMPORT COST vs SUITE-WIDE PIPELINE PRESSURE (per run) ===')
console.log('  A cold `await import()` inside a test body is served by ONE shared vite')
console.log('  server in the main process. If that pipeline is the stall, the target')
console.log('  test\u2019s import phase should track the run\u2019s own transform/import totals.')
const footer = (n) => {
  const pad = /^\d+$/.test(String(n)) ? String(n).padStart(3, '0') : String(n)
  const f = join(LOG, `run-${pad}`, 'stdout.log')
  if (!existsSync(f)) return null
  const m = readFileSync(f, 'utf8').match(
    /Duration\s+([\d.]+)s \(transform ([\d.]+)s, setup ([\d.]+)s, import ([\d.]+)s, tests ([\d.]+)s, environment ([\d.]+)s\)/
  )
  if (!m) return null
  return { wall: +m[1], transform: +m[2], setup: +m[3], imp: +m[4], tests: +m[5], env: +m[6] }
}
const perRun = new Map()
for (const t of tests.filter((x) => String(x.file).includes(TARGET) && x.idx === 0))
  perRun.set(String(t.run), t)
console.log(
  '   run | target it#1 | import | createConv | suite transform | suite import | suite env | worker files'
)
for (const [run, t] of [...perRun.entries()].sort((a, b) =>
  String(a[0]).localeCompare(String(b[0]))
)) {
  const f = footer(run)
  const sameWorker = tests.filter((x) => String(x.run) === String(run) && x.pid === t.pid)
  const filesInWorker = new Set(sameWorker.map((x) => x.file)).size
  // Was the target the FIRST file this worker process handled? If it was the
  // only one, cross-file contamination inside a reused worker — this entry's
  // stated "sole surviving hypothesis" — is structurally impossible for it.
  const firstInWorker =
    sameWorker.reduce((acc, x) => (acc === null || x.at - x.dur < acc.at - acc.dur ? x : acc), null)
      ?.file === t.file
  console.log(
    `  ${String(run).padStart(4)} | ${String(t.dur).padStart(10)}ms | ${String(t.phases?.import ?? '?').padStart(5)}ms | ${String(t.phases?.createConversation ?? '?').padStart(9)}ms | ${String(f ? f.transform.toFixed(1) : '?').padStart(9)}s | ${String(f ? f.imp.toFixed(1) : '?').padStart(8)}s | ${String(f ? f.env.toFixed(1) : '?').padStart(6)}s | ${filesInWorker}${firstInWorker ? ' (target first)' : ' (target NOT first)'}`
  )
}

console.log('\n=== CONCURRENCY AT THE TARGET TEST (how many tests were in flight) ===')
for (const [run, t] of [...perRun.entries()].sort((a, b) =>
  String(a[0]).localeCompare(String(b[0]))
)) {
  const start = t.at - t.dur
  const overlap = tests.filter(
    (x) => String(x.run) === String(run) && x.pid !== t.pid && x.at > start && x.at - x.dur < t.at
  )
  const heavy = overlap.filter((x) => x.dur > 5000)
  console.log(
    `  run ${String(run).padStart(3)}: import ${String(t.phases?.import ?? '?').padStart(5)}ms | overlapping tests ${String(overlap.length).padStart(4)} | of them >5s: ${String(heavy.length).padStart(3)} | distinct workers ${new Set(overlap.map((x) => x.pid)).size}`
  )
}

// Extra positional args name files (substring match) to report first-test
// stats for, so a before/after on a specific fix is directly comparable
// rather than eyeballed out of the "fattest tail" table.
const WATCH = process.argv.slice(3)
if (WATCH.length) {
  console.log('\n=== FIRST it() PER WATCHED FILE ===')
  for (const w of WATCH) {
    const rows = tests.filter((t) => String(t.file).includes(w) && t.idx === 0).map((t) => t.dur)
    if (!rows.length) {
      console.log(`  ${w}: no records`)
      continue
    }
    console.log(
      `  ${w}: n=${rows.length} p50 ${pct(rows, 50)}ms p90 ${pct(rows, 90)}ms max ${Math.max(...rows)}ms`
    )
  }
}
