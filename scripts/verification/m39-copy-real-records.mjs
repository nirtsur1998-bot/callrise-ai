// M39 — copy the founder's REAL records into the sandbox profile, so a surface
// can be photographed saying something true about a real buyer.
//
// WHAT IT COPIES AND WHY THE LIST IS SHORT. Records only: calls, contacts,
// deals, tasks, prep briefs, deal stages. Nothing that carries a credential and
// nothing that can reach the outside world.
//
// EXPLICITLY NOT COPIED, each for a reason:
//   outlook/msal-cache.enc  — a live OAuth token for the founder's real
//     calendar. BUG-263 is LOGGED, NOT FIXED: the sandbox flag gates the cloud
//     backup and nothing else, and three fictional events reached that calendar
//     earlier in this milestone. The token does not travel; the destination
//     sandbox is verified to have no calendar connected before anything copies.
//   supabase-auth.json      — would sign the sandbox in as the founder. The
//     sandbox has its own test-user session already.
//   ai-keys/                — not needed for records already on disk.
//   events/                 — real meetings, real attendee emails, and the one
//     record type with a path OUT of the app. Not needed for a records shot.
//   telemetry-*             — a separate consent, and not mine to move.
//
// It is a COPY in both directions of that word: the founder's own files are
// only ever READ here, so nothing this does can damage them.
//
// usage: node scripts/verification/m39-copy-real-records.mjs <realProfile> <sandboxProfile>
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [REAL, SANDBOX] = process.argv.slice(2)
if (!REAL || !SANDBOX) {
  console.error('usage: m39-copy-real-records.mjs <realProfile> <sandboxProfile>')
  process.exit(1)
}
if (!/temp|tmp|sandbox/i.test(SANDBOX)) {
  console.error(`REFUSING: ${SANDBOX} is not a temp/sandbox path.`)
  process.exit(1)
}
if (/temp|tmp|sandbox/i.test(REAL)) {
  console.error(`REFUSING: ${REAL} looks like a sandbox, not the real profile — check the argument order.`)
  process.exit(1)
}

// --- the destination must have no way out before anything arrives -----------
const settingsPath = join(SANDBOX, 'app-settings.json')
if (!existsSync(settingsPath)) {
  console.error(`REFUSING: ${settingsPath} does not exist — that is not a prepared sandbox profile.`)
  process.exit(2)
}
const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
const CREDENTIALS = [
  ['outlook/msal-cache.enc', 'Outlook OAuth'],
  ['google', 'Google OAuth token'],
  ['ai-keys', 'AI provider keys']
]
const problems = []
if (settings.googleCalendarConnected) problems.push('googleCalendarConnected is true')
if (settings.outlookCalendarConnected) problems.push('outlookCalendarConnected is true')
for (const [rel, what] of CREDENTIALS) {
  if (existsSync(join(SANDBOX, rel))) problems.push(`${rel} exists (${what})`)
}
if (problems.length) {
  console.error('REFUSING: the destination sandbox can reach outside. Real records must not land there:')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(2)
}
console.log('destination checked: no calendar connected, no credential files present')

// --- copy ------------------------------------------------------------------
const DIRS = ['calls', 'contacts', 'deals', 'tasks', 'prep-briefs', 'objection-queue']
const FILES = ['deal-stages.json']
const manifest = { copiedAt: new Date().toISOString(), from: REAL, dirs: {}, files: [] }

for (const d of DIRS) {
  const src = join(REAL, d)
  if (!existsSync(src)) {
    console.log(`  ${d.padEnd(18)} — absent in the real profile, skipped`)
    continue
  }
  cpSync(src, join(SANDBOX, d), { recursive: true })
  const n = readdirSync(join(SANDBOX, d)).length
  manifest.dirs[d] = n
  console.log(`  ${d.padEnd(18)} → ${n} files`)
}
for (const f of FILES) {
  const src = join(REAL, f)
  if (!existsSync(src)) continue
  cpSync(src, join(SANDBOX, f))
  manifest.files.push(f)
  console.log(`  ${f.padEnd(18)} → copied`)
}

// A marker, so a later session knows this profile holds real data and can
// remove it without guessing which records were fictional.
writeFileSync(join(SANDBOX, 'M39-HOLDS-REAL-RECORDS.json'), JSON.stringify(manifest, null, 2))
console.log('\nmarker written: M39-HOLDS-REAL-RECORDS.json')

// --- prove the credentials did NOT travel ----------------------------------
const after = CREDENTIALS.filter(([rel]) => existsSync(join(SANDBOX, rel))).map(([rel]) => rel)
console.log(`credential files in the sandbox after the copy: ${after.length ? after.join(', ') : 'none'}`)
const s2 = JSON.parse(readFileSync(settingsPath, 'utf8'))
console.log(`calendar connected after the copy: google=${!!s2.googleCalendarConnected} outlook=${!!s2.outlookCalendarConnected}`)
if (after.length || s2.googleCalendarConnected || s2.outlookCalendarConnected) process.exit(3)
