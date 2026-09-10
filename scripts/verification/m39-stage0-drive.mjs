// M39 Stage 0 — drive the RUNNING app and prove the invitee list survives.
//
// The suite proves the mechanism; the app proves the product. What the unit
// tests cannot show is that a real adoption, through the real preload bridge,
// the real ipcMain handler and the real atomic write, lands `attendees` in a
// real JSON file on disk — and that everything else about the record is
// unchanged.
//
// STORE UNDER TEST: a FICTIONAL sandbox at %TEMP%/m39-sandbox, seeded by
// m39-seed-sandbox.mjs. Not the founder's profile, which is never read or
// written here. The app prints BUG-186's two guard lines on this profile
// ("userData overridden ->" and "SANDBOX profile ... REFUSED"), so nothing it
// does can reach Supabase either.
//
// usage: node scripts/verification/m39-stage0-drive.mjs <port> <pid> <sandbox> <shotsDir>
import { openApp } from './ui-driver.mjs'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.argv[2])
const PID = Number(process.argv[3])
const SANDBOX = process.argv[4]
const SHOTS = process.argv[5]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = { store: SANDBOX, steps: [] }
const step = (name, value) => {
  out.steps.push({ name, value })
  console.log(`[m39] ${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
}

const cdp = await openApp(PORT, { expect: 'out/renderer', expectPid: PID })
const body = async () => String(await cdp.evaluate('document.body.innerText'))
const clickByText = async (label) =>
  cdp.evaluate(`(() => {
    const want = ${JSON.stringify(label)}
    const els = [...document.querySelectorAll('button, a, [role="button"], [role="tab"], [role="link"]')]
    const hit = els.find((e) => (e.textContent || '').trim() === want)
      || els.find((e) => (e.getAttribute('aria-label') || '').trim() === want)
      || els.find((e) => (e.textContent || '').trim().includes(want))
    if (!hit) return 'NOT FOUND'
    const r = hit.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return 'ZERO SIZE'
    hit.scrollIntoView({ block: 'center' })
    hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return 'clicked'
  })()`)

// Onboarding stands between a fresh sandbox and the app.
let text = await body()
for (const label of ['Skip setup', 'Skip', 'Get started']) {
  if (!text.includes(label)) continue
  step(`onboarding: ${label}`, await clickByText(label))
  await sleep(2500)
  text = await body()
  break
}
await cdp.screenshot(join(SHOTS, '01-landing.png'))

// ---------------------------------------------------------------------------
// 1. What the app itself holds. Asking the app rather than reading the file I
//    just wrote: a seed that never reached the app would otherwise look like a
//    pass, and "the population is empty" and "the mechanism is missing" are
//    the two readings a zero always has.
// ---------------------------------------------------------------------------
const cached = await cdp.evaluate(`(async () => {
  const evs = await window.api.outlook.cachedEvents()
  return JSON.stringify(evs.map((e) => ({
    id: e.id, title: e.title, attendees: e.attendees ? e.attendees.length : 0
  })))
})()`)
step('outlook cache as the APP sees it', JSON.parse(String(cached)))

const localBefore = await cdp.evaluate(`(async () => {
  const evs = await window.api.events.list()
  return JSON.stringify(evs.map((e) => ({
    id: e.id, title: e.title, contactId: e.contactId ?? null,
    externalId: e.externalId ?? null, attendees: e.attendees ? e.attendees.length : 0
  })))
})()`)
step('local store BEFORE the adoption', JSON.parse(String(localBefore)))

// ---------------------------------------------------------------------------
// 2. Adopt the group meeting through the REAL bridge. This is exactly the
//    payload `adoptPayload` builds — constructed here from the event object the
//    APP handed back, not from the seed file, so a field the app drops on the
//    way out would show up as a missing field here.
// ---------------------------------------------------------------------------
const adopted = await cdp.evaluate(`(async () => {
  const evs = await window.api.outlook.cachedEvents()
  const src = evs.find((e) => e.id === 'ZZ-M39-OUTLOOK-DISCOVERY')
  if (!src) return JSON.stringify({ error: 'seeded event not visible to the app' })
  const created = await window.api.events.adopt({
    title: src.title, start: src.start, end: src.end, allDay: src.allDay,
    notes: null, contactId: null, dealId: null,
    provider: src.provider, externalId: src.externalId,
    remoteUpdatedAt: src.updatedAt,
    attendees: src.attendees
  })
  return JSON.stringify({ id: created.id, attendees: created.attendees ?? null })
})()`)
step('adopt() returned', JSON.parse(String(adopted)))
await sleep(1200)

// ---------------------------------------------------------------------------
// 3. THE CLAIM, read off the disk the app wrote — not from the value it
//    returned. A handler that returns a correct object and writes a lossy one
//    is exactly the shape BUG-187 had.
// ---------------------------------------------------------------------------
const created = JSON.parse(String(adopted))
const recordPath = join(SANDBOX, 'events', `${created.id}.json`)
const onDisk = JSON.parse(await fs.readFile(recordPath, 'utf8'))
step('record path', recordPath)
step('ON DISK: attendees', onDisk.attendees ?? null)
step('ON DISK: the rest is intact', {
  title: onDisk.title,
  externalId: onDisk.externalId,
  source: onDisk.source,
  start: onDisk.start
})

// The neighbouring record must be untouched — a write that also rewrote the
// mirror would be a silent regression this drive is the only witness to.
const files = (await fs.readdir(join(SANDBOX, 'events'))).filter((f) => f.endsWith('.json'))
const mirror = JSON.parse(
  await fs.readFile(join(SANDBOX, 'events', files.find((f) => f !== `${created.id}.json`)), 'utf8')
)
step('the seeded mirror is unchanged', {
  contactId: mirror.contactId,
  attendees: mirror.attendees ?? null,
  externalId: mirror.externalId
})

// ---------------------------------------------------------------------------
// 4. Screens, for the design pass.
// ---------------------------------------------------------------------------
for (const label of ['Calendar', 'Meetings']) {
  if ((await clickByText(label)) === 'clicked') {
    step('nav', label)
    break
  }
}
await sleep(2500)
const calText = await body()
await cdp.screenshot(join(SHOTS, '02-calendar.png'))
step(
  'seeded meetings visible on Calendar',
  ['ZZ-M39 Renewal call', 'ZZ-M39 Discovery', 'ZZ-M39 Focus block'].filter((t) =>
    calText.includes(t)
  )
)

for (const label of ['Live', 'Live call']) {
  if ((await clickByText(label)) === 'clicked') {
    step('nav', label)
    break
  }
}
await sleep(3000)
const liveText = await body()
await cdp.screenshot(join(SHOTS, '03-live.png'))
step('Live screen mentions the live meeting', liveText.includes('ZZ-M39 Renewal call'))

console.log('\n=== RESULT ===')
console.log(JSON.stringify(out, null, 2))
process.exit(0)
