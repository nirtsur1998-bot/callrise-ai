// What is on screen right now? Text + a screenshot, for orienting a drive.
// usage: node scripts/verification/m39-screen-state.mjs <port> [shotPath]
import { connect } from './cdp.mjs'
const PORT = Number(process.argv[2] || 9347)
const SHOT = process.argv[3]
const cdp = await connect(PORT)
const text = String(await cdp.evaluate('document.body.innerText'))
console.log('--- innerText (first 1200 chars) ---')
console.log(text.slice(0, 1200))
console.log('--- controls ---')
console.log(
  String(
    await cdp.evaluate(
      `JSON.stringify([...document.querySelectorAll('button,a,[role="button"],[role="tab"]')].map((e) => (e.textContent||'').trim()).filter(Boolean).slice(0, 60))`
    )
  )
)
if (SHOT) {
  await cdp.screenshot(SHOT)
  console.log(`shot: ${SHOT}`)
}
process.exit(0)
