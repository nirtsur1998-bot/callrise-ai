// M39 — screenshot a real buyer's dossier, painted in the running app.
//
// READ-ONLY on the founder's records; the injected node is removed in a
// finally and its absence asserted.
//
// usage: node scripts/verification/m39-dossier-shot.mjs <port> <shotPath> <profileDir> <contactName>
import { connect } from './cdp.mjs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const [, , portArg, SHOT, PROFILE, CONTACT] = process.argv
const PORT = Number(portArg || 9347)
if (!SHOT || !PROFILE || !CONTACT) {
  console.error('usage: m39-dossier-shot.mjs <port> <shotPath> <profileDir> <contactName>')
  process.exit(1)
}
const HOST_ID = 'm39-dossier-host'

const rendered = JSON.parse(
  execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['tsx', '--tsconfig', 'tsconfig.node.json', 'scripts/verification/m39-render-dossier.tsx', PROFILE, CONTACT],
    { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, shell: true }
  )
)
console.log(`${rendered.contact}: ${rendered.chars} chars, sections ${JSON.stringify(rendered.sections)}`)

const cdp = await connect(PORT)
try {
  const info = JSON.parse(
    String(
      await cdp.evaluate(`(() => {
        const ID = ${JSON.stringify(HOST_ID)}
        let host = document.getElementById(ID)
        if (!host) {
          host = document.createElement('div')
          host.id = ID
          host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;overflow:auto;padding:32px;background:var(--color-canvas,#0d0c0a)'
          document.body.appendChild(host)
        }
        host.innerHTML = ${JSON.stringify(rendered.html)}
        const pre = host.querySelector('pre')
        return JSON.stringify({ ok: !!pre, chars: pre ? pre.textContent.length : 0 })
      })()`)
    )
  )
  if (!info.ok) throw new Error('nothing rendered')
  console.log(`on screen: ${info.chars} characters`)
  await cdp.screenshot(SHOT)
  console.log(`shot: ${SHOT}`)
  console.log(`sha256: ${createHash('sha256').update(readFileSync(SHOT)).digest('hex').slice(0, 16)}`)
} finally {
  console.log(
    `injected node removed: ${String(
      await cdp.evaluate(`(() => {
        const el = document.getElementById(${JSON.stringify(HOST_ID)})
        if (el) el.remove()
        return String(document.getElementById(${JSON.stringify(HOST_ID)}) === null)
      })()`)
    )}`
  )
}
process.exit(0)
