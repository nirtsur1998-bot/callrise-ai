// BUG-258 — exercise a CLIENT-profile consumer, then read the bundle counters.
//
// The Memory Center headline proves promotion. It does NOT prove the promoted
// facts reach a feature: that needs a consumer to ASK for a client profile, and
// live cues never do — they ask for `rep` only, which is why a call cannot show
// this and why 222 is still unbuilt.
//
// The client-profile consumers today are the pre-call brief, coaching chat and
// Rise. The brief is the cheapest to drive: it takes a contactId directly.
//
// usage: node scripts/verification/bug258-brief-and-bundle.mjs <port> <sandbox>
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { connect } from './cdp.mjs'

const PORT = Number(process.argv[2] || 9350)
const SANDBOX = process.argv[3]
if (!SANDBOX) throw new Error('usage: <port> <sandbox>')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cdp = await connect(PORT)

// Pick a contact that actually HAS a promoted fact — driving the brief for a
// contact with nothing to inject would produce a zero and prove nothing, which
// is species 107's shape.
const Database = (await import('better-sqlite3')).default
const db = new Database(join(SANDBOX, 'memory.db'), { readonly: true })
const withActive = db
  .prepare("SELECT scope, COUNT(*) n FROM memories WHERE status='active' AND scope LIKE 'client:%' GROUP BY scope ORDER BY n DESC")
  .all()
db.close()

console.log(`[brief] contacts with a promoted fact: ${withActive.length}`)
if (withActive.length === 0) {
  console.log('[brief] nothing promoted — nothing to inject. Stopping rather than reporting a zero.')
  process.exit(1)
}
const contactId = String(withActive[0].scope).replace('client:', '')
console.log(`[brief] using contact ${contactId} (${withActive[0].n} promoted fact(s))`)

// The brief's own IPC, called directly — the point is whether the MAIN process
// injects a client profile, not whether a modal renders.
// `regenerate`, not `getForEvent`: the latter can serve a cached brief, and a
// cache hit injects nothing — the counter would read zero and the zero would
// mean "not asked", not "asked and empty". Species 107 again.
// FIRE, do not await inside the eval. A real brief is a real AI call and takes
// longer than CDP's 30s Runtime.evaluate timeout — awaiting it kills the drive
// with a timeout that reads like a failure of the thing being measured.
// The counter increments the moment the profile is ASKED for, which happens at
// prompt assembly, long before the model answers.
await cdp.evaluate(
  `(() => { window.__bug258 = 'pending'; window.api.prepBrief.regenerate({ eventId: 'zz-bug258', title: 'Verification', startIso: new Date().toISOString(), attendees: [], contactId: ${JSON.stringify(contactId)} }).then(r => { window.__bug258 = 'ok:' + JSON.stringify(r).slice(0, 120) }).catch(e => { window.__bug258 = 'ERR ' + e.message }); return 'fired' })()`
)
console.log('[brief] prepBrief.regenerate fired (not awaited)')

// Give prompt assembly time to run — that is where the injection happens.
await sleep(20_000)
console.log(`[brief] status: ${String(await cdp.evaluate('window.__bug258')).slice(0, 160)}`)

// THE COUNTERS. This is the measurement: did a client profile get injected, or
// was it asked for and found empty?
const bundle = await cdp.evaluate(
  `window.api.support.createBundle().then(r => JSON.stringify(r)).catch(e => 'ERR ' + e.message)`
)
const parsed = JSON.parse(String(bundle))
console.log(`[bundle] ${parsed.ok ? parsed.path : bundle}`)
if (!parsed.ok) process.exit(1)

const sweep = JSON.parse(readFileSync(join(parsed.path, 'sales-brain-sweep.json'), 'utf8'))
console.log('')
console.log('  PROFILE INJECTIONS (counts since this launch)')
console.log('  ' + '-'.repeat(64))
for (const [k, v] of Object.entries(sweep.profileInjections ?? {})) {
  console.log(`  ${k.padEnd(34)} ${v}`)
}
console.log('')
console.log('  MERGE JUDGE')
console.log('  ' + '-'.repeat(64))
const judge = sweep.mergeJudge ?? {}
if (Object.keys(judge).length === 0) console.log('  (the judge has not run this launch)')
for (const [k, v] of Object.entries(judge)) console.log(`  ${k.padEnd(34)} ${v}`)

console.log('')
console.log(`  bundle files: ${readdirSync(parsed.path).join(', ')}`)
console.log(`  path: ${parsed.path}`)
process.exit(0)
