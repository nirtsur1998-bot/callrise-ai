// BUG-248 proof — drive the REAL app against a COPY of the real profile and
// check that the bounded record stores still return every record.
//
// The claim under test is not "it compiles". It is: after replacing an
// unbounded `Promise.all` with a concurrency-limited map in eight stores, every
// record still reaches the user. A bounded map with an off-by-one or a lost
// worker drops records SILENTLY — the list is just shorter, and nothing errors.
//
// RUN IT LIKE THIS (never against the real profile):
//   1. copy the profile:  <temp>/Roaming/sales-os  (skip Cache/Code Cache)
//   2. npm run build
//   3. CALLRISE_USER_DATA_DIR=<that copy> npx electron out/main/index.js //        --remote-debugging-port=9444
//      The app prints "SANDBOX profile ... cloud backup push and pull REFUSED",
//      which is BUG-186's guard and the reason a copy is safe to sign into.
//   4. node scripts/verification/bug248-drive.mjs <shots-dir>
//
// RED-CHECKED 2026-09-09, and the first red-check FAILED TO GO RED: breaking
// the map so it left `out[last]` undefined changed nothing, because every
// caller filters with `!== null` and `undefined !== null` is true. Only a break
// that genuinely SHORTENS the array (`out.slice(0, -1)`) turned six of the
// seven stores red. A proof whose break is invisible to the code under test is
// not a proof.
import { connect } from './cdp.mjs'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

const PORT = 9444
const PROFILE = 'C:/Users/User/AppData/Local/Temp/bug248-env-a/Roaming/sales-os'
const SHOTS = process.argv[2] ?? '.'

async function truth(dir) {
  let files = []
  try {
    files = (await fs.readdir(join(PROFILE, dir))).filter((f) => f.endsWith('.json'))
  } catch {
    return { live: 0, total: 0 }
  }
  let live = 0
  for (const f of files) {
    try {
      const r = JSON.parse(await fs.readFile(join(PROFILE, dir, f), 'utf8'))
      if (r && !r.deleted) live++
    } catch {
      /* unreadable files are skipped by the stores too */
    }
  }
  return { live, total: files.length }
}

const cdp = await connect(PORT)
console.log('connected to the main window\n')

// What the RENDERER can see through the app's own preload bridge. This is the
// product path: preload -> IPC -> main -> the bounded store functions.
const api = await cdp.evaluate(`Object.keys(window.api ?? {}).length`)
console.log(`window.api surfaces: ${api}`)

const rows = []
for (const [label, dir, call] of [
  ['calls', 'calls', 'window.api.calls.list()'],
  ['contacts', 'contacts', 'window.api.contacts.list()'],
  ['deals', 'deals', 'window.api.deals.list()'],
  ['tasks', 'tasks', 'window.api.tasks.list()'],
  ['events', 'events', 'window.api.events.list()'],
  ['knowledge', 'knowledge', 'window.api.knowledge.list()'],
  ['objectionQueue', 'objection-queue', 'window.api.objectionQueue.list()']
]) {
  const t = await truth(dir)
  let got
  try {
    got = await cdp.evaluate(
      `(async () => { const r = await ${call}; return Array.isArray(r) ? r.length : (r && r.length) ?? -1 })()`
    )
  } catch (e) {
    got = 'ERR: ' + String(e.message).slice(0, 70)
  }
  rows.push({ label, onDisk: t.live, files: t.total, throughApp: got })
}

console.log('\n=== RECORDS: disk vs what the app returns through the bounded stores ===')
for (const r of rows) {
  const ok = r.onDisk === r.throughApp ? 'MATCH' : '*** MISMATCH ***'
  console.log(
    `  ${r.label.padEnd(10)} files ${String(r.files).padStart(4)}  live-on-disk ${String(r.onDisk).padStart(4)}  through-app ${String(r.throughApp).padStart(4)}   ${ok}`
  )
}

await cdp.screenshot(join(SHOTS, 'bug248-01-app.png'))
console.log('\nscreenshot -> bug248-01-app.png')
process.exit(0)
