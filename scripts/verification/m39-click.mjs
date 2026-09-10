// Click ONE unambiguous control by its text, then report what changed.
//
// Every rule here exists because of a wrong reading on this project:
//   - nav/aside are excluded, because `body.includes(label)` reported
//     NAVIGATED six times from the Home page (the sidebar repeats every title);
//   - only real controls are considered, because a click once landed on a
//     wrapper div and "succeeded" while nothing happened;
//   - the innermost match wins, and MORE THAN ONE match REFUSES rather than
//     picking the first;
//   - the page text before and after is compared, so the answer is "the state
//     CHANGED", not "the label I wanted is present".
//
// usage: node scripts/verification/m39-click.mjs <port> <label> [waitMs]
import { connect } from './cdp.mjs'
const PORT = Number(process.argv[2] || 9347)
const LABEL = process.argv[3]
const WAIT = Number(process.argv[4] || 2000)
if (!LABEL) {
  console.error('usage: m39-click.mjs <port> <label> [waitMs]')
  process.exit(1)
}
const cdp = await connect(PORT)
const body = async () => String(await cdp.evaluate('document.body.innerText'))
const before = await body()
const result = String(
  await cdp.evaluate(`(() => {
    const want = ${JSON.stringify(LABEL)}
    const all = [...document.querySelectorAll('button,a,[role="button"],[role="link"],[role="tab"],li')]
    const els = all.filter((e) => !e.closest('nav,aside'))
    const exact = els.filter((e) => (e.textContent || '').trim() === want)
    let pool = exact.length ? exact : els.filter((e) => (e.textContent || '').trim().includes(want))
    pool = pool.filter((e) => !pool.some((o) => o !== e && e.contains(o)))
    if (!pool.length) return 'NOT FOUND'
    if (pool.length > 1) return 'AMBIGUOUS x' + pool.length + ' :: ' + pool.map((e) => (e.textContent||'').trim().slice(0,40)).join(' | ')
    const hit = pool[0]
    const r = hit.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return 'ZERO SIZE'
    hit.scrollIntoView({ block: 'center' })
    hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return 'clicked'
  })()`)
)
console.log(`click ${JSON.stringify(LABEL)}: ${result}`)
if (result !== 'clicked') process.exit(1)
await new Promise((r) => setTimeout(r, WAIT))
const after = await body()
console.log(`page CHANGED: ${before !== after}`)
console.log('--- now on screen ---')
console.log(after.slice(0, 900))
process.exit(0)
