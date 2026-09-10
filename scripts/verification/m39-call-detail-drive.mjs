// M39 — drive the call-detail screen and compare the placeholder call with its
// control, on the same build, in the same run.
//
// The control is the whole point. "The detail page does not say 'someone'" is
// equally consistent with the guard working and with the page never rendering a
// speaker name at all — so a second call carrying a REAL (fictional) name is
// opened in the same pass, and a run where the control fails to show its name
// proves nothing about the first.
//
// usage: node scripts/verification/m39-call-detail-drive.mjs <port> <shotsDir>
import { connect } from './cdp.mjs'

const PORT = Number(process.argv[2] || 9347)
const SHOTS = process.argv[3] ?? '.'
const cdp = await connect(PORT)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const body = async () => String(await cdp.evaluate('document.body.innerText'))

/**
 * Clicks only real controls, refuses a wrapper, and refuses ambiguity.
 *
 * Scoped OUT of nav/aside on purpose: the sidebar's RECENT list repeats the
 * open call's title verbatim, so an unscoped search for that title finds two
 * elements and cannot tell the list row from the shortcut. That is not a
 * hypothetical — it is what made this drive report NOT FOUND for a call the
 * API could see.
 */
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

/** The line under the call title: date, duration, speaker count. */
async function metaLine() {
  const js = `(() => {
    const h = [...document.querySelectorAll('h1,h2')].find((e) => (e.textContent || '').includes('ZZ-M39'))
    if (!h) return 'NO HEADING'
    const p = h.parentElement
    return p ? p.innerText.split('\\n').slice(0, 4).join(' | ') : 'NO PARENT'
  })()`
  return String(await cdp.evaluate(js))
}

async function openPastCall(title) {
  // Always from a known page, never from wherever the last step left us.
  //
  // "Past Calls" is the back link that exists ONLY on a call-detail page, and
  // it is the only way back to the list: the sidebar's "Calls" button does not
  // leave a detail page, which cost this drive one wrong reading before it was
  // checked instead of assumed.
  await click('Past Calls')
  await sleep(1800)
  await click('Calls')
  await sleep(1500)
  await click('Past')
  await sleep(1500)
  const r = await click(title)
  await sleep(2500)
  const t = await body()
  return { clicked: r, onDetail: t.includes(title) && !t.includes('Start live transcription'), text: t }
}

const out = {}

{
  const { clicked, onDetail, text } = await openPastCall('ZZ-M39 call with a PLACEHOLDER identity')
  out.placeholder = {
    clicked,
    onDetail,
    saysSomeone: /\bsomeone\b/i.test(text),
    meta: await metaLine()
  }
  await cdp.screenshot(`${SHOTS}/12-placeholder-detail.png`)
}

{
  const { clicked, onDetail, text } = await openPastCall('ZZ-M39 call with a REAL identity')
  out.control = {
    clicked,
    onDetail,
    showsRealName: text.includes('ZZ-M39 Sarah Chen'),
    meta: await metaLine()
  }
  await cdp.screenshot(`${SHOTS}/13-control-detail.png`)
}

console.log(JSON.stringify(out, null, 2))
console.log('')
console.log(
  out.control.showsRealName
    ? 'CONTROL HELD — the page does render a speaker name, so the placeholder\'s absence means something.'
    : 'CONTROL FAILED — the page did not render the real name either. This run proves NOTHING about the placeholder.'
)
process.exit(0)
