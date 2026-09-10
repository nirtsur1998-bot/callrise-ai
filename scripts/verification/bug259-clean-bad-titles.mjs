// BUG-259 — reset the call titles that are actually the model's reasoning.
//
// Three calls on the founder's machine carry a title that is the model
// narrating the prompt back at itself ("We need to produce a short specific
// title 5-8 words, company/person name plus topic"). Searched the WHOLE
// profile 2026-09-10: those strings appear in exactly three files, the call
// records themselves — not in the Sales Brain (0 of 73 memories), not in a
// summary, CRM note, journal or index. Nothing downstream consumed them.
//
// WHAT THIS DOES: puts each one back to the app's own date placeholder,
// "Call · Sep 9, 2026, 11:03 AM". That is not a cosmetic choice — it is the
// exact string `isDefaultCallTitle()` recognises, so these three calls rejoin
// the normal pipeline and the app's own "Name your untitled calls" backfill
// will re-title them properly once a build with the BUG-259 fix is installed.
// Deleting the title outright would leave them in a state the app never
// creates.
//
// IT REFUSES TO RUN WHILE THE APP IS OPEN. The app is the one writer on this
// store; a second writer racing it is the shape BUG-185 and BUG-187 came from.
//
// Dry run by default. Pass --write to actually change anything.
//
// usage:
//   node scripts/verification/bug259-clean-bad-titles.mjs
//   node scripts/verification/bug259-clean-bad-titles.mjs --write
import { readFileSync, writeFileSync, readdirSync, copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

const WRITE = process.argv.includes('--write')
const PROFILE = join(process.env.APPDATA ?? '', 'sales-os')
const CALLS = join(PROFILE, 'calls')
const BACKUP = join(PROFILE, `bad-title-backup-${new Date().toISOString().slice(0, 10)}`)

// Copied from calls-fs.ts — the prefix is exported there precisely so the two
// cannot drift, and this script is outside that module's reach.
const DEFAULT_TITLE_PREFIX = 'Call · '
const defaultTitleFor = (iso) =>
  DEFAULT_TITLE_PREFIX +
  new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })

/** The shipped validator's rule, so this script and the app agree on what a
 *  bad title is rather than this having its own opinion. */
const REASONING_OPENER =
  /^(here'?s?\b|okay\b|ok\b|so,?\s|let'?s\b|let me\b|first,?\s|we (need|should|must|can|have)\b|i (need|should|will|'ll|am going)\b|looking at\b|the (user|transcript|call) (is|says|has|mentions)\b|alright\b|now,?\s|step \d|thinking\b|analysis\b|reasoning\b)/i
const TASK_WORDS = /(5-8 words|short,? specific title|company\/person|generic filler)/i
const isReasoning = (t) =>
  Boolean(t) && !t.startsWith(DEFAULT_TITLE_PREFIX) && (REASONING_OPENER.test(t) || TASK_WORDS.test(t) || /[:;]$/.test(t))

// --- REFUSE TO RACE THE APP ------------------------------------------------
let running = ''
try {
  running = execSync(
    'powershell -NoProfile -Command "Get-Process -Name electron,CallRiseAI -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count"',
    { encoding: 'utf8' }
  ).trim()
} catch {
  running = '?'
}
if (WRITE && running !== '0' && running !== '') {
  console.error(`REFUSING: ${running} Electron process(es) are running.`)
  console.error('The app is the one writer on this store. Close CallRise AI completely,')
  console.error('then run this again — a second writer racing it is how BUG-185/187 happened.')
  process.exit(2)
}

// --- FIND ------------------------------------------------------------------
const found = []
for (const f of readdirSync(CALLS).filter((x) => x.endsWith('.json'))) {
  const p = join(CALLS, f)
  let call
  try {
    call = JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    continue
  }
  const t = String(call.title ?? '').trim()
  if (!isReasoning(t)) continue
  const when = call.startedAt ?? call.createdAt ?? call.endedAt
  if (!when) {
    console.log(`  SKIP ${f} — no timestamp, cannot build the app's own default title`)
    continue
  }
  found.push({ path: p, file: f, id: call.id, was: t, willBe: defaultTitleFor(when) })
}

console.log(`${found.length} call(s) carry a reasoning preamble as their title:`)
for (const r of found) {
  console.log('')
  console.log(`  ${r.id}`)
  console.log(`    was:      ${r.was.slice(0, 76)}`)
  console.log(`    reset to: ${r.willBe}`)
}
console.log('')

if (!found.length) {
  console.log('Nothing to do.')
  process.exit(0)
}
if (!WRITE) {
  console.log('DRY RUN — nothing was written. Re-run with --write (app closed) to apply.')
  process.exit(0)
}

// --- BACK UP, THEN WRITE, THEN VERIFY --------------------------------------
if (!existsSync(BACKUP)) mkdirSync(BACKUP, { recursive: true })
for (const r of found) copyFileSync(r.path, join(BACKUP, r.file))
console.log(`backed up ${found.length} file(s) to ${BACKUP}`)

let changed = 0
for (const r of found) {
  const call = JSON.parse(readFileSync(r.path, 'utf8'))
  call.title = r.willBe
  writeFileSync(r.path, `${JSON.stringify(call, null, 2)}\n`, 'utf8')
  changed++
}

// Re-read from disk: "I wrote it" is not verification.
let verified = 0
for (const r of found) {
  const call = JSON.parse(readFileSync(r.path, 'utf8'))
  if (call.title === r.willBe) verified++
  else console.error(`  MISMATCH on ${r.id}: ${JSON.stringify(call.title)}`)
}
console.log(`wrote ${changed}, verified ${verified} by re-reading from disk`)
console.log('')
console.log('These three are now "untitled" as far as the app is concerned, so the')
console.log('"Name your untitled calls" backfill will re-title them once a build with')
console.log('the BUG-259 fix is installed.')
process.exit(verified === found.length ? 0 : 1)
