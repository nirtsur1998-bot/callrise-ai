// M37 Stage 2 — BUG-D TRIAGE. The branch question, answered in one look.
//
// The founder's framing, and the only question this answers:
//
//     "multichannel=true means capture worked and the fault is downstream;
//      only false means the restart failed"
//
// THIS IS AN INSTRUMENT, NOT A HYPOTHESIS. It proposes no mechanism. It reads
// call records that already exist and reports, per call, which side of that
// branch the call falls on and the numbers behind the answer. Three
// hypotheses have died on this bug, each because the measurement to test it
// did not exist; the standing order is to stop theorising and make the next
// occurrence answer for itself.
//
// PRIVACY: reads call JSON, emits ONLY numbers, verdicts and ids. Never a word
// of a transcript, never a title, never a contact. Writes nothing unless
// --json <path> is given, and that output obeys the same rule. This is the
// same posture as support-bundle.ts, and it is what makes the output safe to
// send.
//
//   node scripts/verification/bugd-triage.mjs                        # worst 20 by wpm
//   node scripts/verification/bugd-triage.mjs --call <id>            # one call, in full
//   node scripts/verification/bugd-triage.mjs --all --json out.json  # everything, machine-readable
//   node scripts/verification/bugd-triage.mjs --calls <dir>          # a different profile
//   node scripts/verification/bugd-triage.mjs --shapes call-shapes.json
//        # the evidence collect-bugd-evidence.ps1 gathers on the work PC.
//        # Same verdicts from an input that never contained a transcript:
//        # verified over the founder's 184 calls, 19 fields each, 0 differences.
//
// THE DUPLICATION HAZARD, stated because it already bit this project once:
// the rules below mirror src/renderer/src/features/calls/types.ts. A copy goes
// stale silently, so `bugd-triage-agrees-with-the-app.test.ts` pins the two
// together and fails if the shipped constant moves.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** MIRRORS types.ts CHANNEL_ATTRIBUTION_SINCE — pinned by test. Before this
 *  date the app did not attribute channels at all, so "no channel" carries no
 *  information and the branch question cannot be answered. */
export const CHANNEL_ATTRIBUTION_SINCE = '2026-07-29'

const argv = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name)
  return i >= 0 ? (argv[i + 1] ?? true) : fallback
}
const has = (name) => argv.includes(name)

