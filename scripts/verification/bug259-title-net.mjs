// BUG-259 — measure the title validator against REAL titles, both ways.
//
// `looksLikeTitle` is a pattern net, and a pattern net catches every example it
// was built from — which reads as coverage and is not. Two numbers are needed
// before it ships, and they pull in opposite directions:
//
//   FALSE POSITIVES: good titles the net would now throw away, replacing them
//     with a date. Measured against the founder's 297 real titles.
//   ESCAPES: reasoning preambles it still lets through. Measured against
//     adversarial openings the net was NOT built from.
//
// Read-only. Prints counts and, for rejections only, the title it rejected —
// because a false positive is unreadable as a number.
//
// usage: node scripts/verification/bug259-title-net.mjs
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { looksLikeTitle, titleFromText } from '../../src/main/call-title.ts'

const DIR = join(process.env.APPDATA ?? '', 'sales-os', 'calls')

const real = []
for (const f of readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
  try {
    const c = JSON.parse(readFileSync(join(DIR, f), 'utf8'))
    const t = String(c.title ?? '').trim()
    if (t) real.push(t)
  } catch {
    /* skip */
  }
}

// The app's own default title. It is not a model output and must not be counted
// against the net either way.
const isDefault = (t) => /^Call · /.test(t)
const modelMade = real.filter((t) => !isDefault(t))

const rejected = modelMade.filter((t) => !looksLikeTitle(t))
console.log(`REAL TITLES on this machine: ${real.length} (${real.length - modelMade.length} are the app's date default)`)
console.log(`  model-made titles judged:  ${modelMade.length}`)
console.log(`  REJECTED by the net:       ${rejected.length}`)
console.log('')
for (const t of rejected) console.log(`    rejected: ${t.slice(0, 78)}`)
console.log('')

// Adversarial openings the net was NOT built from — the escape-rate half. The
// three the founder actually hit are marked; the rest are invented pressure.
const ADVERSARIAL = [
  ["Here's a thinking process:", 'HIT'],
  ['We need to produce a short specific title 5-8 words, company/person name plus topic', 'HIT'],
  ['We need to read transcript, find company/person name mentioned, then choose', 'HIT'],
  ['Let me analyze this call to find the right title', 'invented'],
  ['Analysis: the caller is discussing a refund', 'invented'],
  ['Step 1: identify the participants', 'invented'],
  ['The user wants a title of 5-8 words', 'invented'],
  ['Thinking through the transcript now', 'invented'],
  ['I need to find the company name first', 'invented'],
  ['Reasoning: no company is named, so describe the topic', 'invented'],
  ['Alright, scanning for names', 'invented'],
  ['Now, the transcript mentions a delivery issue', 'invented'],
  ['Okay so the call is about billing', 'invented'],
  ['First, I will summarise what happened on this sales call', 'invented'],
  ['So the rep is trying to close a renewal here', 'invented']
]
const escapes = ADVERSARIAL.filter(([t]) => looksLikeTitle(t))
console.log(`ADVERSARIAL PREAMBLES: ${ADVERSARIAL.length} (3 real, 12 invented)`)
console.log(`  ESCAPED the net:     ${escapes.length}`)
for (const [t, kind] of escapes) console.log(`    escaped (${kind}): ${t.slice(0, 70)}`)
console.log('')

// Titles that must SURVIVE — the shape the product actually wants.
const MUST_PASS = [
  'Acme Co — Renewal Discussion',
  'Kevin — Revolut $500 Transfer to HNO',
  'Jack Thompson — Account Returns and Property Investment',
  'Harvey Contact Info Confirmation Call',
  'Carrie and Thomas document follow-up',
  'Refund request escalated to supervisor',
  'Pricing objection, competitor comparison'
]
const wrongly = MUST_PASS.filter((t) => !looksLikeTitle(t))
console.log(`GOOD TITLES that must survive: ${MUST_PASS.length}`)
console.log(`  wrongly rejected:            ${wrongly.length}`)
for (const t of wrongly) console.log(`    WRONGLY REJECTED: ${t}`)
console.log('')

// And the whole-response behaviour: a reasoning dump that ENDS with a real
// title must still yield that title, not ''.
const DUMP = `Here's a thinking process:

1. Read the transcript and find the company.
2. The caller is from Acme and asks about renewal pricing.

Title: Acme — Renewal Pricing Questions`
console.log(`reasoning dump ending in a labelled title -> ${JSON.stringify(titleFromText(DUMP))}`)
const DUMP_NO_TITLE = `Here's a thinking process:

We need to produce a short specific title 5-8 words.`
console.log(`reasoning dump with NO title at all       -> ${JSON.stringify(titleFromText(DUMP_NO_TITLE))}  (empty = falls back to the date)`)

const bad = rejected.length > 3 || escapes.length > 0 || wrongly.length > 0
console.log('')
console.log(bad ? 'NET NEEDS WORK' : 'net holds on this data')
process.exit(bad ? 1 : 0)
