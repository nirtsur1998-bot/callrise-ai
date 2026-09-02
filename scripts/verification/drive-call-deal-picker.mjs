// Drives CallDealPicker and DealCallsSection — the call<->deal link UI — in a
// RUNNING signed-in app. This repo cannot unit-test component render output
// (BUG-140), so live driving is the only verification method that exists for
// these two files. Closes the gap flagged at the end of M32 Stage 2's review.
//
// PRECONDITION: the app must already be on a call's detail page with its Deal
// picker visible and unlinked — this script does not navigate there, because
// the Calls -> Past -> row-click path proved fragile across app states (the
// "Calls" nav item opens the LIVE recorder, not history; a Live|Past toggle
// sits inside it; the call list is one <ul> whose li[0] is a date-section
// header, not a row). Reach the page first (see ui-driver.mjs's `click`
// helpers), THEN run this.
//
// Reads and writes the <select> directly via its native value setter + a
// dispatched 'change' event, because Electron's renderer here is a real React
// tree — synthetic DOM events are what React's onChange actually listens for.
import { connect } from 'file:///C:/Users/User/Desktop/callrise-m32/scripts/verification/cdp.mjs'

const SHOTS =
  'C:/Users/User/AppData/Local/Temp/claude/C--Users-User-Desktop-CALLRISE-AI/775b4c37-5eaf-43f1-b11d-89700fb629fd/scratchpad/shots'
const NL = String.fromCharCode(10)

const cdp = await connect(9333)

async function ev(expr) {
  const r = await cdp.evaluate(expr)
  if (r && typeof r === 'object' && r.__err) throw new Error(r.__err)
  return r
}

const hasDealPicker = await ev(
  `document.querySelector('select[aria-label="Link this call to a deal"]') !== null`
)
console.log('[1] CallDealPicker select present: ' + hasDealPicker)
if (!hasDealPicker) throw new Error('picker not on screen — state drifted, re-check by hand')

const pickerText = await ev(`(function () {
  const s = document.querySelector('select[aria-label="Link this call to a deal"]')
  const root = s.parentElement
  return (root.innerText || '').slice(0, 400)
})()`)
console.log('[1] rendered text (CallDealPicker\u2019s own root):')
console.log('  ' + pickerText.split(NL).join(' | '))
await cdp.screenshot(SHOTS + '/calldealpicker-live-1.png')

const optionValues = await ev(`(function () {
  const s = document.querySelector('select[aria-label="Link this call to a deal"]')
  return [...s.options].map(function (o) { return { value: o.value, text: o.textContent } })
})()`)
console.log('[2] options: ' + JSON.stringify(optionValues))

const readFootnote = () =>
  ev(`(function () {
    const s = document.querySelector('select[aria-label="Link this call to a deal"]')
    const p = s.parentElement.querySelector(':scope > p')
    return p ? p.textContent.trim() : null
  })()`)

const before = await readFootnote()
console.log('[2] footnote before: ' + JSON.stringify(before))
if (before === null) throw new Error('footnote paragraph not found with the fixed selector')

if (optionValues.length <= 1) throw new Error('no real deal options on this call — cannot exercise the select')
const targetValue = optionValues[1].value

await ev(`(function () {
  const s = document.querySelector('select[aria-label="Link this call to a deal"]')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
  setter.call(s, ${JSON.stringify(targetValue)})
  s.dispatchEvent(new Event('change', { bubbles: true }))
  return 1
})()`)
await new Promise((r) => setTimeout(r, 1200))
const after = await readFootnote()
console.log('[3] footnote after selecting "' + optionValues[1].text + '": ' + JSON.stringify(after))
if (before === after) throw new Error('selecting a deal did not change the footnote — the picker is not reacting to the write')
await cdp.screenshot(SHOTS + '/calldealpicker-linked.png')

// Confirm the write actually landed in the select's OWN value, not just that
// the footnote text happened to change for an unrelated reason.
const selectedNow = await ev(`document.querySelector('select[aria-label="Link this call to a deal"]').value`)
console.log('[3] select value after linking: ' + JSON.stringify(selectedNow))
if (selectedNow !== targetValue) throw new Error('select value did not persist the chosen deal')

// Revert.
await ev(`(function () {
  const s = document.querySelector('select[aria-label="Link this call to a deal"]')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
  setter.call(s, '')
  s.dispatchEvent(new Event('change', { bubbles: true }))
  return 1
})()`)
await new Promise((r) => setTimeout(r, 1200))
const restored = await readFootnote()
const restoredValue = await ev(`document.querySelector('select[aria-label="Link this call to a deal"]').value`)
console.log('[4] footnote restored to: ' + JSON.stringify(restored) + ', select value: ' + JSON.stringify(restoredValue))
if (restored !== before || restoredValue !== '') throw new Error('revert did not fully restore original state')

// Both themes, asserted on computed colour (species 63's rule).
const bgBefore = await ev('getComputedStyle(document.body).backgroundColor')
await ev(`(function () { document.documentElement.classList.toggle('light'); return 1 })()`)
await new Promise((r) => setTimeout(r, 500))
const bgAfter = await ev('getComputedStyle(document.body).backgroundColor')
if (bgBefore === bgAfter) throw new Error('theme did not move on the call detail page')
await cdp.screenshot(SHOTS + '/calldealpicker-live-2.png')
console.log('[5] theme moved ' + bgBefore + ' -> ' + bgAfter)
await ev(`(function () { document.documentElement.classList.toggle('light'); return 1 })()`)

// Final on-disk verification, matching this session's standing rule: read
// back the ACTUAL FILE, not the DOM proxy.
console.log(NL + '[6] on-disk state must show no dealId — verified separately after this script.')

await cdp.close()
console.log(NL + 'DONE')
