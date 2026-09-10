// BUG-258 — get to the Memory Center and read the headline.
//
// Split from the observation so "could not reach the screen" and "the number is
// wrong" stay separable findings.
//
// usage: node scripts/verification/bug258-nav.mjs <port> [--shot name]
import { join } from 'node:path'
import { connect } from './cdp.mjs'

const PORT = Number(process.argv[2] || 9350)
const SHOT = process.argv.includes('--shot') ? process.argv[process.argv.indexOf('--shot') + 1] : null
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cdp = await connect(PORT)
const body = async () => String(await cdp.evaluate('document.body.innerText'))

const click = async (label) =>
  cdp.evaluate(`(() => {
    const want = ${JSON.stringify(label)}
    const all = [...document.querySelectorAll('button, a, [role="button"], [role="tab"], [role="link"]')]
    const exact = all.find((e) => (e.textContent || '').trim() === want)
      || all.find((e) => (e.getAttribute('aria-label') || '').trim() === want)
    const loose = all.find((e) => (e.textContent || '').trim().includes(want))
    const hit = exact || loose
    if (!hit) return 'NOT FOUND'
    hit.scrollIntoView({ block: 'center' })
    hit.click()
    return 'clicked'
  })()`)

console.log(`[nav] ${cdp.page.url}`)

// 1. Onboarding.
if ((await body()).includes('Skip setup')) {
  console.log(`[nav] skip setup: ${await click('Skip setup')}`)
  await sleep(2000)
}

// 2. THE TELEMETRY CONSENT PROMPT. Answer it the privacy-preserving way and
//    move on. This is a sandbox, so the choice reaches nothing real — but a
//    drive that clicks "yes" on a consent dialog to get past it is a drive that
//    would do the same on a real profile, and this project has a standing rule
//    about exactly that.
if ((await body()).includes('Help find crashes?')) {
  console.log(`[nav] telemetry consent -> declining: ${await click('No thanks')}`)
  await sleep(1500)
}

// 3. Settings.
console.log(`[nav] Settings: ${await click('Settings')}`)
await sleep(2500)

// 4. Whatever the Sales Brain section is actually called on this build. Printed
//    rather than assumed — the first attempt guessed "Sales Brain" and the
//    click reported NOT FOUND from a page that had not navigated at all.
const afterSettings = await body()
console.log(`[nav] settings page, ${afterSettings.length} chars`)
// The REAL labels on this build, read off the page rather than guessed. The
// first attempt used 'Sales Brain' and 'Memory Center' — neither exists as a
// control, and the click reported NOT FOUND from a page that had navigated
// perfectly well. Read the labels, then click them.
const CANDIDATES = ['What CallRise remembers', 'Review what it remembers']
for (const c of CANDIDATES) {
  if (afterSettings.includes(c)) console.log(`[nav]   sees: "${c}"`)
}

for (const label of ['What CallRise remembers', 'Review what it remembers']) {
  const r = await click(label)
  console.log(`[nav] click "${label}": ${r}`)
  if (r === 'clicked') {
    await sleep(2500)
    const el = await cdp.evaluate(
      `(() => { const e = document.querySelector('[data-testid="memory-usability-headline"]'); return e ? e.textContent.trim() : null })()`
    )
    if (el) {
      console.log('')
      console.log(`  HEADLINE: ${el}`)
      const d = await cdp.evaluate(
        `(() => { const e = document.querySelector('[data-testid="memory-usability-detail"]'); return e ? e.textContent.trim() : null })()`
      )
      console.log(`  DETAIL:   ${d}`)
      break
    }
  }
}

const finalText = await body()
if (!finalText.includes('Trusted fact') && !finalText.includes('Still a hunch')) {
  console.log('')
  console.log('[nav] NOT on the Memory Center yet. What is on screen:')
  console.log(finalText.slice(0, 900))
}

if (SHOT) {
  const out = join('C:/Users/User/AppData/Local/Temp', `bug258-${SHOT}.png`)
  await cdp.screenshot(out)
  console.log(`[nav] screenshot: ${out}`)
}
process.exit(0)
