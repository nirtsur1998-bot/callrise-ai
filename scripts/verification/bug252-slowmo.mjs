// BUG-252 — hold the window open long enough to PHOTOGRAPH it.
//
// The settled screenshots of the fixed and pre-fix builds are byte-identical,
// and that is the honest problem with screenshotting this defect: it lives for
// ~30 ms between the click and the conversation record arriving over IPC. A
// still of the settled page cannot show it, and offering one as proof would be
// offering the absence of evidence.
//
// So the window is widened, in the MAIN PROCESS, by a temporary delay in the
// `assistant:getConversation` handler — applied identically to the fixed build
// and the control, so the only variable between the two stills is the fix.
//
// AN EARLIER VERSION OF THIS SCRIPT PATCHED `window.api.assistant` FROM THE
// RENDERER AND REPORTED SUCCESS. contextBridge objects are FROZEN: the
// assignment silently did nothing. The check said "patched" because it
// compared the property against a `.bind()` copy — a value it could never
// equal, so the check could not fail. Both builds then photographed clean and
// the obvious reading was "the defect is not real". Verify a patch by its
// EFFECT (time the call), never by inspecting the thing you just assigned.
//
// usage: node scripts/verification/bug252-slowmo.mjs <port> <outDir> <label> <pid>
import { mkdirSync } from 'node:fs'
import { openApp } from './ui-driver.mjs'

const PORT = Number(process.argv[2] || 9555)
const OUT = process.argv[3]
const LABEL = process.argv[4] || 'run'
const PID = process.argv[5] ? Number(process.argv[5]) : undefined
if (!OUT) throw new Error('usage: bug252-slowmo.mjs <port> <outDir> <label> <pid>')
mkdirSync(OUT, { recursive: true })

const SCOPED = 'Northwind renewal'
const PLAIN = 'objection handling practice'
const CHIP = 'About Dana Whitfield'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const HEADER_JS = `(() => {
  const el = Array.from(document.querySelectorAll('div')).find((d) =>
    String(d.className || '').indexOf('border-b border-line-soft px-5 py-2') !== -1
  )
  return el ? String(el.innerText || '').split(String.fromCharCode(10)).join(' ') : ''
})()`

const app = await openApp(PORT, { expect: 'callrise-ai/out/renderer', expectPid: PID })

// PROVE THE WINDOW IS ACTUALLY WIDE, by timing the real call. Without this the
// whole run is unfalsifiable: a clean photograph would mean either "fixed" or
// "the delay never applied", and those look identical.
const elapsed = await app.evaluate(
  `(async () => { const t = Date.now(); await window.api.assistant.getConversation('x'); return Date.now() - t })()`,
  { awaitPromise: true }
)
console.log(`[slowmo] a real getConversation call took ${elapsed}ms`)
if (elapsed < 1500) {
  throw new Error(
    `the main-process delay is NOT in this build (call took ${elapsed}ms). ` +
      'Refusing to photograph: a clean frame would prove nothing.'
  )
}

await app.click({ text: 'Rise', exact: true })
await sleep(1500)
await app.click({ text: SCOPED, exact: false, selector: 'button, a, [role="button"]' })
await app.waitFor('A loaded', () => app.evaluate(HEADER_JS), (h) => h.includes(CHIP), {
  timeout: 20_000
})
console.log(`[slowmo] A open: ${JSON.stringify(await app.evaluate(HEADER_JS))}`)

await app.click({ text: PLAIN, exact: false, selector: 'button, a, [role="button"]' }, { settle: 0 })
await sleep(900)

const header = await app.evaluate(HEADER_JS)
await app.screenshot(`${OUT}/${LABEL}-slowmo-mid-switch.png`)

const chipOverB = header.includes(CHIP) && header.includes(PLAIN)
console.log('')
console.log(`HEADER 900ms into the switch: ${JSON.stringify(header)}`)
console.log(
  chipOverB
    ? `DEFECT VISIBLE — conversation B's title under a chip that says "${CHIP}".`
    : 'CLEAN — the chip is gone the moment the pane switches, with the window held open.'
)
await sleep(3000)
console.log(`settled header: ${JSON.stringify(await app.evaluate(HEADER_JS))}`)
await app.close()
process.exit(0)
