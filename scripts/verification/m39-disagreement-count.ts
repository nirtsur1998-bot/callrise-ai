// M39 — how many calls would the disagreement surface actually flag?
//
// The founder's condition for building it: "tell me how many of my 297 calls it
// would flag — that number is the feature's value, stated up front." So it is
// measured BEFORE the UI exists, using the real guard and the real matching
// rules rather than an estimate.
//
// A call is FLAGGED when all three hold:
//   1. it carries a self-intro identity that survives `isNonName` (so the 7
//      "someone" records are gone — they are a failed extraction, not a
//      disagreement, and they are counted separately here);
//   2. it is linked to a contact;
//   3. the spoken name does not correspond to that contact under the same two
//      rules `matchContactByName` uses — exact, or first+last spoken against a
//      single-word contact.
//
// usage: npx tsx scripts/verification/m39-disagreement-count.ts <callsDir> <contactsDir>
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isNonName } from '../../src/main/ai/model-placeholders'

const [callsDir, contactsDir] = process.argv.slice(2)
if (!callsDir || !contactsDir) {
  console.error('usage: m39-disagreement-count.ts <callsDir> <contactsDir>')
  process.exit(1)
}

const norm = (s: unknown): string => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

const readAll = (dir: string): Record<string, unknown>[] =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      try {
        return [JSON.parse(readFileSync(join(dir, f), 'utf8'))]
      } catch {
        return []
      }
    })

const contacts = readAll(contactsDir) as { id: string; name: string }[]
const byId = new Map(contacts.map((c) => [c.id, c]))

/**
 * CONSISTENCY, which is a different question from MATCHING and needs the
 * opposite bias.
 *
 * `matchContactByName` must be STRICT: it is choosing a contact out of fifty
 * with nothing to check itself against, so a tie has to be refused. This asks
 * something weaker — the link already exists, and the only question is whether
 * the spoken name CONTRADICTS it. A false flag here is expensive in a way a
 * refused match is not: it puts a correction in front of the rep mid-call for
 * a link that was right, and two of those teach them to dismiss the surface.
 *
 * So consistency is lenient in both directions of completeness:
 *   "Kevin" vs contact "Kevin Mooney"   -> consistent (the buyer gave less)
 *   "Paul Trader" vs contact "Paul"     -> consistent (the buyer gave more)
 *   "Philip Collins" vs "Philip Genio"  -> CONTRADICTION, two different people
 *
 * Measured cost of getting this wrong: with the strict rule, 7 of 297 calls
 * flagged and 2 of the 7 were the same person described at different lengths.
 */
//
// KEPT IN STEP WITH THE PRODUCT, deliberately. This is the same rule
// `namesCorrespond` uses in identityDisagreement.ts — "the shorter name is a
// leading run of the longer" — widened there on 2026-09-11 after the narrower
// version flagged "Priya Raman Gupta" against "Priya Raman". This copy sat on
// the old rule for a few hours, which is how a measuring instrument starts
// reporting a number the product would not produce. The two agree on today's
// corpus (13 raw contradictions either way, because 0 of the 47 pairs can tell
// them apart) — and "they agree on this data" is not "they are the same rule",
// which is the whole reason to sync it rather than note it.
function corresponds(spoken: string, contact: { name: string }): boolean {
  const s = norm(spoken)
  const c = norm(contact.name)
  if (s === c) return true
  const sw = s.split(' ')
  const cw = c.split(' ')
  const [short, long] = sw.length <= cw.length ? [sw, cw] : [cw, sw]
  return short.every((w, i) => w === long[i])
}

let calls = 0
let withSelfIntro = 0
let failedExtraction = 0
let unlinked = 0
let agrees = 0
const flagged: { spoken: string; linkedTo: string }[] = []

for (const call of readAll(callsDir) as Record<string, any>[]) {
  calls++
  const ids = (call.speakerIdentities ?? {}) as Record<string, { name?: string; source?: string }>
  const si = Object.values(ids).find((v) => v && v.source === 'self-intro')
  if (!si || typeof si.name !== 'string') continue
  withSelfIntro++
  if (isNonName(si.name)) {
    failedExtraction++
    continue
  }
  if (!call.contactId) {
    unlinked++
    continue
  }
  const linked = byId.get(call.contactId)
  if (!linked) {
    unlinked++
    continue
  }
  if (corresponds(si.name, linked)) agrees++
  else flagged.push({ spoken: si.name, linkedTo: linked.name })
}

console.log(`calls on this store                       : ${calls}`)
console.log(`  carrying a self-intro identity          : ${withSelfIntro}`)
console.log(`  failed extraction, dropped by isNonName : ${failedExtraction}  (not a disagreement)`)
console.log(`  no usable contact link                  : ${unlinked}`)
console.log(`  name AGREES with the linked contact     : ${agrees}`)
console.log(`  >> WOULD BE FLAGGED                     : ${flagged.length}`)
console.log('')
for (const f of flagged) console.log(`   "${f.spoken}"  vs linked contact  "${f.linkedTo}"`)
