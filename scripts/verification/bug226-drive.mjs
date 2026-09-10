// BUG-226 — navigate the sandboxed app to Live and read the meeting line.
//
// Separate from bug226-in-app.mjs so "could not reach the screen" and "the
// match is wrong" stay separable findings.
//
// usage: node scripts/verification/bug226-drive.mjs [port]
import { connect } from './cdp.mjs'

const PORT = Number(process.argv[2] || 9342)
const cdp = await connect(PORT)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const clickByText = async (label) =>
  cdp.evaluate(`(() => {
    const want = ${JSON.stringify(label)}
    const els = [...document.querySelectorAll('button, a, [role="button"], [role="tab"], [role="link"]')]
    const hit = els.find((e) => (e.textContent || '').trim() === want)
      || els.find((e) => (e.getAttribute('aria-label') || '').trim() === want)
      || els.find((e) => (e.textContent || '').trim().includes(want))
    if (!hit) return 'NOT FOUND'
    hit.click()
    return 'clicked'
  })()`)

const body = async () => String(await cdp.evaluate('document.body.innerText'))

console.log(`[bug226] page: ${cdp.page.url}`)

// Onboarding stands between a fresh profile and the app.
if ((await body()).includes('Skip setup')) {
  console.log(`[bug226] skip setup: ${await clickByText('Skip setup')}`)
  await sleep(2500)
}

// RULE: the sidebar is never evidence. Assert on something that exists ONLY on
// the destination, not on the nav item being present.
for (const label of ['Live', 'Live call', 'Live Calls']) {
  const r = await clickByText(label)
  if (r === 'clicked') {
    console.log(`[bug226] clicked nav "${label}"`)
    break
  }
}
await sleep(3000)

const text = await body()
const PLANTED = ['ZZ-BUG226-ACME', 'ZZ-BUG226-GLOBEX', 'ZZ-BUG226-LINKED', 'ZZ-BUG226-UNLINKED']
const seen = PLANTED.filter((t) => text.includes(t))

console.log('')
console.log(`[bug226] url            ${cdp.page.url}`)
console.log(`[bug226] body length    ${text.length}`)
console.log(`[bug226] planted titles ON SCREEN: ${seen.length ? seen.join(', ') : '(none)'}`)
console.log('')
console.log('--- first 700 chars of what the rep sees ---')
console.log(text.slice(0, 700))
console.log('--- end ---')
console.log(JSON.stringify({ seen, url: cdp.page.url }))
process.exit(0)
