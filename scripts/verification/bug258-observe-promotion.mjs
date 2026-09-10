// BUG-258 — OBSERVE whether the 12 confident client facts actually promote.
//
// The thresholds are merged. Whether they fire on the founder's real data is an
// OBSERVATION nobody has made, and the entry says so. This makes it.
//
// Runs against a SANDBOX COPY of the real profile: same 73 memories, new code,
// their store untouched. That matters twice over — their app is a live writer on
// the real store, and a promotion is a WRITE to the Sales Brain.
//
// usage:
//   node scripts/verification/bug258-observe-promotion.mjs <port> <sandbox> [--shot name]
import { join } from 'node:path'
import { connect } from './cdp.mjs'

const PORT = Number(process.argv[2] || 9350)
const SANDBOX = process.argv[3]
if (!SANDBOX) throw new Error('usage: bug258-observe-promotion.mjs <port> <sandbox> [--shot name]')
const SHOT = process.argv.includes('--shot') ? process.argv[process.argv.indexOf('--shot') + 1] : null

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cdp = await connect(PORT)
const body = async () => String(await cdp.evaluate('document.body.innerText'))

const clickByText = async (label, exact = true) =>
  cdp.evaluate(`(() => {
    const want = ${JSON.stringify(label)}
    const els = [...document.querySelectorAll('button, a, [role="button"], [role="tab"], [role="link"], li, div[class*="cursor-pointer"]')]
    const hit = ${exact ? '' : '0 ||'} els.find((e) => (e.textContent || '').trim() === want)
      || els.find((e) => (e.getAttribute('aria-label') || '').trim() === want)
      || els.find((e) => (e.textContent || '').trim().startsWith(want))
    if (!hit) return 'NOT FOUND'
    hit.click()
    return 'clicked'
  })()`)

console.log(`[observe] page: ${cdp.page.url}`)

// Onboarding stands between a fresh profile and the app.
if ((await body()).includes('Skip setup')) {
  console.log(`[observe] skip setup: ${await clickByText('Skip setup')}`)
  await sleep(2500)
}

// Settings -> Sales Brain. The sidebar is never evidence: assert on something
// that exists ONLY on the destination.
for (const step of ['Settings', 'Sales Brain']) {
  const r = await clickByText(step)
  console.log(`[observe] click ${step}: ${r}`)
  await sleep(2000)
}

// The Memory Center lives behind its own control on the Sales Brain page.
for (const label of ['Memory Center', 'Open Memory Center', 'Browse memories', 'What it has learned']) {
  const r = await clickByText(label)
  if (r === 'clicked') {
    console.log(`[observe] opened via "${label}"`)
    await sleep(2500)
    break
  }
}

const text = await body()

// THE PRIMARY SIGNAL — the headline reads the memory list directly and needs no
// consumer to have fired, which is why it is the one to trust.
const headline = await cdp.evaluate(
  `(() => { const el = document.querySelector('[data-testid="memory-usability-headline"]'); return el ? el.textContent.trim() : null })()`
)
const detail = await cdp.evaluate(
  `(() => { const el = document.querySelector('[data-testid="memory-usability-detail"]'); return el ? el.textContent.trim() : null })()`
)

console.log('')
console.log('  MEMORY CENTER')
console.log('  ' + '-'.repeat(70))
console.log(`  headline: ${headline === null ? '(not rendered — is this the Memory Center?)' : headline}`)
console.log(`  detail:   ${detail === null ? '(none)' : detail}`)
console.log('')

// THE GROUND TRUTH, read from the same database the app is using, so a UI that
// renders the wrong number cannot be mistaken for a promotion that did not
// happen — or the reverse.
const Database = (await import('better-sqlite3')).default
const db = new Database(join(SANDBOX, 'memory.db'), { readonly: true })
const byStatus = db.prepare('SELECT status, COUNT(*) n FROM memories GROUP BY status').all()
const activeByScope = db
  .prepare("SELECT scope, COUNT(*) n FROM memories WHERE status='active' GROUP BY scope")
  .all()
const profiles = db.prepare('SELECT COUNT(*) n FROM compiled_profiles WHERE length(text) > 0').get().n
const totalProfiles = db.prepare('SELECT COUNT(*) n FROM compiled_profiles').get().n
console.log('  THE DATABASE (ground truth, same file the app has open)')
console.log('  ' + '-'.repeat(70))
console.log(`  by status:            ${JSON.stringify(byStatus)}`)
console.log(`  active by scope:      ${activeByScope.length ? JSON.stringify(activeByScope.map((r) => `${String(r.scope).startsWith('client:') ? 'client' : r.scope}:${r.n}`)) : '(none)'}`)
console.log(`  NON-EMPTY profiles:   ${profiles} of ${totalProfiles}`)
db.close()

if (SHOT) {
  const out = join('C:/Users/User/AppData/Local/Temp', `bug258-${SHOT}.png`)
  await cdp.screenshot(out)
  console.log('')
  console.log(`  screenshot: ${out}`)
}

console.log('')
console.log(`  (body length ${text.length} — a paint check, so an empty screen is not read as an empty brain)`)
process.exit(0)
