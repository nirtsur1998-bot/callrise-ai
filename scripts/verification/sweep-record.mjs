// THE RAMP NUMBER — read the BUG-215 quote sweep's record out of a profile.
//
// This is the one observation the M37 ramp criterion rests on
// (docs/M37-release-proposal.md, "What is actually watched"):
//
//   rescuedByFileCheck — calls the bulk listing believed were gone and the
//   filesystem check found alive. It should be 0. Anything above zero means
//   the calls directory read is unreliable on that machine, quotes were one
//   check away from being destroyed, and THE RAMP STOPS.
//
// It is not aggregate and not remote. Telemetry is off by default and never
// carried this record, so there is no channel that reports it — it has to be
// read off a machine, from that machine's own memory.db. That is the honest
// shape of the criterion and the reason this script exists.
//
// ── WHY A ZERO IS NOT AUTOMATICALLY GOOD NEWS ────────────────────────────────
//
// The sweep only ever looks at calls that (a) are quoted by a memory and
// (b) are not in the live call list. On a fresh install with no history there
// are none, so it records zero having examined nothing. That zero looks
// identical to "swept a real store and rescued nothing" and means the opposite
// of informative. This script therefore refuses to report a bare number: it
// says whether the population was non-empty, and calls a zero TRIVIAL when it
// was not.
//
// The same trap, stated once so it is not re-learned: a check that passes over
// an empty population is not evidence, it is the absence of evidence wearing a
// green tick.
//
// READ-ONLY. Opens with readonly:true and never writes.
//
//   usage: node sweep-record.mjs [path to userData profile]
//          (defaults to %APPDATA%/sales-os)
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

const profile = process.argv[2] || join(process.env.APPDATA || '', 'sales-os')
const dbPath = join(profile, 'memory.db')

console.log(`profile : ${profile}`)
if (!existsSync(dbPath)) {
  console.log('\nNO memory.db — Sales Brain has never been initialised on this profile.')
  console.log('Not a data point: the sweep cannot have run.')
  process.exit(3)
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true })
try {
  const hasMeta = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='memory_meta'")
    .get().n
  if (!hasMeta) {
    console.log('\nNO memory_meta table — this store predates migration 6.')
    console.log('Not a data point.')
    process.exit(3)
  }

  const row = db.prepare('SELECT value FROM memory_meta WHERE key = ?').get('bug215.quoteSweep')
  const memories = db.prepare('SELECT COUNT(*) AS n FROM memories').get().n
  console.log(`memories: ${memories}`)

  if (!row) {
    console.log('\nTHE SWEEP HAS NOT RUN on this profile.')
    console.log('It runs once, at startup, when Sales Brain is enabled. Either this install has')
    console.log('not launched a build containing it (1.11.0 is the first release that does), or')
    console.log('Sales Brain is switched off here.')
    process.exit(2)
  }

  let rec
  try {
    rec = JSON.parse(row.value)
  } catch {
    console.log('\nrecord present but unparseable:\n  ' + row.value)
    process.exit(1)
  }

  console.log('\nbug215.quoteSweep:')
  console.log('  ' + JSON.stringify(rec, null, 2).split('\n').join('\n  '))

  if (rec.status === 'skipped') {
    console.log(`\nSKIPPED — reason: ${rec.reason}`)
    console.log('No number. The sweep refused rather than guessing, which is the designed behaviour.')
    process.exit(2)
  }

  // The field is absent on any record written before BUG-236 (2026-09-08 18:37)
  // added the filesystem cross-check. Absent is NOT zero.
  if (!Object.prototype.hasOwnProperty.call(rec, 'rescuedByFileCheck')) {
    console.log('\nNO rescuedByFileCheck FIELD.')
    console.log('This record was written by a build predating BUG-236, which is what added the')
    console.log('filesystem cross-check. The sweep is one-shot, so this profile can never produce')
    console.log('the number: its single run was spent on the uncorrected code.')
    console.log('ABSENT IS NOT ZERO. Not a data point.')
    process.exit(2)
  }

  const n = rec.rescuedByFileCheck
  const swept = rec.callsSwept ?? 0
  const examined = swept + n // the candidate population the check actually judged

  console.log('')
  if (examined === 0) {
    console.log(`rescuedByFileCheck = ${n}, but the sweep EXAMINED NOTHING (callsSwept 0, rescued 0).`)
    console.log('TRIVIALLY ZERO — no orphaned quoted calls existed on this machine, so the guard was')
    console.log('never exercised. This is not evidence the ramp criterion is met. Not a data point.')
    process.exit(2)
  }

  console.log(`candidate calls judged : ${examined}  (${swept} swept, ${n} rescued)`)
  if (n === 0) {
    console.log(`\n>>> rescuedByFileCheck = 0, over a non-empty population of ${examined}.`)
    console.log('MEANINGFUL ZERO — the calls directory read was reliable on this machine.')
    console.log('This machine supports ramping.')
    process.exit(0)
  }

  console.log(`\n>>> rescuedByFileCheck = ${n}  *** STOP THE RAMP ***`)
  console.log(`${n} call(s) were about to have their quotes destroyed on a call that still exists.`)
  console.log('The calls directory read is unreliable on this machine. The same condition on a')
  console.log('build without this guard is the unrecoverable case.')
  process.exit(1)
} finally {
  db.close()
}
