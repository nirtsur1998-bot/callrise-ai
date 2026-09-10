// BUG-D — the mono-worklet hypothesis, tested against data we already have.
//
// THE HYPOTHESIS: the capture worklet emits mono where the pipeline assumes
// stereo (or the reverse), so audio FRAMES are counted as half their real
// duration. A call that ran ten minutes submits five minutes of audio, the
// server transcribes five minutes, and the transcript comes out thin.
//
// THE PREDICTION, WRITTEN BEFORE LOOKING, so it can fail:
//   ratio = submittedSec / (durationMs / 1000)
//   - mono bug present  -> ratio ~= 0.5 on thin calls
//   - mono bug absent   -> ratio ~= 1.0 on thin AND healthy alike
// A ratio near 1.0 on the thin calls KILLS the hypothesis. That is a real
// outcome and is reported as one.
//
// WHY NOT durationMs vs endedAt, WHICH IS THE OBVIOUS TEST. Because both are
// wall clocks and it would always read 1.0. useTranscription.ts:241 sets
// `durationMs = performance.now() - startMs`, and endedAt is Date.now() at the
// same instant. Comparing them compares two clocks to each other and says
// nothing about frames — it would have "eliminated" the hypothesis while
// leaving it untouched. The only frame-derived number in the system is
// `submittedSec`, which lag.ts accumulates from the audio actually sent, and
// it lives in session-health.log rather than on the call record (saved records
// carry no health payload — bug176-corpus-check.mjs:10-17 says so).
//
// MATCHING. session-health.log writes one line per session at session end;
// a call record carries endedAt (BUG-178) or updatedAt. They are paired by
// nearest timestamp within a tolerance, and every unmatched line is counted
// and reported rather than dropped silently.
//
// PRIVACY: reads records and prints only counts, ratios, seconds and dates.
// No transcript text, no names, no ids.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const PROFILE = 'C:/Users/User/AppData/Roaming/sales-os'
const CALLS = join(PROFILE, 'calls')
const LOG = join(PROFILE, 'session-health.log')
const MATCH_TOLERANCE_MS = 5 * 60 * 1000

/** BUG-176's measured threshold: healthy calls run ~7.9 segments/min, the
 *  low-capture notice fires below 1.0. */
const THIN_SEGMENTS_PER_MIN = 1.0

function parseLog() {
  const out = []
  for (const line of readFileSync(LOG, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const ts = Date.parse(line.slice(0, 24))
    if (!Number.isFinite(ts)) continue
    const num = (k) => {
      const m = new RegExp(`${k}=(-?[0-9.]+)`).exec(line)
      return m ? Number(m[1]) : undefined
    }
    const multi = /multichannel=(true|false)/.exec(line)?.[1]
    out.push({
      ts,
      submittedSec: num('submittedSec'),
      acknowledgedSec: num('acknowledgedSec'),
      driftPpm: num('driftPpm'),
      resets: num('resets'),
      multichannel: multi === 'true'
    })
  }
  return out
}

function parseCalls() {
  const out = []
  for (const f of readdirSync(CALLS)) {
    if (!f.endsWith('.json')) continue
    let c
    try {
      c = JSON.parse(readFileSync(join(CALLS, f), 'utf8'))
    } catch {
      continue
    }
    if (!c || c.deleted === true) continue
    const durationMs = Number(c.durationMs)
    if (!Number.isFinite(durationMs) || durationMs <= 0) continue
    // BUG-185 — updatedAt is USELESS as a time signal: every sync restamps
    // every file, so all 196 records read as today. And BUG-178's endedAt is
    // absent on all 27 calls saved since it shipped. So the end of the call is
    // reconstructed as createdAt + durationMs, which is the only pair of
    // fields that survives both.
    const startTs = Date.parse(c.createdAt ?? '')
    const endTs = Number.isFinite(startTs) ? startTs + durationMs : NaN
    if (!Number.isFinite(endTs)) continue
    const segments = Array.isArray(c.segments) ? c.segments.length : 0
    const minutes = durationMs / 60000
    out.push({
      endTs,
      durationMs,
      segments,
      segPerMin: minutes > 0 ? segments / minutes : 0,
      hasEndedAt: typeof c.endedAt === 'string'
    })
  }
  return out
}

const stats = (xs) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  return {
    n: s.length,
    min: s[0],
    p25: q(0.25),
    median: q(0.5),
    p75: q(0.75),
    max: s[s.length - 1],
    mean: s.reduce((a, b) => a + b, 0) / s.length
  }
}
const fmt = (st, d = 2) =>
  st
    ? `n=${String(st.n).padStart(3)}  min=${st.min.toFixed(d)}  p25=${st.p25.toFixed(d)}  median=${st.median.toFixed(d)}  p75=${st.p75.toFixed(d)}  max=${st.max.toFixed(d)}`
    : 'n=0'

