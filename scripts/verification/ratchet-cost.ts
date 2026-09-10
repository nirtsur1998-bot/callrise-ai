// BUG-185 — what the ratchet actually COSTS, per cycle and per year.
//
// The founder's point: "196 records rewritten every ten minutes, forever, on
// every machine. That's the bandwidth and the write amplification, not just the
// clutter." This measures it instead of asserting it.
//
// Three separate costs, and they are not the same number:
//   1. LOCAL DISK   — every record file rewritten by the pull's restamp.
//   2. UPLOAD       — the payload the push sends, built by the app's own
//                     projection, so transcript-carrying scopes are counted
//                     the way the app really sends them.
//   3. DOWNLOAD     — the pull's response, which carries the whole payload back
//                     because the rows genuinely changed on the server.
//
// Read-only. Nothing is written anywhere.
//
// usage: tsx scripts/verification/ratchet-cost.ts <userDataDir> [syncMinutes]
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { callBackupPayload, callFullBackupPayload, type Call } from '../../src/main/calls-fs'

const PROFILE = process.argv[2]
const SYNC_MINUTES = Number(process.argv[3] || 10)
if (!PROFILE) throw new Error('usage: ratchet-cost.ts <userDataDir> [syncMinutes]')

const CYCLES_PER_DAY = (24 * 60) / SYNC_MINUTES
const fmt = (b: number): string =>
  b >= 1 << 30
    ? `${(b / (1 << 30)).toFixed(2)} GB`
    : b >= 1 << 20
      ? `${(b / (1 << 20)).toFixed(1)} MB`
      : `${(b / 1024).toFixed(0)} KB`

const dir = join(PROFILE, 'calls')
const files = readdirSync(dir).filter((f) => f.endsWith('.json'))

let onDisk = 0
let live = 0
let tombstones = 0
let payloadOff = 0
let payloadOn = 0

for (const f of files) {
  const path = join(dir, f)
  onDisk += statSync(path).size
  let c: Call
  try {
    c = JSON.parse(readFileSync(path, 'utf8')) as Call
  } catch {
    continue
  }
  if (c.deleted === true) tombstones++
  else live++
  payloadOff += Buffer.byteLength(JSON.stringify(callBackupPayload(c)), 'utf8')
  payloadOn += Buffer.byteLength(JSON.stringify(callFullBackupPayload(c)), 'utf8')
}

const records = live + tombstones

console.log(`calls store on ${PROFILE}`)
console.log(`  records          : ${records}  (${live} live, ${tombstones} tombstones)`)
console.log(`  on disk          : ${fmt(onDisk)}`)
console.log('')
console.log(`EVERY record is restamped every cycle, so one cycle moves ALL of it.`)
console.log(`Sync interval assumed: ${SYNC_MINUTES} min  (${CYCLES_PER_DAY} cycles/day)`)
console.log('')

const rows: Array<[string, number]> = [
  ['local disk rewritten', onDisk],
  ['uploaded, transcripts OFF', payloadOff],
  ['uploaded, transcripts ON', payloadOn],
  ['downloaded (pull returns the payload)', payloadOff]
]

console.log(`  ${'cost'.padEnd(38)} ${'per cycle'.padStart(10)} ${'per day'.padStart(10)} ${'per year'.padStart(10)}`)
for (const [label, perCycle] of rows) {
  console.log(
    `  ${label.padEnd(38)} ${fmt(perCycle).padStart(10)} ` +
      `${fmt(perCycle * CYCLES_PER_DAY).padStart(10)} ${fmt(perCycle * CYCLES_PER_DAY * 365).padStart(10)}`
  )
}

console.log('')
console.log('All of it is for records nobody edited. The only field that differs')
console.log('between one cycle and the next is `updatedAt`.')
