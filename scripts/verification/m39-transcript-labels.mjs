// M39 — the UI-level control for the non-name guard.
//
// The call-detail page shows a speaker's resolved name as the LABEL on their
// transcript turns, and the transcript section is collapsed by default — which
// is why an earlier run read "the real name is not on the page" and would have
// been reported as a failure of the guard rather than of the drive.
//
// Opens the transcript on whichever call is currently shown and reports the
// speaker labels it finds.
//
// usage: node scripts/verification/m39-transcript-labels.mjs <port> <shotsDir> <tag>
import { connect } from './cdp.mjs'

const cdp = await connect(Number(process.argv[2] || 9347))
const SHOTS = process.argv[3] ?? '.'
const TAG = process.argv[4] ?? 'x'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const clicked = String(
  await cdp.evaluate(`(() => {
    const els = [...document.querySelectorAll('button,[role="button"],summary')]
      .filter((e) => !e.closest('nav,aside'))
      .filter((e) => (e.textContent || '').trim().startsWith('Transcript'))
    if (!els.length) return 'NOT FOUND'
    const hit = els[0]
    hit.scrollIntoView({ block: 'center' })
    hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return 'clicked'
  })()`)
)
console.log('expand Transcript ->', clicked)
await sleep(1800)

const text = String(await cdp.evaluate('document.body.innerText'))
const title = String(
  await cdp.evaluate(
    `(() => { const h = [...document.querySelectorAll('h1,h2')].find((e) => (e.textContent||'').includes('ZZ-M39')); return h ? h.textContent.trim() : 'NO TITLE' })()`
  )
)

console.log('call on screen        :', title)
console.log('transcript text found :', text.includes('Thanks for taking the time'))
console.log('shows "ZZ-M39 Sarah Chen":', text.includes('ZZ-M39 Sarah Chen'))
console.log('shows "someone"          :', /\bsomeone\b/i.test(text))
await cdp.screenshot(`${SHOTS}/14-transcript-${TAG}.png`)
process.exit(0)
