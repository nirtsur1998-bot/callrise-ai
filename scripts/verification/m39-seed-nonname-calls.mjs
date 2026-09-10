// M39 — seed two FICTIONAL calls into a sandbox to prove the non-name guard
// in the running app, as a PAIR.
//
// One call carries a speaker identity named literally "someone" — the exact
// shape sitting on 7 of the founder's real calls today. The other carries a
// real (fictional) name. Same screen, same build, same second: if the guard
// works, one shows a name and one does not, and the second call is what stops
// "nothing rendered" from being mistaken for "the placeholder was dropped".
//
// Written straight to disk on purpose. The WRITE gate now refuses "someone",
// which is the fix — so the only way to reproduce the existing bad records is
// to bypass the app, exactly as history did.
//
// usage: node scripts/verification/m39-seed-nonname-calls.mjs <userDataDir>
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2]
if (!root) {
  console.error('usage: m39-seed-nonname-calls.mjs <userDataDir>')
  process.exit(1)
}
if (!/temp|tmp|sandbox/i.test(root)) {
  console.error(`REFUSING: ${root} does not look like a temp/sandbox path.`)
  process.exit(1)
}

const now = new Date()
const iso = (minsAgo) => new Date(now.getTime() - minsAgo * 60_000).toISOString()

function call({ id, title, identityName, minsAgo }) {
  return {
    id,
    title,
    createdAt: iso(minsAgo),
    updatedAt: iso(minsAgo),
    durationMs: 6 * 60_000,
    endedAt: iso(minsAgo - 6),
    segments: [
      { speaker: 0, text: 'Thanks for taking the time today.', role: 'rep', epoch: 0 },
      { speaker: 1, text: 'No problem at all, happy to talk.', role: 'other', epoch: 0 }
    ],
    // `recordOtherParty` is RECOMPUTED FROM `status` on every save and every
    // read — a hard invariant, so a hand-written file cannot grant capture by
    // setting the boolean alone. The first version of this seeder did exactly
    // that, got `recordOtherParty: false` back, and the app then correctly
    // withheld the other party's NAME from the transcript labels — which read
    // as the guard eating a real name until it was checked.
    consent: {
      status: 'consented',
      jurisdiction: 'one-party',
      method: 'verbal-on-call',
      recordOtherParty: true,
      disclosedAt: iso(minsAgo),
      decidedAt: iso(minsAgo)
    },
    // speakerIdentityKey() format — `mono/spkN` for a call with no channels,
    // `chN/spkN` for multichannel. A key in any other shape is dropped before
    // the non-name guard ever runs, which is how the first version of this
    // seeder produced an empty identity map on BOTH calls and briefly looked
    // like the guard working.
    speakerIdentities: {
      'mono/spk1': {
        name: identityName,
        source: 'self-intro',
        confidence: 'medium',
        resolvedAt: iso(minsAgo)
      }
    }
  }
}

const calls = [
  call({
    id: 'zz-m39-nonname',
    title: 'ZZ-M39 call with a PLACEHOLDER identity',
    identityName: 'someone',
    minsAgo: 30
  }),
  call({
    id: 'zz-m39-realname',
    title: 'ZZ-M39 call with a REAL identity',
    identityName: 'ZZ-M39 Sarah Chen',
    minsAgo: 60
  })
]

await fs.mkdir(join(root, 'calls'), { recursive: true })
for (const c of calls) {
  await fs.writeFile(join(root, 'calls', `${c.id}.json`), JSON.stringify(c, null, 2), 'utf8')
}
console.log(
  JSON.stringify(
    { seeded: calls.map((c) => ({ id: c.id, name: c.speakerIdentities['mono/spk1'].name })) },
    null,
    2
  )
)
