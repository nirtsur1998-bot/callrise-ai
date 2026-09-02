#!/usr/bin/env tsx
// echo-dry-run.ts — what BUG-164's microphone-echo dedupe WOULD delete from
// your real calls, without deleting anything.
//
//   npx tsx scripts/verification/echo-dry-run.ts
//   npx tsx scripts/verification/echo-dry-run.ts --since 2026-09-02
//   npx tsx scripts/verification/echo-dry-run.ts --show 20   # print the text
//
// WHY THIS EXISTS. The dedupe was proven on a test rig that plays both voices
// through the speakers — a rig that MANUFACTURED the echo it then detected.
// Real calls will have echo of a different shape, at different levels, on
// different hardware. The founder's condition before it merges, and it is the
// right one: "a dry run is the difference between 'proven on my rig' and
// 'proven on your data', and for something that deletes I want the second."
//
// It imports the SHIPPING predicate (isMicEchoOf) rather than reimplementing
// it. A dry run with its own copy of the rule is a second source of truth, and
// the first time the two drift it reports on a rule that is not what runs.
//
// THE TWO QUESTIONS IT ANSWERS, in the founder's words:
//   - does the ~38% duplication hold on real speakerphone calls?
//   - does it fire on calls where I was on HEADPHONES? That would be a false
//     positive deleting real speech, and it must be visible before shipping.
//
// WHAT IT CANNOT TELL YOU, stated rather than discovered later. This replays
// SAVED transcripts, where consecutive same-speaker runs have already been
// merged. The live path sees them one run at a time. So a saved segment can be
// longer than any single live run, which makes this a close proxy and not a
// bit-exact simulation — it can differ at the margins in BOTH directions. It
// is the right instrument for "is the rate plausible and are headphone calls
// clean", and the wrong one for "exactly N segments will go".
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isMicEchoOf, ECHO_LOOKBACK } from '../../src/main/live/transcript-accumulator'

const CALLS = 'C:/Users/User/AppData/Roaming/sales-os/calls'

const argOf = (name: string): string | undefined => {
  const i = process.argv.indexOf('--' + name)
  return i !== -1 ? process.argv[i + 1] : undefined
}
const SINCE = argOf('since')
const SHOW = Number(argOf('show') ?? 0)

type Seg = { speaker?: number; channel?: number; text?: string; kind?: string }
type Call = { id?: string; createdAt?: string; deleted?: boolean; segments?: Seg[] }

// RED CHECK. A tool that reports "nothing would be deleted" is making a claim
// about ITSELF until it has been shown to detect something it should. Plant an
// echo it must find, and an innocent pair it must not, and refuse to report at
// all if either goes the wrong way.
{
  const ECHO = 'my finance director has to approve anything over twenty thousand dollars'
  const planted = isMicEchoOf(ECHO, 'My finance director has to approve anything over twenty thousand dollars.')
  const grown = isMicEchoOf(ECHO, 'and then he said my finance director has to approve anything over twenty thousand dollars')
  const innocent = isMicEchoOf('okay', 'okay')
  const different = isMicEchoOf(ECHO, 'we are locked in with our current vendor until the fifteenth of March')
  if (!planted || !grown || innocent || different) {
    console.error('')
    console.error('REFUSING TO REPORT — the matcher does not behave as this tool assumes:')
    console.error(`  identical text matched      : ${planted}   (must be true)`)
    console.error(`  suffix of a merged run      : ${grown}   (must be true)`)
    console.error(`  short coincidence "okay"    : ${innocent}   (must be false)`)
    console.error(`  unrelated sentences         : ${different}   (must be false)`)
    process.exit(3)
  }
  console.log('red check — matcher finds a planted echo, ignores a short coincidence: OK')
}

const files = readdirSync(CALLS).filter((f) => f.endsWith('.json'))
type Row = {
  id: string
  at: string
  mic: number
  loop: number
  wouldDrop: number
  samples: string[]
}
const rows: Row[] = []
let skippedMono = 0
let skippedEmpty = 0

