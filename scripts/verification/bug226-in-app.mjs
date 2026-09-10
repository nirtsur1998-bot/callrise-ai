// BUG-226 — drive the live meeting match in the RUNNING app.
//
// The suite proves the ranking; only the app proves the product. What it
// cannot reach is whether LiveView actually calls this, on real events loaded
// through the real calendar hook, and whether an ambiguous pair really shows
// the rep nothing instead of a confident wrong name.
//
// SANDBOX PROFILE, always. The events planted here are fabricated; they must
// never touch the founder's store. The sandbox is seeded with a COPY of the
// real auth + keys so the app gets past the login screen — BUG-186 makes a
// sandbox refuse cloud push and pull, so nothing fabricated can reach the
// server.
//
// usage:
//   node scripts/verification/bug226-in-app.mjs plant <sandbox>   # seed + plant events
//   node scripts/verification/bug226-in-app.mjs read  <sandbox> [port]
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { connect } from './cdp.mjs'

const MODE = process.argv[2]
const SANDBOX = process.argv[3]
const PORT = Number(process.argv[4] || 9342)
const REAL = join(process.env.APPDATA ?? '', 'sales-os')
if (!MODE || !SANDBOX) throw new Error('usage: bug226-in-app.mjs plant|read <sandbox> [port]')

const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString()

/** Two meetings covering this instant, tied on every signal the matcher uses:
 *  neither linked to a contact, both already started, identical duration. The
 *  old `.find()` returned whichever loaded first; the fix must return NEITHER. */
function ambiguousPair() {
  const start = iso(-5 * 60_000)
  const end = iso(25 * 60_000)
  return [
    { title: 'ZZ-BUG226-ACME', start, end },
    { title: 'ZZ-BUG226-GLOBEX', start, end }
  ]
}

/** One meeting the rep linked BY HAND, against one they did not. Same times,
 *  so ONLY the explicit link can separate them. */
function decidablePair(contactId) {
  const start = iso(-5 * 60_000)
  const end = iso(25 * 60_000)
  return [
    { title: 'ZZ-BUG226-UNLINKED', start, end },
    { title: 'ZZ-BUG226-LINKED', start, end, contactId }
  ]
}

function plantEvents(dir, events) {
  const eventsDir = join(dir, 'events')
  mkdirSync(eventsDir, { recursive: true })
  const ids = []
  for (const e of events) {
    const id = randomUUID()
    ids.push(id)
    writeFileSync(
      join(eventsDir, `${id}.json`),
      JSON.stringify({ id, allDay: false, source: 'local', ...e }, null, 2),
      'utf8'
    )
  }
  return ids
}

if (MODE === 'plant') {
  mkdirSync(SANDBOX, { recursive: true })
  // Seed only what the app needs to open: the OSCrypt key material, the
  // session, the provider keys, and settings. No calls, no memories, no
  // transcripts — nothing this drive does not require.
  for (const f of ['Local State', 'supabase-auth.json', 'app-settings.json']) {
    if (existsSync(join(REAL, f))) cpSync(join(REAL, f), join(SANDBOX, f))
  }
  if (existsSync(join(REAL, 'ai-keys'))) cpSync(join(REAL, 'ai-keys'), join(SANDBOX, 'ai-keys'), { recursive: true })

  const contactsDir = join(SANDBOX, 'contacts')
  mkdirSync(contactsDir, { recursive: true })
  const contactId = randomUUID()
  writeFileSync(
    join(contactsDir, `${contactId}.json`),
    JSON.stringify({ id: contactId, name: 'ZZ BUG226 Linked Contact', createdAt: new Date().toISOString() }, null, 2),
    'utf8'
  )

  const scenario = process.env.BUG226_SCENARIO ?? 'ambiguous'
  const events = scenario === 'decidable' ? decidablePair(contactId) : ambiguousPair()
  const ids = plantEvents(SANDBOX, events)
  console.log(`[bug226] sandbox      ${SANDBOX}`)
  console.log(`[bug226] scenario     ${scenario}`)
  console.log(`[bug226] planted      ${ids.length} events covering now: ${events.map((e) => e.title).join(', ')}`)
  console.log(`[bug226] events on disk: ${readdirSync(join(SANDBOX, 'events')).length}`)
} else if (MODE === 'read') {
  const cdp = await connect(PORT)
  console.log(`[bug226] page: ${cdp.page.url}`)
  // Read the MEETING LINE from the DOM, not a log: what the rep can actually
  // see is the claim being tested. The two planted titles are deliberately
  // marked ZZ-BUG226 so their presence or absence is unambiguous.
  const body = await cdp.evaluate('document.body.innerText')
  const shows = (t) => String(body).includes(t)
  const seen = ['ZZ-BUG226-ACME', 'ZZ-BUG226-GLOBEX', 'ZZ-BUG226-LINKED', 'ZZ-BUG226-UNLINKED'].filter(shows)
  console.log(`[bug226] planted titles visible on screen: ${seen.length ? seen.join(', ') : '(none)'}`)
  console.log(JSON.stringify({ seen }))
} else {
  throw new Error(`unknown mode ${MODE}`)
}
