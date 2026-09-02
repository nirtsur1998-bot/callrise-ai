#!/usr/bin/env node
// M33 / BUG-D — hypothesis 2: does the word deficit concentrate in the calls
// that recorded only one side?
//
// A call that captured one side holds roughly one side's worth of words, which
// is the right order of magnitude for the 50-80% deficit BUG-D measures. As of
// v1.8.0 those calls are identifiable by name. This partitions the SAME dataset
// BUG-D used and asks whether the deficit lives there.
//
// THIS IS A HYPOTHESIS UNDER TEST, NOT A FINDING. Two bugs in one subsystem
// being related is plausible and unproven, and plausible-and-unproven is what
// gets promoted to fact when nobody is watching. If the deficit does not
// concentrate, that is an elimination and a result — say so and cross it off.
//
// PRIVACY: reads call records, emits ONLY aggregates. No transcript text, no
// titles, no ids. Writes nothing, anywhere.
//
//   node scripts/verification/bugd-partition.mjs

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'C:/Users/User/AppData/Roaming/sales-os/calls'

// Mirrors src/renderer/src/features/calls/types.ts EXACTLY. If the shipped rule
// changes, this must change with it or the analysis and the app disagree.
const otherPartyPromisedButMissing = (call) => {
  if (call.consent?.recordOtherParty !== true) return false
  const speech = (call.segments ?? []).filter((s) => s.kind !== 'gap')
  if (speech.length === 0) return false
  return !speech.some((s) => s.channel === 0 || s.channel === 1)
}

const calls = []
for (const f of readdirSync(DIR)) {
  if (!f.endsWith('.json')) continue
  let c
  try { c = JSON.parse(readFileSync(join(DIR, f), 'utf8')) } catch { continue }
  if (!c?.segments) continue
  const speech = c.segments.filter((s) => s.kind !== 'gap')
  const words = speech.reduce((n, s) => n + String(s.text ?? '').trim().split(/\s+/).filter(Boolean).length, 0)
  const mins = (c.durationMs ?? 0) / 60000
  calls.push({
    mins, words,
    wpm: mins > 0 ? words / mins : 0,
    epochs: new Set(speech.map((s) => s.epoch)).size,
    anyChannel: speech.some((s) => s.channel === 0 || s.channel === 1),
    promisedBoth: c.consent?.recordOtherParty === true,
    half: otherPartyPromisedButMissing(c),
    day: String(c.createdAt ?? '').slice(0, 10)
  })
}

const mean = (a, k) => (a.length ? a.reduce((s, x) => s + x[k], 0) / a.length : 0)
const row = (label, a) =>
  console.log(`  ${label.padEnd(34)} n=${String(a.length).padStart(3)}   mean wpm ${mean(a, 'wpm').toFixed(1).padStart(6)}   mean epochs ${mean(a, 'epochs').toFixed(2)}`)

// BUG-D's dataset filter, unchanged: >=2 minutes with a non-empty transcript.
const set = calls.filter((c) => c.mins >= 2 && c.words > 0)
console.log(`\nloaded ${calls.length} call records; BUG-D dataset (>=2 min, non-empty) = ${set.length}\n`)

// ── RED CHECK 1 ────────────────────────────────────────────────────────────
// A random split of the same data must show NO meaningful wpm gap. If it does,
// the sample is noise-dominated and no partition here means anything.
let seed = 20260902
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const shuffled = [...set].sort(() => rand() - 0.5)
const a = shuffled.slice(0, Math.floor(shuffled.length / 2))
const b = shuffled.slice(Math.floor(shuffled.length / 2))
const noiseGap = Math.abs(mean(a, 'wpm') - mean(b, 'wpm'))
console.log('RED CHECK — a random split of the same calls, which must show ~no gap:')
row('random half A', a)
row('random half B', b)
console.log(`  => noise floor for this metric: ${noiseGap.toFixed(1)} wpm\n`)

// ── THE CONFOUND, checked before the partition is believed ─────────────────
// If channel tagging only began on some date, every call before it has no
// channel on any segment and would be flagged regardless of what was captured.
const tagged = calls.filter((c) => c.anyChannel).map((c) => c.day).sort()
const untagged = calls.filter((c) => !c.anyChannel && c.promisedBoth).map((c) => c.day).sort()
console.log('CONFOUND CHECK — when does channel tagging actually appear?')
console.log(`  calls WITH a channel      : ${tagged.length}   ${tagged[0] ?? '-'} … ${tagged.at(-1) ?? '-'}`)
console.log(`  flagged (promised, none)  : ${untagged.length}   ${untagged[0] ?? '-'} … ${untagged.at(-1) ?? '-'}`)
const overlap = untagged.filter((d) => d >= (tagged[0] ?? '9999')).length
console.log(`  flagged calls dated AFTER channel tagging began: ${overlap} of ${untagged.length}`)
console.log(overlap === untagged.length
  ? '  => no date confound: every flagged call is from a period that DID tag channels.'
  : `  => *** CONFOUND: ${untagged.length - overlap} flagged call(s) predate any channel tagging.`)

// ── THE PARTITION ──────────────────────────────────────────────────────────
console.log('\nHYPOTHESIS 2 — does the deficit concentrate in the half-recorded calls?')
row('half-recorded (one side only)', set.filter((c) => c.half))
row('fully recorded', set.filter((c) => !c.half))

// Held against the established predictor: reconnect COUNT already explains a
// lot. If half-recorded only looks bad because those calls also reconnect more,
// it is not an independent explanation.
console.log('\n  held against the established predictor (reconnect count):')
for (const [label, f] of [['1 epoch (no reconnect)', (c) => c.epochs === 1], ['>=3 epochs', (c) => c.epochs >= 3]]) {
  const g = set.filter(f)
  row(`  ${label} · half`, g.filter((c) => c.half))
  row(`  ${label} · full`, g.filter((c) => !c.half))
}
console.log('')