for (const f of files) {
  const p = join(CALLS, f)
  if (!statSync(p).isFile()) continue
  let call: Call
  try {
    call = JSON.parse(readFileSync(p, 'utf8')) as Call
  } catch {
    continue
  }
  if (call.deleted === true) continue
  if (SINCE && (call.createdAt ?? '') < SINCE) continue

  const segs = (call.segments ?? []).filter((s) => s.kind !== 'gap' && (s.text ?? '').trim())
  if (segs.length === 0) {
    skippedEmpty++
    continue
  }
  // A call with no loopback channel cannot have echo by construction — there
  // is no other-party audio for the microphone to have picked up. Counting
  // those in the denominator would understate the rate on the calls that CAN.
  const hasLoopback = segs.some((s) => s.channel === 1)
  if (!hasLoopback) {
    skippedMono++
    continue
  }

  const mic = segs.filter((s) => s.channel === 0)
  const loop = segs.filter((s) => s.channel === 1)
  let wouldDrop = 0
  const samples: string[] = []

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    if (s.channel !== 0) continue
    // Same window the live path uses, applied around this segment's position.
    const from = Math.max(0, i - ECHO_LOOKBACK)
    const to = Math.min(segs.length, i + ECHO_LOOKBACK + 1)
    const nearbyLoopback = segs.slice(from, to).filter((x) => x.channel === 1)
    const hit = nearbyLoopback.some((x) => isMicEchoOf(s.text ?? '', x.text ?? ''))
    if (hit) {
      wouldDrop++
      if (samples.length < 3) samples.push((s.text ?? '').trim().slice(0, 96))
    }
  }

  rows.push({
    id: (call.id ?? f).slice(0, 8),
    at: (call.createdAt ?? '').slice(0, 16).replace('T', ' '),
    mic: mic.length,
    loop: loop.length,
    wouldDrop,
    samples
  })
}

rows.sort((a, b) => b.wouldDrop / Math.max(1, b.mic) - a.wouldDrop / Math.max(1, a.mic))

const pct = (n: number, d: number): string => (d === 0 ? '  -' : String(Math.round((n / d) * 100)).padStart(3))
const totalMic = rows.reduce((s, r) => s + r.mic, 0)
const totalDrop = rows.reduce((s, r) => s + r.wouldDrop, 0)
const clean = rows.filter((r) => r.wouldDrop === 0)
const affected = rows.filter((r) => r.wouldDrop > 0)

console.log('')
console.log('BUG-164 ECHO DEDUPE — DRY RUN. Nothing is written or deleted.')
console.log('Rule imported from the shipping code (isMicEchoOf), not reimplemented.')
console.log('')
console.log(`two-channel calls examined : ${rows.length}`)
console.log(`  skipped, no loopback     : ${skippedMono}  (cannot have echo by construction)`)
console.log(`  skipped, empty           : ${skippedEmpty}`)
console.log('')
console.log(`microphone segments        : ${totalMic}`)
console.log(`WOULD BE DROPPED           : ${totalDrop}  (${pct(totalDrop, totalMic).trim()}% of mic segments)`)
console.log('')
console.log('THE QUESTION THAT DECIDES IT — how many calls are untouched?')
console.log(`  calls with ZERO drops    : ${clean.length} of ${rows.length}`)
console.log(`  calls with some drops    : ${affected.length} of ${rows.length}`)
console.log('')
console.log('  A call you took on HEADPHONES should appear with zero drops. If a')
console.log('  call you remember taking on headphones shows drops, that is a false')
console.log('  positive deleting real speech — and the reason to look before shipping.')
console.log('')

if (rows.length) {
  console.log('per call, worst first:')
  console.log('   date              call      mic  loop   drop    %')
  for (const r of rows.slice(0, 25)) {
    console.log(
      `   ${r.at.padEnd(17)} ${r.id}  ${String(r.mic).padStart(4)}  ${String(r.loop).padStart(4)}  ${String(r.wouldDrop).padStart(5)}  ${pct(r.wouldDrop, r.mic)}%`
    )
  }
  if (rows.length > 25) console.log(`   … and ${rows.length - 25} more`)
}

if (SHOW > 0) {
  console.log('')
  console.log(`the actual text that would be removed (first ${SHOW}):`)
  let shown = 0
  for (const r of affected) {
    for (const s of r.samples) {
      if (shown >= SHOW) break
      console.log(`   [${r.at}] ${s}`)
      shown++
    }
    if (shown >= SHOW) break
  }
  console.log('')
  console.log('   Every line above should be something the OTHER PARTY said.')
  console.log('   If any of it is you, stop — that is the false positive.')
}
console.log('')
