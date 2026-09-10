// BUG-225 — read the cue latency the app has been recording.
//
// This is the command BUG-222 was waiting on. Until now the only cue-latency
// figures anywhere were TARGETS — the 6,000 ms budget, the 10,000 ms ceiling,
// the 3,000 ms per-attempt slice. There was no measured p50 or p95 on any
// machine, ever, so "adding client facts to the prompt did not make it slower"
// and "it did" were equally unfalsifiable.
//
// POOLED, not averaged. A percentile of percentiles is not a percentile: mean
// the per-call p95s and a 3-cue call counts the same as a 200-cue one, and the
// tail — the thing a p95 exists to expose — disappears. Every figure below is
// computed from the pooled samples of every call in range.
//
// Read-only. Numbers only; the log holds no cue or transcript text.
//
// usage:
//   node scripts/verification/cue-latency-report.mjs <userDataDir> [--since ISO] [--calls N]
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const PROFILE = process.argv[2]
if (!PROFILE) throw new Error('usage: cue-latency-report.mjs <userDataDir> [--since ISO] [--calls N]')
const arg = (f) => {
  const i = process.argv.indexOf(f)
  return i > 0 ? process.argv[i + 1] : undefined
}
const since = arg('--since')
const limit = Number(arg('--calls') || 0) || null

const path = join(PROFILE, 'cue-latency.jsonl')
if (!existsSync(path)) {
  console.log(`no cue-latency log at ${path}`)
  console.log('')
  console.log('That is an ABSENCE OF DATA, not a report that latency is fine: the log is')
  console.log('written when a call with at least one cue ends, so an empty one means no')
  console.log('such call has happened since BUG-225 landed.')
  process.exit(0)
}

let entries = readFileSync(path, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l)
    } catch {
      return null
    }
  })
  .filter(Boolean)

if (since) entries = entries.filter((e) => String(e.ts) >= since)
if (limit) entries = entries.slice(-limit)

const percentile = (sorted, p) => {
  if (!sorted.length) return null
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]
}

const pool = (tier) => {
  const all = []
  let calls = 0
  for (const e of entries) {
    const s = e?.samples?.[tier] ?? []
    if (s.length) calls++
    for (const n of s) if (Number.isFinite(n) && n >= 0) all.push(n)
  }
  all.sort((a, b) => a - b)
  return { calls, count: all.length, p50: percentile(all, 50), p95: percentile(all, 95), max: all.at(-1) ?? null }
}

const ms = (v) => (v === null || v === undefined ? '   —' : `${String(v).padStart(5)}ms`)

console.log(`cue latency, pooled across ${entries.length} call${entries.length === 1 ? '' : 's'}`)
if (since) console.log(`  since ${since}`)
if (entries.length) console.log(`  ${entries[0].ts}  ->  ${entries.at(-1).ts}`)
console.log('')
console.log('  tier            calls  samples      p50      p95      max   target')
console.log('  ' + '-'.repeat(66))
for (const [tier, target] of [
  ['deterministic', '~400ms (phrase match + render)'],
  ['model', '1.5-2.5s, never allowed to interrupt']
]) {
  const s = pool(tier)
  console.log(
    `  ${tier.padEnd(15)} ${String(s.calls).padStart(4)} ${String(s.count).padStart(8)}` +
      `  ${ms(s.p50)} ${ms(s.p95)} ${ms(s.max)}   ${target}`
  )
}
console.log('')
console.log('Nearest-rank percentiles: every number above is a latency that genuinely')
console.log('occurred on this machine, not an interpolated value nobody experienced.')
console.log('')
console.log('TO ANSWER BUG-222: run this before the prompt change and again after, with')
console.log('--since set to the moment the change landed, and compare the MODEL row.')
console.log('A difference smaller than the spread between two identical runs is not a')
console.log('difference; record how many calls each side had before drawing a line.')
