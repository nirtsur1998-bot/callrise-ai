// M37 Stage 1 — THE AS-OF PARSER, MEASURED.
//
// Step 4 shipped with three examples and was then parked behind the extraction
// work. "Unparked" here means the thing that was actually missing: a corpus.
// Three examples tell you the happy path exists; they cannot tell you what
// share of the ways a rep really phrases a question this grammar reads, and
// they cannot tell you what it reads WRONG — which is the only failure that
// matters, because a misread date produces a confident answer about the wrong
// moment, and the founder's whole rule for this module is "from the words
// typed, never guessed."
//
// Three buckets, and the middle one is the point:
//   PARSES  — the words carry a time, and this is the moment they mean.
//   REFUSES — the words carry no time this grammar may claim. null is CORRECT.
//   COARSE  — it parses, but to something blunter than the words said
//             ("early June" → the end of June). Reported as a number, not
//             failed: coarseness is a stated design choice (a month resolves
//             to its end), and the report is how we know its size.
//
// `now` is fixed so the corpus is stable: 2026-09-06T12:00:00Z, a Sunday in Q3.
import { describe, expect, it } from 'vitest'
import { parseAsOf } from '../temporal-question'

const NOW = new Date('2026-09-06T12:00:00.000Z')

interface Case {
  q: string
  /** expected ISO, or null for a refusal */
  at: string | null
  why?: string
}

/** The words carry a time and this is it. */
const PARSES: Case[] = [
  // explicit dates
  { q: 'What was the budget as of 2026-06-15?', at: '2026-06-15T23:59:59.999Z' },
  { q: 'as of June 1, what did they say about pricing?', at: '2026-06-01T23:59:59.999Z' },
  { q: 'What did we agree on June 10 2025?', at: '2025-06-10T23:59:59.999Z' },
  { q: 'Where were we as of the 3rd of July?', at: '2026-07-03T23:59:59.999Z' },
  { q: 'What was true on 15 August?', at: '2026-08-15T23:59:59.999Z' },
  { q: 'Remind me what they said on April 2nd', at: '2026-04-02T23:59:59.999Z' },
  // months
  { q: 'What did they say in April?', at: '2026-04-30T23:59:59.999Z', why: 'a month resolves to its end' },
  { q: 'What was the pricing in December?', at: '2025-12-31T23:59:59.999Z', why: 'December has not happened in 2026 yet, so the most recent one' },
  { q: 'back in March 2024 what was their budget?', at: '2024-03-31T23:59:59.999Z' },
  { q: 'at the end of July, were they still evaluating?', at: '2026-07-31T23:59:59.999Z' },
  { q: 'What did we know during August?', at: '2026-08-31T23:59:59.999Z' },
  { q: 'last May, what was the deal size?', at: '2026-05-31T23:59:59.999Z' },
  // quarters
  { q: 'What was the pipeline in Q1?', at: '2026-03-31T23:59:59.999Z' },
  { q: 'How did we do in Q4 2025?', at: '2025-12-31T23:59:59.999Z' },
  { q: 'What was their timeline last quarter?', at: '2026-06-30T23:59:59.999Z' },
  // years
  { q: 'What were we charging in 2025?', at: '2025-12-31T23:59:59.999Z' },
  { q: 'What did they want last year?', at: '2025-12-31T23:59:59.999Z' },
  // relative
  { q: 'What was the budget last month?', at: '2026-08-31T23:59:59.999Z' },
  { q: 'What did they say yesterday?', at: '2026-09-05T23:59:59.999Z' },
  { q: 'Where was this 3 weeks ago?', at: '2026-08-16T12:00:00.000Z' },
  { q: 'What was true 2 months ago?', at: '2026-07-06T23:59:59.999Z' },
  { q: 'What did we think 10 days ago?', at: '2026-08-27T12:00:00.000Z' }
]

