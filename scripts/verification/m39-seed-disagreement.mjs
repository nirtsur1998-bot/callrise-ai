// M39 — seed the disagreement case into a sandbox, reproducing one of the SIX
// real shapes on the founder's profile exactly.
//
// The real case: a call whose transcript carries a self-introduction as
// "Harvey", linked to a contact named "kerry". Reproduced with fictional names
// (ZZ-M39 prefix) so nothing here can be confused for real data, and with the
// same STRUCTURE: contact A linked, contact B named in the transcript, contact
// B existing in the store so the notice can offer to switch.
//
// Also seeds the other two suggestion shapes, because the notice renders three
// ways and a screenshot of one proves one:
//   - 'link'      -> the spoken name matches exactly one other contact
//   - 'create'    -> nobody by that name exists
//   - 'ambiguous' -> several contacts share it (the kevin x3 shape)
//
// usage: node scripts/verification/m39-seed-disagreement.mjs <userDataDir>
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const root = process.argv[2]
if (!root) {
  console.error('usage: m39-seed-disagreement.mjs <userDataDir>')
  process.exit(1)
}
if (!/temp|tmp|sandbox/i.test(root)) {
  console.error(`REFUSING: ${root} does not look like a temp/sandbox path.`)
  process.exit(1)
}

const now = Date.now()
const iso = (minsAgo) => new Date(now - minsAgo * 60_000).toISOString()

const contact = (name) => ({
  id: randomUUID(),
  name,
  createdAt: iso(4000),
  updatedAt: iso(4000)
})

// The cast. `kerry` is the wrongly-linked one; `Harvey` is who actually spoke.
const kerry = contact('ZZ-M39 Kerry')
const harvey = contact('ZZ-M39 Harvey')
const damien = contact('ZZ-M39 Damien Donehue')
const kevinA = contact('ZZ-M39 Kevin')
const kevinB = contact('ZZ-M39 Kevin')
const kevinLinked = contact('ZZ-M39 Priya')
const contacts = [kerry, harvey, damien, kevinA, kevinB, kevinLinked]

const call = ({ id, title, spoken, contactId, minsAgo }) => ({
  id,
  title,
  createdAt: iso(minsAgo),
  updatedAt: iso(minsAgo),
  durationMs: 8 * 60_000,
  endedAt: iso(minsAgo - 8),
  contactId,
  segments: [
    { speaker: 0, text: 'Thanks for making the time today.', role: 'rep', epoch: 0 },
    { speaker: 1, text: `Of course. ${spoken} here, good to meet you.`, role: 'other', epoch: 0 },
    { speaker: 0, text: 'Great — shall we start with where you are now?', role: 'rep', epoch: 0 }
  ],
  consent: {
    status: 'consented',
    jurisdiction: 'one-party',
    method: 'verbal-on-call',
    recordOtherParty: true,
    disclosedAt: iso(minsAgo),
    decidedAt: iso(minsAgo)
  },
  speakerIdentities: {
    'mono/spk1': {
      name: spoken,
      source: 'self-intro',
      confidence: 'medium',
      resolvedAt: iso(minsAgo)
    }
  }
})

const calls = [
  // THE REAL SHAPE: "Harvey" vs a call linked to kerry.
  call({
    id: 'zz-m39-disagree-link',
    title: 'ZZ-M39 Renewal call — the wrong client',
    spoken: 'ZZ-M39 Harvey',
    contactId: kerry.id,
    minsAgo: 20
  }),
  // Nobody by that name exists -> offer to create.
  call({
    id: 'zz-m39-disagree-create',
    title: 'ZZ-M39 Discovery — an unknown name',
    spoken: 'ZZ-M39 Anshur',
    contactId: damien.id,
    minsAgo: 40
  }),
  // Several contacts share the name -> refuse to choose.
  call({
    id: 'zz-m39-disagree-ambiguous',
    title: 'ZZ-M39 Check-in — two of them are called that',
    spoken: 'ZZ-M39 Kevin',
    contactId: kevinLinked.id,
    minsAgo: 60
  }),
  // THE CONTROL: name and link agree. Must show NOTHING.
  call({
    id: 'zz-m39-agree-control',
    title: 'ZZ-M39 Pricing call — name and link agree',
    spoken: 'ZZ-M39 Harvey',
    contactId: harvey.id,
    minsAgo: 80
  })
]

await fs.mkdir(join(root, 'contacts'), { recursive: true })
for (const c of contacts) {
  await fs.writeFile(join(root, 'contacts', `${c.id}.json`), JSON.stringify(c, null, 2), 'utf8')
}
await fs.mkdir(join(root, 'calls'), { recursive: true })
for (const c of calls) {
  await fs.writeFile(join(root, 'calls', `${c.id}.json`), JSON.stringify(c, null, 2), 'utf8')
}

console.log(
  JSON.stringify(
    {
      contacts: contacts.map((c) => ({ id: c.id.slice(0, 8), name: c.name })),
      calls: calls.map((c) => ({
        id: c.id,
        spoken: c.speakerIdentities['mono/spk1'].name,
        linkedTo: contacts.find((x) => x.id === c.contactId)?.name
      }))
    },
    null,
    2
  )
)
