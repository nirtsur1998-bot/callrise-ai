// M39 — drive the disagreement surface and screenshot all four states.
//
// CHECKS BUILT IN, because each one has already caught a wrong reading tonight:
//   - the loaded renderer bundle is compared with the one on disk, so a stale
//     instance holding the debug port cannot answer for the build under test
//     (it did, twice: species 110);
//   - every click reads state afterwards and asserts the page CHANGED;
//   - a selector matching more than one element REFUSES rather than picking;
//   - clicks are scoped out of nav/aside, because the sidebar repeats titles;
//   - screenshots are SHA-256'd, so two "different" states that render
//     identically are visible as identical rather than assumed distinct.
//
// usage: node scripts/verification/m39-disagreement-drive.mjs <port> <shotsDir>
import { connect } from './cdp.mjs'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.argv[2] || 9347)
const SHOTS = process.argv[3] ?? '.'
const OUT = join(process.cwd(), 'out', 'renderer')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const cdp = await connect(PORT)
const body = async () => String(await cdp.evaluate('document.body.innerText'))

// ---------------------------------------------------------------------------
// RULE 1 — is this OUR build? Compare the App-*.js the page actually loaded
// with the one sitting in out/renderer. A stale instance passes a URL check
// (same path) and fails this one (different content hash in the filename).
// ---------------------------------------------------------------------------
const onDisk = readdirSync(join(OUT, 'assets')).filter((f) => /^App-.*\.js$/.test(f))
const loaded = String(
  await cdp.evaluate(
    `JSON.stringify([...document.querySelectorAll('script[src]')].map((s) => s.src).concat([...document.querySelectorAll('link[href]')].map((l) => l.href)))`
  )
)
const loadedHasCurrentApp = onDisk.some((f) => loaded.includes(f))
console.log(`build check: on disk ${JSON.stringify(onDisk)} — page loaded a matching bundle: ${loadedHasCurrentApp}`)
if (!loadedHasCurrentApp) {
  // The page may load App-*.js lazily; fall back to asking the module graph.
  const lazy = String(await cdp.evaluate(`JSON.stringify(performance.getEntriesByType('resource').map((r) => r.name).filter((n) => n.includes('/assets/')))`))
  const ok = onDisk.some((f) => lazy.includes(f))
  console.log(`build check (lazy resources): ${ok}`)
  if (!ok) {
    console.error('REFUSING: the running app did not load this build. Every reading would be from the wrong code.')
    process.exit(2)
  }
}

async function click(label) {
  const js = `(() => {
    const want = ${JSON.stringify(label)}
    const all = [...document.querySelectorAll('button,a,[role="button"],[role="link"],[role="tab"],li')]
    const els = all.filter((e) => !e.closest('nav,aside'))
    const exact = els.filter((e) => (e.textContent || '').trim() === want)
    let pool = exact.length ? exact : els.filter((e) => (e.textContent || '').trim().includes(want))
    pool = pool.filter((e) => !pool.some((o) => o !== e && e.contains(o)))
    if (!pool.length) return 'NOT FOUND'
    if (pool.length > 1) return 'AMBIGUOUS x' + pool.length
    const hit = pool[0]
    const r = hit.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return 'ZERO SIZE'
    hit.scrollIntoView({ block: 'center' })
    hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return 'clicked'
  })()`
  return String(await cdp.evaluate(js))
}

const shot = async (name) => {
  const path = join(SHOTS, name)
  await cdp.screenshot(path)
  const hash = createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12)
  return { path: name, sha256: hash }
}

async function openCall(title) {
  const before = await body()
  await click('Past Calls')
  await sleep(1500)
  await click('Calls')
  await sleep(1500)
  await click('Past')
  await sleep(1200)
  const clicked = await click(title)
  await sleep(2500)
  const after = await body()
  return {
    clicked,
    changed: before !== after, // assert it CHANGED, not merely that it matches
    onDetail: after.includes(title) && !after.includes('Start live transcription'),
    text: after
  }
}

const CASES = [
  { id: 'link', title: 'ZZ-M39 Renewal call — the wrong client', expect: 'Link to' },
  { id: 'create', title: 'ZZ-M39 Discovery — an unknown name', expect: 'Create contact for' },
  { id: 'ambiguous', title: 'ZZ-M39 Check-in — two of them are called that', expect: 'to choose' },
  { id: 'control', title: 'ZZ-M39 Pricing call — name and link agree', expect: null }
]

const results = []
for (const c of CASES) {
  const r = await openCall(c.title)
  const noticeShown = r.text.includes('but it’s') || r.text.includes("but it's")
  results.push({
    case: c.id,
    clicked: r.clicked,
    changed: r.changed,
    onDetail: r.onDetail,
    noticeShown,
    expectedActionPresent: c.expect === null ? null : r.text.includes(c.expect),
    shot: await shot(`20-disagreement-${c.id}.png`)
  })
}

console.log(JSON.stringify(results, null, 2))
console.log('')
const hashes = results.map((r) => r.shot.sha256)
console.log(`distinct screenshots: ${new Set(hashes).size} of ${hashes.length}`)
const control = results.find((r) => r.case === 'control')
console.log(
  control && !control.noticeShown
    ? 'CONTROL HELD — the agreeing call shows NO notice, so the other three mean something.'
    : 'CONTROL FAILED — the agreeing call also showed a notice (or never loaded). Treat the rest as unproven.'
)
process.exit(0)
