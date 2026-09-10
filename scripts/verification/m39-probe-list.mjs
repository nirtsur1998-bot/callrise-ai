// Diagnostic: what does the Past-calls list actually contain, and does the
// sidebar "Calls" button leave a detail page at all?
import { connect } from './cdp.mjs'

const cdp = await connect(Number(process.argv[2] || 9347))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const body = async () => String(await cdp.evaluate('document.body.innerText'))

console.log('--- where are we now ---')
console.log((await body()).slice(0, 200).replace(/\n+/g, ' / '))

const clickJs = (label) => `(() => {
  const want = ${JSON.stringify(label)}
  const els = [...document.querySelectorAll('button,a,[role="button"],[role="link"],[role="tab"],li')]
  const exact = els.filter((e) => (e.textContent || '').trim() === want)
  let pool = exact.length ? exact : els.filter((e) => (e.textContent || '').trim().includes(want))
  pool = pool.filter((e) => !pool.some((o) => o !== e && e.contains(o)))
  if (!pool.length) return 'NOT FOUND'
  const hit = pool[0]
  hit.scrollIntoView({ block: 'center' })
  hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
  return 'clicked(' + pool.length + ')'
})()`

console.log('\n--- click "Past Calls" (the back link on a detail page) ---')
console.log(String(await cdp.evaluate(clickJs('Past Calls'))))
await sleep(2200)
console.log((await body()).slice(0, 300).replace(/\n+/g, ' / '))

console.log('\n--- every ZZ-M39 string on the page now ---')
const found = await cdp.evaluate(`(() => {
  const t = document.body.innerText
  return JSON.stringify(t.split('\\n').filter((l) => l.includes('ZZ-M39')))
})()`)
console.log(String(found))

console.log('\n--- what the API says ---')
console.log(
  String(
    await cdp.evaluate(
      `(async () => JSON.stringify((await window.api.calls.list()).map((c) => c.title)))()`
    )
  )
)
process.exit(0)
