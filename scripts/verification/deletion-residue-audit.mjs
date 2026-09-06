// M37 — DELETION RESIDUE AUDIT. Does "deleted" still mean deleted?
//
// WHY THIS EXISTS. BUG-139 (shipped as v1.5.1, 2026-08-29) was this exact
// shape: `deleteCall` states that a deleted call must not retain buyer words,
// and it was false one folder over. It was found while auditing 201 leftover
// `.conflict` files — 196 were pure duplicates, 5 had diverged, and FOUR OF
// THOSE FIVE were records the user had deleted, with the `.conflict` still
// holding the full transcript. Widening the audit found call journals
// surviving the call record entirely, and an orphaned atomic-write staging
// file holding a complete copy of a live call.
//
// That fix shipped. Nobody has checked since whether it HOLDS, and the
// founder's calls directory currently contains 184 `.conflict` files. A fix
// that was verified once, on the day it shipped, against a store that has
// turned over since, is a fix nobody has evidence for today. This is the
// cheapest possible way to have that evidence, and it can be re-run any time.
//
// PRIVACY: read-only, everywhere. It counts words and reports file names and
// ids. It NEVER prints a transcript word, a title, or a contact. The whole
// point is to find retained words without repeating them.
//
//   node scripts/verification/deletion-residue-audit.mjs
//   node scripts/verification/deletion-residue-audit.mjs --profile <dir>
//
// Exit 1 if any residue is found, so it can be run as a check rather than read.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const flagIdx = argv.indexOf('--profile')
const PROFILE = resolve(
  (flagIdx >= 0 ? argv[flagIdx + 1] : null) ??
    join(process.env.APPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming'), 'sales-os')
)

/** Suffixes that are NOT the record itself but can hold a copy of it. The
 *  list is the point: BUG-139's lesson was that an audit which names only the
 *  hiding places you already know about cannot find the one nobody thought of.
 *  So the scan enumerates every non-.json file in the directory and classifies
 *  it, rather than looking for these specific names. */
const KNOWN_SIDECARS = ['.conflict', '.tmp', '.bak', '.redacted', '.old', '.orig']

function wordsIn(obj) {
  let n = 0
  const walk = (v) => {
    if (typeof v === 'string') n += (v.match(/\S+/g) ?? []).length
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(obj)
  return n
}

/** Words that are somebody's SPEECH, as opposed to metadata. A tombstone
 *  legitimately keeps ids, timestamps and a title; it must not keep turns. */
function speechWords(call) {
  let n = 0
  for (const s of call?.segments ?? []) {
    if (s?.kind === 'gap') continue
    n += (String(s?.text ?? '').match(/\S+/g) ?? []).length
  }
  for (const k of ['summary', 'coaching']) {
    const v = call?.[k]
    if (v) n += wordsIn(v)
  }
  return n
}

const dirOf = (name) => join(PROFILE, name)

/** Which fields a sidecar differs from its live record in — the whole point
 *  being that "differs only in updatedAt" means it is a duplicate, not a
 *  conflict. Returns null when either side cannot be read. */
function readRecord(dir, sidecarFile) {
  const base = sidecarFile.replace(/\.(conflict|tmp|bak|redacted|old|orig)$/i, '') + '.json'
  try {
    const a = JSON.parse(readFileSync(join(dir, sidecarFile), 'utf8'))
    const b = JSON.parse(readFileSync(join(dir, base), 'utf8'))
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    const diff = [...keys].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort()
    return { sig: diff.length === 0 ? '(identical)' : diff.join('+') }
  } catch {
    return null
  }
}

function auditDir(name) {
  const dir = join(PROFILE, name)
  let files
  try {
    files = readdirSync(dir)
  } catch {
    return { name, missing: true, findings: [], sidecars: 0, records: 0 }
  }
  const json = new Map()
  const others = []
  for (const f of files) {
    if (f.endsWith('.json')) json.set(f.slice(0, -5), f)
    else others.push(f)
  }

  const findings = []
  for (const f of others) {
    const base = f.replace(/\.(conflict|tmp|bak|redacted|old|orig)$/i, '')
    const full = join(dir, f)
    let parsed = null
    try {
      parsed = JSON.parse(readFileSync(full, 'utf8'))
    } catch {
      /* not JSON — reported below as unparsed, never opened further */
    }
    const size = statSync(full).size
    const suffix = KNOWN_SIDECARS.find((s) => f.toLowerCase().endsWith(s)) ?? '(unrecognised suffix)'

    // Is the record this sidecar belongs to deleted, or gone entirely?
    let recordState = 'no matching record'
    if (json.has(base)) {
      try {
        const rec = JSON.parse(readFileSync(join(dir, json.get(base)), 'utf8'))
        recordState = rec?.deleted === true ? 'DELETED (tombstone)' : 'live'
      } catch {
        recordState = 'matching record unreadable'
      }
    }

    const speech = parsed ? speechWords(parsed) : null
    const total = parsed ? wordsIn(parsed) : null
    const residue = recordState !== 'live' && (speech ?? 0) > 0

    findings.push({ file: f, suffix, size, recordState, speechWords: speech, totalWords: total, residue, parsed: parsed !== null })
  }
  return { name, missing: false, findings, sidecars: others.length, records: json.size }
}

// The directories that hold anything a call's words could land in. Enumerated
// from the profile rather than assumed, so a directory added later shows up.
let topLevel = []
try {
  topLevel = readdirSync(PROFILE, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
} catch {
  console.error(`cannot read profile: ${PROFILE}`)
  process.exit(2)
}
const SKIP = new Set([
  'Cache',
  'Code Cache',
  'Crashpad',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Dictionaries',
  'GPUCache',
  'Local Storage',
  'Network',
  'Session Storage',
  'Shared Dictionary',
  'blob_storage',
  'logs',
  'memory-model-cache'
])
const dirs = topLevel.filter((d) => !SKIP.has(d))

console.log(`DELETION RESIDUE AUDIT — ${PROFILE}`)
console.log(`  scanning ${dirs.length} data directories: ${dirs.join(', ')}`)
console.log(`  (skipped ${topLevel.length - dirs.length} browser/cache directories)\n`)

let residueTotal = 0
let sidecarTotal = 0
for (const d of dirs) {
  const r = auditDir(d)
  if (r.missing || (r.sidecars === 0 && r.records === 0)) continue
  sidecarTotal += r.sidecars
  const residue = r.findings.filter((f) => f.residue)
  residueTotal += residue.length

  const bySuffix = {}
  for (const f of r.findings) bySuffix[f.suffix] = (bySuffix[f.suffix] ?? 0) + 1
  console.log(`${d}/  ${r.records} records, ${r.sidecars} non-record files ${r.sidecars ? JSON.stringify(bySuffix) : ''}`)

  if (r.sidecars > 0) {
    const byState = {}
    for (const f of r.findings) byState[f.recordState] = (byState[f.recordState] ?? 0) + 1
    console.log(`    the records they belong to: ${JSON.stringify(byState)}`)
    const withSpeech = r.findings.filter((f) => (f.speechWords ?? 0) > 0)
    console.log(`    non-record files holding SPEECH: ${withSpeech.length}`)

    // BUG-138's question, asked again: of the conflicts sitting beside a LIVE
    // record, how many are real disagreements about content and how many are
    // duplicates? A conflict file that differs only in a timestamp is not a
    // conflict — it is a second copy of a transcript that nobody asked for.
    const live = r.findings.filter((f) => f.recordState === 'live' && f.parsed)
    if (live.length > 0) {
      const bySig = {}
      let bytes = 0
      for (const f of live) {
        const rec = readRecord(dirOf(d), f.file)
        if (!rec) continue
        bytes += f.size
        bySig[rec.sig] = (bySig[rec.sig] ?? 0) + 1
      }
      console.log(`    beside a LIVE record: ${live.length}, holding ${(bytes / 1048576).toFixed(2)} MB`)
      console.log(`    fields in which they differ from the live record: ${JSON.stringify(bySig)}`)
      const cosmetic = Object.entries(bySig).filter(([k]) => k === 'updatedAt' || k === '(identical)')
      const cosmeticN = cosmetic.reduce((n, [, v]) => n + v, 0)
      if (cosmeticN > 0) {
        console.log(
          `    -> ${cosmeticN} of ${live.length} are NOT real conflicts (identical, or differing only in updatedAt).` +
            ' Each is a full duplicate copy of the record. See BUG-185.'
        )
      }
    }
  }

  for (const f of residue) {
    console.log(
      `    !! RESIDUE  ${f.file}  (${f.size} bytes) — record is ${f.recordState}, ` +
        `sidecar holds ${f.speechWords} words of speech`
    )
  }
  console.log('')
}

console.log('=== verdict ===')
console.log(`non-record files scanned: ${sidecarTotal}`)
if (residueTotal === 0) {
  console.log('CLEAN — no deleted or orphaned record has a sidecar still holding speech.')
  process.exit(0)
}
console.log(`!! ${residueTotal} file(s) hold speech belonging to a record that is deleted or gone.`)
console.log('   This is BUG-139\'s shape. The words are still on disk after the user deleted the call.')
process.exit(1)
