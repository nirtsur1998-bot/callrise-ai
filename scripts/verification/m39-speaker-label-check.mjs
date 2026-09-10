// M39 — answer the open question: IS a resolved self-intro name shown as the
// speaker's label on the transcript?
//
// An earlier drive read "no" and that reading was suspect, because the same
// drive found the rep's line but not the buyer's — which is what an off-screen
// row looks like, not what a missing feature looks like. So this scrolls the
// buyer's turn into view and reads the label element itself rather than
// searching the whole body for a string.
//
// usage: node scripts/verification/m39-speaker-label-check.mjs <port> <shotsDir>
import { connect } from './cdp.mjs'

const cdp = await connect(Number(process.argv[2] || 9347))
const SHOTS = process.argv[3] ?? '.'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Scroll the buyer's line into view, then report the labels actually rendered.
const result = await cdp.evaluate(`(() => {
  const nodes = [...document.querySelectorAll('div,span,p')]
  const turn = nodes.find((e) => (e.textContent || '').trim() === 'No problem at all, happy to talk.')
  if (!turn) return JSON.stringify({ error: 'buyer turn not in the DOM at all' })
  turn.scrollIntoView({ block: 'center' })
  return JSON.stringify({ scrolled: true })
})()`)
console.log('scroll:', String(result))
await sleep(1200)

const labels = await cdp.evaluate(`(() => {
  const nodes = [...document.querySelectorAll('div,span,p')]
  const turn = nodes.find((e) => (e.textContent || '').trim() === 'No problem at all, happy to talk.')
  if (!turn) return JSON.stringify({ error: 'buyer turn missing' })
  // Walk up to the turn's container and read every short text node above it —
  // the label sits in a sibling header row.
  const box = turn.closest('div')?.parentElement?.parentElement
  const texts = box ? [...box.querySelectorAll('span,div')].map((e) => (e.textContent || '').trim()).filter((t) => t && t.length < 40) : []
  return JSON.stringify({ nearby: [...new Set(texts)].slice(0, 12) })
})()`)
console.log('labels near the buyer turn:', String(labels))

const body = String(await cdp.evaluate('document.body.innerText'))
console.log('')
console.log('body contains the buyer turn  :', body.includes('No problem at all'))
console.log('body contains the RESOLVED name:', body.includes('ZZ-M39 Sarah Chen'))
console.log('body contains the fallback "Buyer":', /\bBuyer\b/.test(body))
await cdp.screenshot(`${SHOTS}/15-speaker-label.png`)
process.exit(0)
