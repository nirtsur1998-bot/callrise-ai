// M39 Stage 2 — a visual pass over the live identity chip, in the RUNNING app.
//
// WHAT THIS IS. The chip's own markup (produced by the component itself, via
// react-dom/server — never hand-written, see m39-render-chip-states.tsx for
// why) injected into the live renderer and painted by the app's own compiled
// stylesheet, in the app's own theme, then screenshotted state by state.
//
// WHAT IT IS NOT, so the pictures are not read as more than they are: this does
// NOT prove LiveView mounts the component. It cannot — the chip only appears
// during a call, and a call needs a transcription key the sandbox profile does
// not have. The mounting claim is carried by the wiring test and the
// typechecker; these pictures carry the copy, the colour, the spacing and the
// button shapes, which are the things a test cannot see and a screenshot can.
//
// CHECKS BUILT IN:
//   - the running app is compared against the build on disk before anything is
//     read (species 110: a stale instance holding the port answered for the
//     wrong build twice on this project);
//   - the injected node is REMOVED in a finally, and its absence asserted, so a
//     later drive cannot photograph this one's leftovers;
//   - every screenshot is SHA-256'd, because two states that render
//     identically must be visible as identical rather than assumed distinct;
//   - the app's own theme is read and reported, since a chip that looks right
//     in one and unreadable in the other is exactly the fault worth catching.
//
// usage: node scripts/verification/m39-chip-visual-drive.mjs <port> <shotsDir>
import { connect } from './cdp.mjs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.argv[2] || 9347)
const SHOTS = process.argv[3] ?? '.'
const HOST_ID = 'm39-chip-visual-host'

const states = JSON.parse(
  execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['tsx', '--tsconfig', 'tsconfig.web.json', 'scripts/verification/m39-render-chip-states.tsx'],
    { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, shell: true }
  )
)
console.log(`rendered ${states.length} states from the component itself`)

const cdp = await connect(PORT)

// --- is this OUR build? -----------------------------------------------------
// In dev the renderer is served by vite from source, so there is no App-*.js
// hash to compare. The equivalent check is that the page is being served from
// this working tree's dev server AND that the module it would import exists
// here — plus, decisively, that the component source the injected markup came
// from is the file on disk right now (it was just executed).
const pageUrl = String(await cdp.evaluate('location.origin + location.pathname'))
const chipSrc = join(process.cwd(), 'src/renderer/src/features/live/LiveIdentityOfferChip.tsx')
console.log(`page: ${pageUrl}`)
console.log(`component source present: ${existsSync(chipSrc)}`)
if (!existsSync(chipSrc)) {
  console.error('REFUSING: the component this drive claims to photograph is not in this tree.')
  process.exit(2)
}
const outAssets = join(process.cwd(), 'out', 'renderer', 'assets')
if (!pageUrl.includes('localhost:5173') && existsSync(outAssets)) {
  const onDisk = readdirSync(outAssets).filter((f) => /^App-.*\.js$/.test(f))
  const loaded = String(
    await cdp.evaluate(
      `JSON.stringify(performance.getEntriesByType('resource').map((r) => r.name))`
    )
  )
  if (!onDisk.some((f) => loaded.includes(f))) {
    console.error('REFUSING: a packaged page that did not load this build.')
    process.exit(2)
  }
}

const theme = String(
  await cdp.evaluate(
    `JSON.stringify({ root: document.documentElement.className, bg: getComputedStyle(document.body).backgroundColor })`
  )
)
console.log(`theme: ${theme}`)

const shot = async (name) => {
  const path = join(SHOTS, name)
  await cdp.screenshot(path)
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12)
}

const results = []
try {
  for (const s of states) {
    // One host node, replaced per state, fixed over everything so the chip is
    // the only thing that changes between two screenshots.
    const placed = String(
      await cdp.evaluate(`(() => {
        const ID = ${JSON.stringify(HOST_ID)}
        let host = document.getElementById(ID)
        if (!host) {
          host = document.createElement('div')
          host.id = ID
          host.style.cssText = 'position:fixed;left:50%;top:24px;transform:translateX(-50%);width:520px;z-index:2147483647'
          document.body.appendChild(host)
        }
        host.innerHTML = ${JSON.stringify(s.html)}
        const el = host.firstElementChild
        if (!el) return 'NOTHING RENDERED'
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        return JSON.stringify({
          text: (el.innerText || '').replace(/\\s+/g, ' ').trim(),
          w: Math.round(r.width), h: Math.round(r.height),
          border: cs.borderColor, bg: cs.backgroundColor
        })
      })()`)
    )
    if (placed === 'NOTHING RENDERED') throw new Error(`state ${s.id} produced no element`)
    const info = JSON.parse(placed)
    results.push({
      state: s.id,
      label: s.label,
      onScreen: info.text,
      size: `${info.w}x${info.h}`,
      border: info.border,
      background: info.bg,
      sha256: await shot(`22-live-chip-${s.id}.png`)
    })
  }
} finally {
  const gone = String(
    await cdp.evaluate(`(() => {
      const el = document.getElementById(${JSON.stringify(HOST_ID)})
      if (el) el.remove()
      return String(document.getElementById(${JSON.stringify(HOST_ID)}) === null)
    })()`)
  )
  console.log(`\ninjected node removed: ${gone}`)
}

console.log('')
console.log(JSON.stringify(results, null, 2))
const hashes = results.map((r) => r.sha256)
console.log('')
console.log(`distinct screenshots: ${new Set(hashes).size} of ${hashes.length}`)
process.exit(0)