/** The words carry no time this grammar may claim. null is the right answer. */
const REFUSES: Case[] = [
  { q: 'What is their budget?', at: null },
  { q: 'What did April say on the call?', at: null, why: 'April is a person here — no temporal preposition' },
  { q: 'Did May push back on price?', at: null, why: 'same: a name, not a month' },
  { q: 'What was true before the proposal?', at: null, why: 'an event is a fact to look up, not a word to parse' },
  { q: 'What changed after the demo?', at: null },
  { q: 'What did they say on 6/7?', at: null, why: 'ambiguous day/month order' },
  { q: 'What is the position right now?', at: null },
  { q: 'What is their current tooling?', at: null },
  { q: 'Where do we stand today?', at: null },
  { q: 'What happens next month?', at: null, why: 'the future has no validity window' },
  { q: 'What should I do tomorrow?', at: null },
  { q: 'Who is the decision maker?', at: null },
  { q: 'Summarise the last call', at: null, why: '"last call" is an event, not a date' },
  { q: 'What was said on the third?', at: null, why: 'a day with no month' },
  { q: 'How has the budget changed over time?', at: null },
  { q: 'What is the latest on Acme?', at: null },
  // M37 — the future. Every one of these returned a date in the PAST before
  // the marker check existed: "What will our pricing be in December?" was
  // answered as of 2025-12-31, ten months before the question was asked.
  { q: 'What will our pricing be in December?', at: null, why: 'was 2025-12-31 — the bug' },
  { q: 'Are we going to close this in November?', at: null, why: 'was 2025-11-30' },
  { q: 'Will they have signed by December?', at: null, why: 'was 2025-12-31' },
  { q: 'I expect to close in October', at: null, why: 'was 2025-10-31' },
  { q: 'What do they plan to do in Q4?', at: null, why: 'was 2025-12-31' },
  { q: 'What will they need next quarter?', at: null },
  { q: 'What is the upcoming renewal in March?', at: null }
]

/** Known and deliberately NOT closed — recorded so the gap is visible rather
 *  than discovered later. Each is future in intent but carries no explicit
 *  future word, and widening the markers to bare modals would refuse ordinary
 *  questions about the past ("should we have discounted in June?"). */
const FUTURE_INTENT_STILL_PARSES: Case[] = [
  { q: 'Can we deliver in early October?', at: '2025-10-31T23:59:59.999Z', why: 'no explicit future word; reads as last October' },
  { q: 'Should the budget be higher in Q4?', at: '2025-12-31T23:59:59.999Z', why: 'same' }
]

/** It parses, but to something blunter or different from what the words said.
 *  Recorded and counted rather than asserted — see the header. */
const COARSE: Case[] = [
  { q: 'What was true in early June?', at: '2026-06-30T23:59:59.999Z', why: 'says early, answers end-of-month' },
  { q: 'What did they say mid August?', at: '2026-08-31T23:59:59.999Z', why: 'says mid, answers end-of-month' },
  { q: 'What have we learned since June?', at: '2026-06-30T23:59:59.999Z', why: '"since" is a range start; read as a point' },
  { q: 'What was true at the start of July?', at: '2026-07-31T23:59:59.999Z', why: 'says start, answers end' }
]

function report(label: string, cases: Case[]): { pass: number; fail: string[] } {
  const fail: string[] = []
  for (const c of cases) {
    const got = parseAsOf(c.q, NOW)
    const at = got?.asOf ?? null
    if (at !== c.at) fail.push(`  "${c.q}"\n    expected ${c.at ?? 'null'}\n    got      ${at ?? 'null'}${got ? ` (read "${got.phrase}", ${got.precision})` : ''}`)
  }
  console.log(`${label}: ${cases.length - fail.length}/${cases.length}`)
  for (const f of fail) console.log(f)
  return { pass: cases.length - fail.length, fail }
}

describe('as-of parser — corpus', () => {
  it('reads the moment the words name', () => {
    const r = report('PARSES', PARSES)
    expect(r.fail.join('\n')).toBe('')
  })

  it('refuses every question that names no time it may claim', () => {
    const r = report('REFUSES', REFUSES)
    expect(r.fail.join('\n')).toBe('')
  })

  it('records the future-intent questions it still reads as the past — the gap, pinned', () => {
    const r = report('FUTURE INTENT, NO MARKER (known gap)', FUTURE_INTENT_STILL_PARSES)
    expect(r.fail.join('\n')).toBe('')
  })

  it('records where it is coarser than the words, as a measured number', () => {
    const r = report('COARSE (known, by design)', COARSE)
    // These are pinned so a change in coarseness is visible in a diff rather
    // than silent. If one of them gets sharper, this test says so and the
    // case moves up to PARSES.
    expect(r.fail.join('\n')).toBe('')
    console.log(
      `\nCORPUS TOTAL: ${PARSES.length} parsed + ${REFUSES.length} refused + ${COARSE.length} coarse = ${PARSES.length + REFUSES.length + COARSE.length} questions`
    )
  })
})