const CALLS_DIR = resolve(
  flag('--calls') ||
    join(process.env.APPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming'), 'sales-os', 'calls')
)

/** The verdicts. Exported so the test can enumerate them. */
export const VERDICT = {
  CAPTURE_WORKED: 'CAPTURE WORKED — channels attached; the fault is DOWNSTREAM',
  NEVER_ATTACHED: 'CAPTURE FAILED — buyer capture was promised and NO channel ever attached',
  MONO_BY_DESIGN: 'mono by design — buyer capture was not switched on for this call',
  CANNOT_JUDGE: 'CANNOT JUDGE — call predates channel attribution',
  NO_SPEECH: 'NO SPEECH AT ALL — nothing was transcribed'
}

/**
 * One shape in, from either source.
 *
 * A raw call record from disk carries `segments[].text` and
 * `consent.recordOtherParty`. The evidence collected on the work PC by
 * collect-bugd-evidence.ps1 carries `segments[].words` (a COUNT, never the
 * words) and a top-level `recordOtherParty`, because it must never copy
 * transcript text off that machine. Normalising here is what lets ONE copy of
 * the verdict logic serve both, which is the whole design: the collector does
 * no analysis, so it can never disagree with this file.
 */
function normalize(call) {
  const segs = Array.isArray(call.segments) ? call.segments : []
  return {
    id: call.id,
    createdAt: call.createdAt,
    durationMs: call.durationMs,
    summary: call.summary,
    hasSummary: call.hasSummary ?? Boolean(call.summary),
    recordOtherParty: call.consent ? call.consent.recordOtherParty === true : call.recordOtherParty === true,
    // null and undefined must mean the SAME thing here. A raw call record
    // OMITS a field the app never set; PowerShell's ConvertTo-Json writes that
    // same absence as an explicit null. Without this, a call with no epoch
    // tracking read as ONE epoch and therefore "0 reconnects" instead of
    // "unknown" — a confidently wrong number, on the exact variable BUG-D's
    // first hypothesis was about. Caught by comparing the two input paths over
    // all 184 calls rather than by trusting that they agreed: 32 calls, 64
    // fields, silently different.
    segments: segs.map((s) => ({
      speaker: s.speaker ?? undefined,
      channel: s.channel ?? undefined,
      epoch: s.epoch ?? undefined,
      kind: s.kind ?? undefined,
      confidence: s.confidence ?? undefined,
      unlabelled: s.unlabelled ?? undefined,
      words: typeof s.words === 'number' ? s.words : (String(s.text ?? '').match(/\S+/g) ?? []).length,
      gapSeconds:
        typeof s.gapSeconds === 'number'
          ? s.gapSeconds
          : (() => {
              const m = GAP_RE.exec(String(s.text ?? ''))
              return m ? Number(m[1]) || 0 : 0
            })()
    }))
  }
}

/**
 * The branch, and nothing else.
 *
 * A channel on ANY segment is a hardware fact: the multichannel path attached
 * and audio was attributed to a side. Words can still be missing after that —
 * which is the whole point of the branch: it says the restart is NOT the
 * suspect and the fault lies downstream, in what Deepgram did with audio it
 * received.
 *
 * Deliberately NOT "channel 1 has no segments": a quiet buyer produces that,
 * and calling a working recording a failure is its own harm (the same
 * asymmetry otherPartyPromisedButMissing takes in the app).
 */
export function branch(raw) {
  const call = normalize(raw)
  const segs = call.segments
  const speech = segs.filter((s) => s?.kind !== 'gap')
  const created = call.createdAt ? new Date(call.createdAt) : null
  const dateOk =
    created && !Number.isNaN(created.getTime()) && created.toISOString().slice(0, 10) >= CHANNEL_ATTRIBUTION_SINCE

  if (speech.length === 0) return VERDICT.NO_SPEECH
  if (speech.some((s) => s.channel === 0 || s.channel === 1)) return VERDICT.CAPTURE_WORKED
  if (!dateOk) return VERDICT.CANNOT_JUDGE
  if (!call.recordOtherParty) return VERDICT.MONO_BY_DESIGN
  return VERDICT.NEVER_ATTACHED
}

const GAP_RE = /\[gap:\s*([\d.]+)\s*s\]/i

/** Every number this instrument can derive from a call record TODAY. */
export function measure(raw) {
  const call = normalize(raw)
  const segs = call.segments
  const speech = segs.filter((s) => s?.kind !== 'gap')
  const gaps = segs.filter((s) => s?.kind === 'gap')

  let words = 0
  for (const s of speech) words += s.words

  let gapSeconds = 0
  for (const g of gaps) gapSeconds += g.gapSeconds

  const epochs = new Set(speech.map((s) => (s.epoch === undefined ? 'none' : s.epoch)))
  const ch = { 0: 0, 1: 0, none: 0 }
  for (const s of speech) {
    if (s.channel === 0) ch[0]++
    else if (s.channel === 1) ch[1]++
    else ch.none++
  }
  const confidences = speech.map((s) => s.confidence).filter((c) => typeof c === 'number')
  const durationMs = Number(call.durationMs ?? 0)
  const minutes = durationMs / 60000

  return {
    id: String(call.id ?? '(no id)'),
    createdAt: String(call.createdAt ?? ''),
    durationMin: Number(minutes.toFixed(2)),
    words,
    wpm: minutes > 0 ? Number((words / minutes).toFixed(1)) : null,
    turns: speech.length,
    // reconnects: distinct epochs minus the first. 'none' means the call
    // predates epoch tracking, so the count is unknown rather than zero.
    epochs: epochs.has('none') ? null : epochs.size,
    reconnects: epochs.has('none') ? null : Math.max(0, epochs.size - 1),
    gapMarkers: gaps.length,
    gapSeconds: Number(gapSeconds.toFixed(1)),
    channel0: ch[0],
    channel1: ch[1],
    channelless: ch.none,
    // How much the CAPTURE WORKED verdict is standing on. A channel label can
    // only come from the multichannel socket, so one is proof the socket
    // attached — but on a 5-minute call with a single labelled turn, saying
    // "capture worked" without saying how thin the evidence is would overstate
    // it. Reported, never hidden inside the verdict.
    channelEvidence:
      ch[0] + ch[1] === 0 ? 'none' : ch[0] > 0 && ch[1] > 0 ? 'both sides' : ch[0] + ch[1] === 1 ? 'ONE turn only' : 'one side',
    speakers: new Set(speech.map((s) => s.speaker)).size,
    unlabelled: speech.filter((s) => s.unlabelled === true).length,
    meanConfidence: confidences.length ? Number((confidences.reduce((a, b) => a + b, 0) / confidences.length).toFixed(3)) : null,
    promisedOtherParty: call.recordOtherParty,
    hasSummary: call.hasSummary,
    verdict: branch(call)
  }
}

/** Every file accounted for. A skipped record must never be invisible — a
 *  silent skip reads as "covered everything" when it did not, and this
 *  directory holds a deletion tombstone for every deleted call (the record is
 *  kept, the transcript dropped), which is a third of the files here. */
function loadAll(dir) {
  const out = []
  const skipped = { deleted: 0, malformed: 0 }
  let files
  try {
    files = readdirSync(dir)
  } catch (e) {
    console.error(`cannot read calls directory: ${dir}\n${e.message}`)
    process.exit(2)
  }
  const json = files.filter((f) => f.endsWith('.json'))
  for (const f of json) {
    try {
      const call = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      if (call?.deleted === true) {
        skipped.deleted++
        continue
      }
      out.push(measure(call))
    } catch {
      skipped.malformed++
    }
  }
  return { rows: out, total: json.length, skipped }
}

function printOne(r) {
  console.log(`\n  call ${r.id}   ${r.createdAt.slice(0, 16).replace('T', ' ')}`)
  console.log(`  ${r.verdict}`)
  console.log(`    duration ${r.durationMin} min · ${r.words} words · ${r.wpm === null ? 'wpm n/a' : r.wpm + ' wpm'} · ${r.turns} turns`)
  console.log(
    `    channels: ch0 ${r.channel0} · ch1 ${r.channel1} · none ${r.channelless} [evidence: ${r.channelEvidence}]   (buyer capture promised: ${r.promisedOtherParty ? 'yes' : 'no'})`
  )
  console.log(
    `    epochs ${r.epochs ?? 'unknown'} (${r.reconnects === null ? 'reconnects unknown' : r.reconnects + ' reconnects'}) · gaps ${r.gapMarkers} totalling ${r.gapSeconds}s`
  )
  console.log(`    speakers ${r.speakers} · unlabelled turns ${r.unlabelled} · mean confidence ${r.meanConfidence ?? 'n/a'}`)
}

/** The evidence collected on the work PC: same verdicts, no transcript text
 *  ever present in the input. This is the mode used on whatever the founder
 *  sends after a call comes out thin. */
function loadShapes(file) {
  // Strip a UTF-8 BOM. Windows PowerShell's Set-Content -Encoding UTF8 always
  // writes one and JSON.parse rejects it outright, so the founder's evidence
  // would have arrived unreadable. The collector no longer writes one; this
  // stays because the file may come from any Windows tool.
  const parsed = JSON.parse(readFileSync(resolve(file), 'utf8').replace(/^﻿/, ''))
  const arr = Array.isArray(parsed) ? parsed : [parsed]
  return { rows: arr.map(measure), total: arr.length, skipped: { deleted: 0, malformed: 0 } }
}

const shapesFile = flag('--shapes')
const loaded = typeof shapesFile === 'string' ? loadShapes(shapesFile) : loadAll(CALLS_DIR)
const rows = loaded.rows
const one = flag('--call')

if (typeof shapesFile === 'string') {
  console.log(`BUG-D triage — collected evidence ${resolve(shapesFile)}`)
  console.log(`  ${rows.length} call shapes (metadata only; this file contains no transcript text)`)
} else {
  console.log(`BUG-D triage — ${CALLS_DIR}`)
  console.log(
    `  ${loaded.total} .json files: ${rows.length} live call records read, ${loaded.skipped.deleted} deletion tombstones skipped, ${loaded.skipped.malformed} unreadable`
  )
}

if (typeof one === 'string') {
  const r = rows.find((x) => x.id === one || x.id.startsWith(one))
  if (!r) {
    console.error(`no call matching "${one}"`)
    process.exit(1)
  }
  printOne(r)
} else {
  // The population, split by the branch. This is the line the founder asked
  // for: how many failing calls are "capture worked, fault downstream" versus
  // "the restart failed".
  const byVerdict = {}
  for (const r of rows) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1
  console.log('\nwhole store, by verdict:')
  for (const [v, n] of Object.entries(byVerdict).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${v}`)

  // BUG-D's own dataset rule, unchanged: >= 2 minutes with words expected.
  const eligible = rows.filter((r) => r.durationMin >= 2)
  const thin = eligible.filter((r) => r.wpm !== null && r.wpm < 5)
  console.log(`\ncalls >= 2 min: ${eligible.length};  of those UNDER 5 wpm (the BUG-D population): ${thin.length}`)
  if (thin.length) {
    const thinByVerdict = {}
    for (const r of thin) thinByVerdict[r.verdict] = (thinByVerdict[r.verdict] ?? 0) + 1
    console.log('\nTHE ANSWER — the thin calls, by branch:')
    for (const [v, n] of Object.entries(thinByVerdict).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${v}`)
  }

  const worst = Number(flag('--worst', has('--all') ? String(eligible.length) : '20'))
  console.log(`\nworst ${Math.min(worst, eligible.length)} by words/minute:`)
  for (const r of eligible.sort((a, b) => (a.wpm ?? 1e9) - (b.wpm ?? 1e9)).slice(0, worst)) printOne(r)
}

const jsonPath = flag('--json')
if (typeof jsonPath === 'string') {
  writeFileSync(resolve(jsonPath), JSON.stringify({ callsDir: CALLS_DIR, generated: 'see wrapper', rows }, null, 2), 'utf8')
  console.log(`\nwrote ${resolve(jsonPath)} (numbers and verdicts only — no transcript text)`)
}
