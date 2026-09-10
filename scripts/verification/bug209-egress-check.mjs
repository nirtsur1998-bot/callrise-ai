// BUG-209 — does the account address actually stop leaving, on the real store?
//
// Builds the backup payload for every real event record with the app's OWN
// `eventPayload`, and searches the serialised result for the account address.
// Not "does the helper work" — the helper has unit tests. This asks the
// question the founder asked: is my Google address in what gets uploaded.
//
// The address is supplied on the command line rather than read from the
// profile, so this script never needs to touch a credential, and it is never
// printed back — only whether it was FOUND.
//
// Read-only: event records are read, nothing is written anywhere.
//
// usage: node scripts/verification/bug209-egress-check.mjs <userDataDir> <primary-calendar-id>
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { setPrimaryCalendarId } from '../../src/main/google-sync.ts'

const PROFILE = process.argv[2]
const PRIMARY = process.argv[3]
if (!PROFILE || !PRIMARY) {
  throw new Error('usage: bug209-egress-check.mjs <userDataDir> <primary-calendar-id>')
}

setPrimaryCalendarId(PRIMARY)

// eventPayload lives in backup.ts, which pulls in electron. Import it lazily so
// the failure is legible if that ever stops being possible from node.
const { eventPayload } = await import('../../src/main/backup.ts')

const dir = join(PROFILE, 'events')
if (!existsSync(dir)) throw new Error(`no events directory at ${dir}`)

let records = 0
let withProvider = 0
let leaks = 0
let scrubbed = 0
const shapes = new Map()

for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  let e
  try {
    e = JSON.parse(readFileSync(join(dir, f), 'utf8'))
  } catch {
    continue
  }
  records++
  if (e.provider) withProvider++
  const payload = eventPayload(e)
  const wire = JSON.stringify(payload)
  if (wire.includes(PRIMARY)) leaks++
  if (payload.provider === 'google:@primary') scrubbed++
  if (payload.provider) {
    const kind = String(payload.provider).split(':')[0]
    shapes.set(kind, (shapes.get(kind) ?? 0) + 1)
  }
}

console.log(`event records            : ${records}`)
console.log(`records with a provider  : ${withProvider}`)
console.log(`providers by kind on the wire: ${JSON.stringify(Object.fromEntries(shapes))}`)
console.log(`replaced with the placeholder: ${scrubbed}`)
console.log('')
console.log(
  leaks === 0
    ? 'PASS — the account address appears in NONE of the built payloads.'
    : `FAIL — the address is still present in ${leaks} of ${records} payloads.`
)
console.log('')
console.log('LIMIT, so this is not read as more than it is: this store has no')
console.log('GOOGLE-linked events, so the substitution branch is exercised by the')
console.log('unit tests and by any synthetic record below, not by real Google data.')
console.log('When Google two-way sync is connected, re-run this — it is the command')
console.log('that closes the open verification on BUG-209.')

// A synthetic record so the branch is at least exercised end-to-end here, and
// clearly labelled as synthetic rather than mixed into the counts above.
const synthetic = eventPayload({
  id: 'synthetic',
  title: 'x',
  start: '2026-01-01T00:00:00.000Z',
  end: '2026-01-01T00:30:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  source: 'local',
  provider: `google:${PRIMARY}`,
  externalId: 'e1'
})
console.log('')
console.log(
  `SYNTHETIC google-linked record -> provider on the wire: ${JSON.stringify(synthetic.provider)}` +
    `, address present: ${JSON.stringify(synthetic).includes(PRIMARY)}`
)
