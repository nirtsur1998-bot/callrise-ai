// M39 — seed a FICTIONAL sandbox profile.
//
// The founder's condition, verbatim: "The sandbox seeds fictional contacts and
// meetings. Don't manufacture data on my profile to make a test fire." So this
// builds a brand-new empty userData directory — it is not a copy of the real
// profile, and it never reads it. Every name here is prefixed ZZ-M39 and every
// address is at a reserved-looking `zz-*-example.com` domain, so a row from
// this seed can never be mistaken for a real one in any later measurement.
//
// WHAT IT SEEDS, and why each piece exists:
//
//  1. an Outlook cache holding a meeting that is LIVE RIGHT NOW and carries one
//     invitee — the shape the identity ladder's primary rung needs;
//  2. a LOCAL event mirroring it (same externalId) that carries `contactId` and
//     NO attendees — this is the exact pair that lost the invitee list before
//     this change: `collapseMirrors` picked the local twin for its contactId
//     and dropped the provider twin that held the attendees;
//  3. an unmirrored provider meeting with two invitees (a group call);
//  4. a solo meeting with none, because that is the majority case on a real
//     store and it must stay unchanged.
//
// usage: node scripts/verification/m39-seed-sandbox.mjs <userDataDir>
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const root = process.argv[2]
if (!root) {
  console.error('usage: m39-seed-sandbox.mjs <userDataDir>')
  process.exit(1)
}
// A guard, not a formality: pointing this at the real profile would write
// fictional meetings into the founder's calendar.
if (!/temp|tmp|sandbox/i.test(root)) {
  console.error(`REFUSING: ${root} does not look like a temp/sandbox path.`)
  process.exit(1)
}

const now = Date.now()
const iso = (deltaMin) => new Date(now + deltaMin * 60_000).toISOString()
const stamp = new Date(now - 86_400_000).toISOString()

const LIVE_EXTERNAL_ID = 'ZZ-M39-OUTLOOK-RENEWAL'

const outlookEvents = [
  {
    id: LIVE_EXTERNAL_ID,
    title: 'ZZ-M39 Renewal call — Acme',
    start: iso(-10),
    end: iso(20),
    allDay: false,
    source: 'outlook',
    provider: 'outlook:zz-m39-calendar',
    externalId: LIVE_EXTERNAL_ID,
    writable: false,
    attendees: [{ email: 'sarah.chen@zz-acme-example.com', name: 'ZZ-M39 Sarah Chen' }],
    createdAt: stamp,
    updatedAt: stamp
  },
  {
    id: 'ZZ-M39-OUTLOOK-DISCOVERY',
    title: 'ZZ-M39 Discovery — Globex',
    start: iso(90),
    end: iso(120),
    allDay: false,
    source: 'outlook',
    provider: 'outlook:zz-m39-calendar',
    externalId: 'ZZ-M39-OUTLOOK-DISCOVERY',
    writable: false,
    attendees: [
      { email: 'raj.patel@zz-globex-example.com', name: 'ZZ-M39 Raj Patel' },
      { email: 'finance@zz-globex-example.com' }
    ],
    createdAt: stamp,
    updatedAt: stamp
  },
  {
    id: 'ZZ-M39-OUTLOOK-SOLO',
    title: 'ZZ-M39 Focus block',
    start: iso(240),
    end: iso(300),
    allDay: false,
    source: 'outlook',
    provider: 'outlook:zz-m39-calendar',
    externalId: 'ZZ-M39-OUTLOOK-SOLO',
    writable: false,
    createdAt: stamp,
    updatedAt: stamp
  }
]

// The local mirror of the live meeting: carries the hand-made contact link,
// carries NO invitees. Deliberately written the way the store looked BEFORE
// this change, so the drive measures the fix rather than the seed.
const localMirror = {
  id: randomUUID(),
  title: 'ZZ-M39 Renewal call — Acme',
  start: iso(-10),
  end: iso(20),
  allDay: false,
  source: 'local',
  provider: 'outlook:zz-m39-calendar',
  externalId: LIVE_EXTERNAL_ID,
  contactId: 'zz-m39-contact-1',
  sync: { state: 'synced' },
  createdAt: stamp,
  updatedAt: stamp
}

await fs.mkdir(join(root, 'outlook'), { recursive: true })
await fs.writeFile(join(root, 'outlook', 'events.json'), JSON.stringify(outlookEvents), 'utf8')

await fs.mkdir(join(root, 'events'), { recursive: true })
await fs.writeFile(
  join(root, 'events', `${localMirror.id}.json`),
  JSON.stringify(localMirror, null, 2),
  'utf8'
)

console.log(JSON.stringify({ root, localMirrorId: localMirror.id, LIVE_EXTERNAL_ID }, null, 2))
