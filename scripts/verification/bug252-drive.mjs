// BUG-252 — drive the conversation switch in the running app.
//
// The defect lives in a WINDOW, not in a settled state: between clicking
// conversation B and B's record arriving over IPC, the pane still showed
// conversation A's scope chip — "About <client A>", with a tooltip asserting
// "This conversation is only about <client A>". Locally that window is short.
// So this does not screenshot the settled page and call it proof: it installs
// a MutationObserver BEFORE the click and records every frame of the PANE
// HEADER, which is the one element that carries the chip and the active
// conversation's title together.
//
// READ THE HEADER, NOT THE PAGE. The first version of this script compared
// `document.body.innerText`, and reported a failure that was its own: BOTH
// conversation titles are in the rail at all times, so "the page contains B's
// title" is true even while A is open. It scored 2 bad frames on a build where
// the defect cannot occur. A discriminator that is always true measures
// nothing — and it fails in the direction that looks like diligence.
//
// Read-only with respect to the founder's profile: this drives a SANDBOX
// profile holding two INVENTED conversations, so no real client name can reach
// a screenshot. The app refuses cloud sync in that mode (BUG-186), and says so
// on stdout at launch.
//
// usage: node scripts/verification/bug252-drive.mjs <port> <outDir> <label> <pid>
import { mkdirSync, writeFileSync } from 'node:fs'
import { openApp } from './ui-driver.mjs'

const PORT = Number(process.argv[2] || 9555)
const OUT = process.argv[3]
const LABEL = process.argv[4] || 'run'
// RULE 1b — the PID that must own the port. Without it a leftover instance
// from an earlier run answers and the whole drive measures the wrong build.
// That happened on the first attempt at this very drive.
const PID = process.argv[5] ? Number(process.argv[5]) : undefined
if (!OUT) throw new Error('usage: bug252-drive.mjs <port> <outDir> <label> <pid>')
mkdirSync(OUT, { recursive: true })

const SCOPED = 'Northwind renewal'
const PLAIN = 'objection handling practice'
const CHIP = 'About Dana Whitfield'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The pane header: chip + active title, and nothing from the rail. */
const HEADER_JS = `(() => {
  const el = Array.from(document.querySelectorAll('div')).find((d) =>
    String(d.className || '').indexOf('border-b border-line-soft px-5 py-2') !== -1
  )
  return el ? String(el.innerText || '').split(String.fromCharCode(10)).join(' ') : ''
})()`

const app = await openApp(PORT, { expect: 'callrise-ai/out/renderer', expectPid: PID })

await app.click({ text: 'Rise', exact: true })
await sleep(1200)

const railed = await app.text()
if (!railed.includes(SCOPED) || !railed.includes(PLAIN)) {
  throw new Error(
    `the seeded conversations are not on screen — is this the sandbox profile? ` +
      `saw: ${railed.slice(0, 200)}`
  )
}
console.log('[drive] sandbox confirmed: both seeded conversations are in the rail')
await app.screenshot(`${OUT}/${LABEL}-1-rail.png`)

// --- open the SCOPED conversation ------------------------------------------
await app.click({ text: SCOPED, exact: false, selector: 'button, a, [role="button"]' })
await app.waitFor('scope chip appears in the header', () => app.evaluate(HEADER_JS), (h) =>
  h.includes(CHIP)
)
const headerA = await app.evaluate(HEADER_JS)
console.log(`[drive] conversation A open. HEADER: ${JSON.stringify(headerA)}`)
await app.screenshot(`${OUT}/${LABEL}-2-scoped.png`)

// --- arm the recorder, THEN switch -----------------------------------------
await app.evaluate(`(() => {
  window.__b252 = { frames: [], t0: Date.now() }
  const header = () => {
    const el = Array.from(document.querySelectorAll('div')).find((d) =>
      String(d.className || '').indexOf('border-b border-line-soft px-5 py-2') !== -1
    )
    return el ? String(el.innerText || '').split(String.fromCharCode(10)).join(' ') : ''
  }
  const snap = () => {
    const h = header()
    window.__b252.frames.push({
      t: Date.now() - window.__b252.t0,
      chip: h.indexOf(${JSON.stringify(CHIP)}) !== -1,
      showsA: h.indexOf(${JSON.stringify(SCOPED)}) !== -1,
      showsB: h.indexOf(${JSON.stringify(PLAIN)}) !== -1,
      header: h.slice(0, 120)
    })
  }
  snap()
  window.__b252.obs = new MutationObserver(snap)
  window.__b252.obs.observe(document.body, { subtree: true, childList: true, characterData: true })
  window.__b252.tick = setInterval(snap, 4)
  return true
})()`)

await app.click({ text: PLAIN, exact: false, selector: 'button, a, [role="button"]' }, { settle: 2000 })

const frames = await app.evaluate(`(() => {
  clearInterval(window.__b252.tick)
  window.__b252.obs.disconnect()
  return window.__b252.frames
})()`)

await app.screenshot(`${OUT}/${LABEL}-3-after-switch.png`)
const headerB = await app.evaluate(HEADER_JS)

// --- verdict ----------------------------------------------------------------
// THE defect frame: the header is showing conversation B and still carrying
// conversation A's scope chip.
const bad = frames.filter((f) => f.chip && f.showsB)
// Sanity: the recorder must have seen BOTH states, or it was not watching the
// thing that changed.
const sawA = frames.some((f) => f.showsA)
const sawB = frames.some((f) => f.showsB)

writeFileSync(`${OUT}/${LABEL}-frames.json`, JSON.stringify({ headerA, headerB, frames }, null, 1))

console.log('')
console.log(`frames recorded across the switch : ${frames.length}`)
console.log(`  header showed conversation A     : ${sawA}`)
console.log(`  header showed conversation B     : ${sawB}`)
console.log(`  frames with B AND A's scope chip : ${bad.length}`)
if (bad.length) {
  console.log(`    first +${bad[0].t}ms, last +${bad[bad.length - 1].t}ms`)
  console.log(`    e.g. ${JSON.stringify(bad[0].header)}`)
}
console.log(`settled header: ${JSON.stringify(headerB)}`)
console.log('')

if (!sawA || !sawB) {
  console.log('INCONCLUSIVE — the recorder never saw both conversations in the header.')
  await app.close()
  process.exit(2)
}
const pass = bad.length === 0 && !headerB.includes(CHIP)
console.log(
  pass
    ? "PASS — conversation B was never shown wearing conversation A's scope."
    : `FAIL — B wore A's scope for ${bad.length} recorded frame(s).`
)
await app.close()
process.exit(pass ? 0 : 1)
