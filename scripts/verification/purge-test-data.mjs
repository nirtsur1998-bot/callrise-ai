#!/usr/bin/env node
// purge-test-data.mjs — remove the calls and memories left behind by driving
// the app against the REAL profile, without touching anything older.
//
// Driving the app for verification is the only way some bugs get found (see
// the BUG-163/164/165/166/167 entries in the vault), but it is not free: one
// overnight session left 48 synthetic calls and 24 auto-learned memories on
// the founder's profile. They are not inert. They sat at the top of Coaching
// as "your most recent performance", moved the trend line, and inflated
// "you've logged 237 calls ... you're picking up the pace lately".
//
//   node scripts/verification/purge-test-data.mjs --since 2026-09-01T18:00:00.000Z
//   node scripts/verification/purge-test-data.mjs --since <ts> --apply
//
// DRY RUN unless --apply. Prints everything it would touch first.
//
// Conservative on purpose:
//   - Calls are TOMBSTONED (`deleted: true`) the way the app itself deletes
//     them, not unlinked, so nothing referencing them breaks.
//   - Memories are matched on created_at ONLY. Anything written or confirmed
//     before the cutoff is untouched.
//   - There is no default cutoff. Refusing beats guessing which data is
//     disposable.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = 'C:/Users/User/AppData/Roaming/sales-os'
const sinceIdx = process.argv.indexOf('--since')
const CUTOFF = sinceIdx !== -1 ? process.argv[sinceIdx + 1] : null
if (!CUTOFF || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T/.test(CUTOFF)) {
  console.error('Refusing: pass --since <ISO timestamp>, e.g. --since 2026-09-01T18:00:00.000Z')
  console.error('There is no default. Guessing which of a persons data is disposable is not a')
  console.error('decision this script gets to make.')
  process.exit(2)
}
const APPLY = process.argv.includes('--apply')

const callsDir = join(ROOT, 'calls')
const calls = readdirSync(callsDir).filter((f) => f.endsWith('.json'))
const doomed = []
for (const f of calls) {
  const p = join(callsDir, f)
  let d
  try { d = JSON.parse(readFileSync(p, 'utf8')) } catch { continue }
  if (d.deleted === true) continue
  if ((d.createdAt || '') >= CUTOFF) doomed.push({ p, id: d.id, at: d.createdAt, dur: d.durationMs })
}
console.log('calls created since ' + CUTOFF + ': ' + doomed.length)
for (const c of doomed.slice(0, 5)) console.log('   ' + c.at + '  ' + Math.round((c.dur || 0) / 1000) + 's')
if (doomed.length > 5) console.log('   … and ' + (doomed.length - 5) + ' more')

const mems = execFileSync('python', ['-c',
  "import sqlite3,json,sys;sys.stdout.reconfigure(encoding='utf-8');" +
  "c=sqlite3.connect(r'" + ROOT + "/memory.db');" +
  "print(json.dumps([{'id':r[0],'s':r[1]} for r in c.execute(\"select id,statement from memories where created_at >= '" + CUTOFF + "'\")]))"
], { encoding: 'utf8' }).trim()
const memRows = JSON.parse(mems)
console.log('')
console.log('memories created since cutoff: ' + memRows.length)
for (const m of memRows.slice(0, 5)) console.log('   ' + m.s.slice(0, 88))
if (memRows.length > 5) console.log('   … and ' + (memRows.length - 5) + ' more')

if (!APPLY) {
  console.log('')
  console.log('DRY RUN — nothing changed. Re-run with --apply to remove them.')
  process.exit(0)
}

for (const c of doomed) {
  const d = JSON.parse(readFileSync(c.p, 'utf8'))
  d.deleted = true
  d.updatedAt = new Date().toISOString()
  writeFileSync(c.p, JSON.stringify(d))
}
execFileSync('python', ['-c',
  "import sqlite3;c=sqlite3.connect(r'" + ROOT + "/memory.db');" +
  "c.execute(\"delete from memories where created_at >= '" + CUTOFF + "'\");c.commit()"
])
console.log('')
console.log('DONE — ' + doomed.length + ' calls tombstoned, ' + memRows.length + ' memories removed.')
console.log('Restart the app to see the change.')

