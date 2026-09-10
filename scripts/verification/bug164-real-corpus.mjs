// BUG-164 — how much of the founder's REAL transcript corpus is the microphone's
// echo of the other party, and what it does to the coaching metric.
//
// WHAT THIS IS, AND THE LIMIT, STATED FIRST.
//
// The honest way to prove this fix would be to replay a call's raw Deepgram
// finals through the real TranscriptAccumulator. That is not possible from
// saved data: a stored segment is the accumulator's OUTPUT — already merged
// into runs, with `words` dropped — so feeding it back in would not reproduce
// the live arrival ORDER, and the arrival order is precisely what the fix's
// two directions (dropMicEcho / dropEarlierMicEcho) exist to handle. Claiming
// a replay here would be claiming a fidelity this data cannot support.
//
// So this measures the FIX'S OWN RULE against the real corpus instead:
// `echoKey` and `ECHO_MIN_CHARS` are EXTRACTED VERBATIM from the shipped
// source at runtime, never re-typed, so the thing measured cannot drift from
// the thing that ships (the technique BUG-187's conflict-guard-reach used).
//
// It answers two questions the unit tests cannot:
//   1. How common is this on real calls, rather than on the one call in the
//      entry?
//   2. What does removing it do to talk-to-listen — the headline coaching
//      metric the entry says is inflated "by construction"?
//
// Read-only: the founder's call records are read and never written.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const PROFILE = process.argv[2]
if (!PROFILE) throw new Error('usage: bug164-real-corpus.mjs <userDataDir>')

// ---- the fix's own rule, lifted from the shipped file -----------------------
const SRC = readFileSync(
  join(import.meta.dirname, '..', '..', 'src', 'main', 'live', 'transcript-accumulator.ts'),
  'utf8'
)
const minChars = Number(/const ECHO_MIN_CHARS = (\d+)/.exec(SRC)?.[1])
const lookback = Number(/const ECHO_LOOKBACK = (\d+)/.exec(SRC)?.[1])
if (!Number.isFinite(minChars) || !Number.isFinite(lookback)) {
  throw new Error('could not read ECHO_MIN_CHARS / ECHO_LOOKBACK from the shipped source')
}
const keyBody = /private static echoKey\(text: string\): string \{\s*return ([^\n]+)\n\s*\}/.exec(SRC)?.[1]
if (!keyBody) throw new Error('could not extract echoKey from the shipped source')
// eslint-disable-next-line no-new-func
const echoKey = new Function('text', `return ${keyBody}`)
console.log(`rule extracted from source: ECHO_MIN_CHARS=${minChars}, ECHO_LOOKBACK=${lookback}`)
console.log(`echoKey body: ${keyBody.trim()}`)
console.log('')

const words = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0)

let calls = 0
let segs = 0
let echoes = 0
let echoWords = 0
let repWordsBefore = 0
let otherWords = 0
const perCall = []

for (const f of readdirSync(join(PROFILE, 'calls')).filter((x) => x.endsWith('.json'))) {
  let c
  try {
    c = JSON.parse(readFileSync(join(PROFILE, 'calls', f), 'utf8'))
  } catch {
    continue
  }
  const list = c.segments ?? []
  if (!list.length || !list.some((s) => s.channel !== undefined)) continue
  calls++

  let cEcho = 0
  let cRep = 0
  let cOther = 0
  for (let i = 0; i < list.length; i++) {
    const seg = list[i]
    segs++
    const w = words(seg.text ?? '')
    if (seg.channel === 0) cRep += w
    else if (seg.channel === 1) cOther += w

    // The fix only ever removes a CHANNEL 0 copy — a loopback segment is never
    // a candidate, because the machine never plays the rep's own voice.
    if (seg.channel !== 0) continue
    const k = echoKey(seg.text ?? '')
    if (k.length < minChars) continue
    const lo = Math.max(0, i - lookback)
    const hi = Math.min(list.length, i + lookback + 1)
    let match = false
    for (let j = lo; j < hi; j++) {
      if (j === i) continue
      const o = list[j]
      if (o.channel !== 1) continue
      if (echoKey(o.text ?? '') === k) {
        match = true
        break
      }
    }
    if (match) {
      cEcho++
      echoes++
      echoWords += w
    }
  }
  repWordsBefore += cRep
  otherWords += cOther
  if (cEcho > 0) perCall.push({ id: f.slice(0, 8), segs: list.length, echo: cEcho, rep: cRep, other: cOther })
}

const share = (rep, other) => (rep + other > 0 ? (100 * rep) / (rep + other) : 0)
const before = share(repWordsBefore, otherWords)
const after = share(repWordsBefore - echoWords, otherWords)

console.log(`calls with channel data : ${calls}`)
console.log(`segments examined       : ${segs}`)
console.log(`segments the rule drops : ${echoes}  (${((100 * echoes) / segs).toFixed(1)}% of all segments)`)
console.log(`calls with >=1 echo     : ${perCall.length} of ${calls}  (${((100 * perCall.length) / calls).toFixed(0)}%)`)
console.log('')
console.log('TALK-TO-LISTEN, the headline coaching metric ("healthy 40-55%"):')
console.log(`  rep share of words BEFORE the fix : ${before.toFixed(1)}%`)
console.log(`  rep share of words AFTER  the fix : ${after.toFixed(1)}%`)
console.log(`  inflation removed                 : ${(before - after).toFixed(1)} points`)
console.log('')
perCall.sort((a, b) => b.echo - a.echo)
console.log('worst-affected calls (id, segments, echoes dropped, rep share before -> after):')
for (const p of perCall.slice(0, 8)) {
  const b = share(p.rep, p.other)
  const a = share(p.rep - 0, p.other) // per-call word delta not tracked; show counts
  console.log(`  ${p.id}  ${String(p.segs).padStart(4)} segs  ${String(p.echo).padStart(3)} echoes   rep/other words ${p.rep}/${p.other}  (${b.toFixed(0)}% share)`)
  void a
}