const log = parseLog()
const calls = parseCalls()
console.log('BUG-D — MONO-WORKLET RATIO TEST')
console.log('='.repeat(66))
console.log(`session-health lines : ${log.length}`)
console.log(`live call records    : ${calls.length}  (${calls.filter((c) => c.hasEndedAt).length} carry endedAt)`)

// ── pair each log line with its nearest call ────────────────────────────────
const paired = []
let unmatched = 0
for (const l of log) {
  if (!Number.isFinite(l.submittedSec) || l.submittedSec <= 0) continue
  let best = null
  for (const c of calls) {
    const d = Math.abs(c.endTs - l.ts)
    if (d <= MATCH_TOLERANCE_MS && (!best || d < best.d)) best = { c, d }
  }
  if (!best) {
    unmatched += 1
    continue
  }
  paired.push({
    ratio: l.submittedSec / (best.c.durationMs / 1000),
    segPerMin: best.c.segPerMin,
    driftPpm: l.driftPpm,
    multichannel: l.multichannel,
    submittedSec: l.submittedSec,
    durationSec: best.c.durationMs / 1000,
    deltaMs: best.d
  })
}
console.log(`paired               : ${paired.length}   unmatched log lines: ${unmatched}`)
if (paired.length === 0) {
  console.log('\nNOTHING PAIRED — the test cannot run. Not an elimination.')
  process.exit(2)
}

const thin = paired.filter((p) => p.segPerMin < THIN_SEGMENTS_PER_MIN)
const healthy = paired.filter((p) => p.segPerMin >= THIN_SEGMENTS_PER_MIN)

console.log(`\nsplit at ${THIN_SEGMENTS_PER_MIN} segments/min (BUG-176's measured threshold)`)
console.log(`  thin    : ${thin.length}`)
console.log(`  healthy : ${healthy.length}`)

console.log('\n── THE PREDICTION ──────────────────────────────────────────────')
console.log('  mono bug present -> thin ratio ~= 0.50, healthy ~= 1.00')
console.log('  mono bug absent  -> both ~= 1.00')

console.log('\n── RATIO  submittedSec / wall-clock seconds ────────────────────')
console.log(`  thin     ${fmt(stats(thin.map((p) => p.ratio)))}`)
console.log(`  healthy  ${fmt(stats(healthy.map((p) => p.ratio)))}`)

console.log('\n── DRIFT ppm (independent signal; a 2x frame miscount is ~500000) ──')
console.log(`  thin     ${fmt(stats(thin.map((p) => p.driftPpm).filter(Number.isFinite)), 0)}`)
console.log(`  healthy  ${fmt(stats(healthy.map((p) => p.driftPpm).filter(Number.isFinite)), 0)}`)

console.log('\n── SEGMENTS/MIN, to show the split is real and not an artefact ──')
console.log(`  thin     ${fmt(stats(thin.map((p) => p.segPerMin)))}`)
console.log(`  healthy  ${fmt(stats(healthy.map((p) => p.segPerMin)))}`)

console.log('\n── multichannel, by group ─────────────────────────────────────')
for (const [name, g] of [
  ['thin', thin],
  ['healthy', healthy]
]) {
  const on = g.filter((p) => p.multichannel).length
  console.log(`  ${name.padEnd(8)} multichannel=true ${on}/${g.length}`)
}

if (thin.length) {
  console.log('\n── EVERY THIN CALL, so a pattern is visible rather than a mean ──')
  console.log('   ratio  submitted   wall   seg/min  drift  multi  pair-delta')
  for (const p of thin.sort((a, b) => a.ratio - b.ratio)) {
    console.log(
      `  ${p.ratio.toFixed(3).padStart(6)}  ${p.submittedSec.toFixed(1).padStart(8)}  ${p.durationSec.toFixed(1).padStart(6)}  ${p.segPerMin.toFixed(2).padStart(7)}  ${String(p.driftPpm ?? '-').padStart(5)}  ${String(p.multichannel).padStart(5)}  ${(p.deltaMs / 1000).toFixed(0)}s`
    )
  }
}

console.log('\n── VERDICT ────────────────────────────────────────────────────')
const tm = stats(thin.map((p) => p.ratio))?.median
const hm = stats(healthy.map((p) => p.ratio))?.median
if (thin.length < 3) {
  console.log(`  ONLY ${thin.length} thin call(s) paired — too few to conclude either way.`)
  console.log('  This is neither confirmation nor elimination. Say so.')
} else if (tm !== undefined && tm < 0.65 && hm !== undefined && hm > 0.85) {
  console.log(`  CONSISTENT WITH THE HYPOTHESIS: thin median ${tm.toFixed(3)}, healthy ${hm.toFixed(3)}.`)
} else if (tm !== undefined && tm > 0.85) {
  console.log(`  HYPOTHESIS NOT SUPPORTED: thin median ratio is ${tm.toFixed(3)}, not ~0.5.`)
  console.log('  Frames are NOT being counted at half duration on the thin calls.')
} else {
  console.log(`  AMBIGUOUS: thin median ${tm?.toFixed(3)}, healthy median ${hm?.toFixed(3)}.`)
}
