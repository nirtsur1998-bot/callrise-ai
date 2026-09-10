// M39 — does the correction BUTTON actually correct the link?
//
// A notice that renders is half a feature. This clicks "Link to …", then reads
// the call record back off disk and asserts the contactId CHANGED to the
// offered contact and the notice is gone.
//
// Snapshot first, restore in a finally, read back — the sandbox is fictional,
// but a drive that writes without a restore leaves the next run measuring the
// previous one's side effects.
//
// usage: node scripts/verification/m39-disagreement-action.mjs <port> <sandbox> <shotsDir>
import { connect } from './cdp.mjs'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.argv[2] || 9347)
const SANDBOX = process.argv[3]
const SHOTS = process.argv[4] ?? '.'
const CALL_ID = 'zz-m39-disagree-link'
const recordPath = join(SANDBOX, 'calls', `${CALL_ID}.json`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cdp = await connect(PORT)
const body = async () => String(await cdp.evaluate('document.body.innerText'))

const snapshot = await fs.readFile(recordPath, 'utf8')
const before = JSON.parse(snapshot)

/** Clicks one unambiguous control outside nav/aside. */
async function click(label) {
  return String(
    await cdp.evaluate(`(() => {
      const want = ${JSON.stringify(label)}
      const all = [...document.querySelectorAll('button,a,[role="button"],[role="link"],[role="tab"],li')]
      const els = all.filter((e) => !e.closest('nav,aside'))
      const exact = els.filter((e) => (e.textContent || '').trim() === want)
      let pool = exact.length ? exact : els.filter((e) => (e.textContent || '').trim().includes(want))
      pool = pool.filter((e) => !pool.some((o) => o !== e && e.contains(o)))
      if (!pool.length) return 'NOT FOUND'
      if (pool.length > 1) return 'AMBIGUOUS x' + pool.length
      pool[0].scrollIntoView({ block: 'center' })
      pool[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
      return 'clicked'
    })()`)
  )
}

try {
  // Navigate to the call under test rather than trusting wherever the last
  // drive left the app — the first run of this script reported NOT FOUND
  // because it was sitting on the control call, which correctly has no button.
  await click('Past Calls')
  await sleep(1500)
  await click('Calls')
  await sleep(1500)
  await click('Past')
  await sleep(1200)
  const opened = await click('ZZ-M39 Renewal call — the wrong client')
  await sleep(2500)
  const onRight = (await body()).includes('ZZ-M39 Renewal call — the wrong client')
  console.log(`navigate: ${opened}, on the right call: ${onRight}`)
  if (!onRight) throw new Error('did not reach the call under test')

  // Resolve the two contacts by name so the assertion names people, not ids.
  const contacts = JSON.parse(
    String(await cdp.evaluate(`(async () => JSON.stringify(await window.api.contacts.list()))()`))
  )
  const byId = new Map(contacts.map((c) => [c.id, c.name]))
  console.log(`BEFORE: linked to ${JSON.stringify(byId.get(before.contactId) ?? before.contactId)}`)

  const clicked = String(
    await cdp.evaluate(`(() => {
      const els = [...document.querySelectorAll('button')].filter((e) => !e.closest('nav,aside'))
      const pool = els.filter((e) => (e.textContent || '').trim().startsWith('Link to '))
      if (!pool.length) return 'NOT FOUND'
      if (pool.length > 1) return 'AMBIGUOUS x' + pool.length
      const hit = pool[0]
      hit.scrollIntoView({ block: 'center' })
      hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
      return 'clicked: ' + hit.textContent.trim()
    })()`)
  )
  console.log('click:', clicked)
  if (clicked.startsWith('NOT FOUND') || clicked.startsWith('AMBIGUOUS')) process.exit(1)

  await sleep(2500)

  const after = JSON.parse(await fs.readFile(recordPath, 'utf8'))
  console.log(`AFTER : linked to ${JSON.stringify(byId.get(after.contactId) ?? after.contactId)}`)
  console.log('')
  console.log('contactId CHANGED       :', before.contactId !== after.contactId)
  console.log('now the offered contact :', byId.get(after.contactId) === 'ZZ-M39 Harvey')

  const text = await body()
  console.log('notice gone from the page:', !text.includes('but it’s linked to') && !text.includes("but it's linked to"))
  await cdp.screenshot(join(SHOTS, '21-after-correction.png'))
} finally {
  await fs.writeFile(recordPath, snapshot, 'utf8')
  const restored = JSON.parse(await fs.readFile(recordPath, 'utf8'))
  console.log('')
  console.log('restored to the original link:', restored.contactId === before.contactId)
}
process.exit(0)
