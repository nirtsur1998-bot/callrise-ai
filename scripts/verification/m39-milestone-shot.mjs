// M39 — take the milestone shot: the app telling the founder something about a
// REAL buyer that it learned from a previous call.
//
// The app's own CallHistoryList (Contact detail → "Call history"), rendered
// from the founder's real records where they sit, injected into the running app
// and painted by its own compiled stylesheet.
//
// NOTHING IS COPIED AND NOTHING IS WRITTEN. The records are read in place; the
// only output is a PNG. The injected node is removed in a finally and its
// absence asserted, so the app is left exactly as it was found.
//
// usage: node scripts/verification/m39-milestone-shot.mjs <port> <shotPath> <profileDir> <contactName>
import { connect } from './cdp.mjs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.argv[2] || 9347)
const SHOT = process.argv[3]
const PROFILE = process.argv[4]
const CONTACT = process.argv[5]
if (!SHOT || !PROFILE || !CONTACT) {
  console.error('usage: m39-milestone-shot.mjs <port> <shotPath> <profileDir> <contactName>')
  process.exit(1)
}
const HOST_ID = 'm39-milestone-host'

const rendered = JSON.parse(
  execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    [
      'tsx',
      '--tsconfig',
      'tsconfig.web.json',
      'scripts/verification/m39-render-call-history.tsx',
      join(PROFILE, 'calls'),
      join(PROFILE, 'contacts'),
      join(PROFILE, 'tasks'),
      CONTACT
    ],
    { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, shell: true }
  )
)
console.log(`contact: ${rendered.contact} — ${rendered.calls} linked calls, ${rendered.withSummary} carrying a stored summary`)

const cdp = await connect(PORT)
console.log(`page: ${String(await cdp.evaluate('location.origin + location.pathname'))}`)

try {
  const info = JSON.parse(
    String(
      await cdp.evaluate(`(() => {
        const ID = ${JSON.stringify(HOST_ID)}
        let host = document.getElementById(ID)
        if (!host) {
          host = document.createElement('div')
          host.id = ID
          host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;overflow:auto;padding:28px 32px;background:var(--color-canvas,#0d0c0a)'
          document.body.appendChild(host)
        }
        host.innerHTML =
          '<h2 style="font:600 17px/1.3 system-ui;margin:0 0 4px;color:var(--color-ink)">' +
          ${JSON.stringify(`Call history — ${rendered.contact}`)} +
          '</h2>' +
          '<p style="font:400 12px/1.4 system-ui;margin:0 0 16px;color:var(--color-muted)">' +
          ${JSON.stringify(`${rendered.calls} calls. Everything below was learned from them.`)} +
          '</p>' +
          ${JSON.stringify(rendered.html)}
        const list = host.querySelector('ul')
        return JSON.stringify({
          cards: list ? list.children.length : 0,
          text: (host.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 700)
        })
      })()`)
    )
  )
  console.log(`cards rendered: ${info.cards}`)
  if (!info.cards) throw new Error('the component rendered no cards — nothing to photograph')
  console.log('--- what the app is showing ---')
  console.log(info.text)
  await cdp.screenshot(SHOT)
  console.log(`\nshot: ${SHOT}`)
  console.log(`sha256: ${createHash('sha256').update(readFileSync(SHOT)).digest('hex').slice(0, 16)}`)
} finally {
  const gone = String(
    await cdp.evaluate(`(() => {
      const el = document.getElementById(${JSON.stringify(HOST_ID)})
      if (el) el.remove()
      return String(document.getElementById(${JSON.stringify(HOST_ID)}) === null)
    })()`)
  )
  console.log(`injected node removed: ${gone}`)
}
process.exit(0)
