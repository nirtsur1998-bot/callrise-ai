// M36 Stage 3 item 5, step 4 — the parser. Pure and deterministic: `now` is
// the only clock, and the negatives matter as much as the positives — every
// form the founder ruled out as a guess must return null.
import { describe, expect, it } from 'vitest'
import { parseAsOf } from '../temporal-question'

const NOW = new Date('2026-09-06T12:00:00.000Z') // a Sunday in September

describe('parseAsOf — recognised forms', () => {
  it('a month with a temporal preposition resolves to the END of its most recent past occurrence', () => {
    expect(parseAsOf('What was the budget in June?', NOW)).toEqual({ asOf: '2026-06-30T23:59:59.999Z', phrase: 'in june', precision: 'month' })
    expect(parseAsOf('Who was the decision maker back in March?', NOW)).toEqual({ asOf: '2026-03-31T23:59:59.999Z', phrase: 'back in march', precision: 'month' })
    expect(parseAsOf('What did they want during Feb?', NOW)).toMatchObject({ asOf: '2026-02-28T23:59:59.999Z', precision: 'month' })
    // a month later than now's month means LAST year's — the most recent one that has happened
    expect(parseAsOf('What was our pricing in November?', NOW)).toMatchObject({ asOf: '2025-11-30T23:59:59.999Z' })
    // the current month resolves to now, not to the future end of the month
    expect(parseAsOf('What was true in September?', NOW)).toBeNull()
  })

  it('month + year, month + day, day + month', () => {
    expect(parseAsOf('What did we charge in June 2025?', NOW)).toMatchObject({ asOf: '2025-06-30T23:59:59.999Z', precision: 'month' })
    expect(parseAsOf('as of March 3, what was the budget?', NOW)).toMatchObject({ asOf: '2026-03-03T23:59:59.999Z', phrase: 'as of march 3', precision: 'day' })
    expect(parseAsOf('on June 10th 2025 who owned the deal?', NOW)).toMatchObject({ asOf: '2025-06-10T23:59:59.999Z', precision: 'day' })
    expect(parseAsOf('what was agreed on the 14th of March?', NOW)).toMatchObject({ asOf: '2026-03-14T23:59:59.999Z', precision: 'day' })
    expect(parseAsOf('status as of 2026-06-15?', NOW)).toMatchObject({ asOf: '2026-06-15T23:59:59.999Z', precision: 'day' })
  })

  it('quarters and years', () => {
    expect(parseAsOf('What was the pipeline in Q1?', NOW)).toMatchObject({ asOf: '2026-03-31T23:59:59.999Z', precision: 'quarter' })
    expect(parseAsOf('How did Q4 2025 end?', NOW)).toMatchObject({ asOf: '2025-12-31T23:59:59.999Z', precision: 'quarter' })
    expect(parseAsOf('What did we know last quarter?', NOW)).toMatchObject({ asOf: '2026-06-30T23:59:59.999Z', precision: 'quarter' })
    expect(parseAsOf('What was the price in 2025?', NOW)).toMatchObject({ asOf: '2025-12-31T23:59:59.999Z', precision: 'year' })
    expect(parseAsOf('Who did we sell to last year?', NOW)).toMatchObject({ asOf: '2025-12-31T23:59:59.999Z', precision: 'year' })
  })

  it('relative forms', () => {
    expect(parseAsOf('What was the budget last month?', NOW)).toMatchObject({ asOf: '2026-08-31T23:59:59.999Z', precision: 'month' })
    expect(parseAsOf('What did they say last week?', NOW)).toMatchObject({ asOf: '2026-08-30T12:00:00.000Z', precision: 'week' })
    expect(parseAsOf('What changed yesterday?', NOW)).toMatchObject({ asOf: '2026-09-05T23:59:59.999Z', precision: 'day' })
    expect(parseAsOf('Where were we 3 weeks ago?', NOW)).toMatchObject({ asOf: '2026-08-16T12:00:00.000Z', precision: 'week' })
    expect(parseAsOf('What was the budget 2 months ago?', NOW)).toMatchObject({ asOf: '2026-07-06T23:59:59.999Z', precision: 'month' })
  })
})

describe('parseAsOf — the refusals (each of these would be a guess)', () => {
  it('no time words → null: the untimed default is the correct failure', () => {
    expect(parseAsOf('What is their budget?', NOW)).toBeNull()
    expect(parseAsOf('Who makes the buying decisions?', NOW)).toBeNull()
    expect(parseAsOf('', NOW)).toBeNull()
  })
  it('a month name without a temporal preposition is a NAME, not a time', () => {
    expect(parseAsOf('What did April say about the rollout?', NOW)).toBeNull()
    expect(parseAsOf('Is May the decision maker?', NOW)).toBeNull()
    expect(parseAsOf('Tell me about Jan Kowalski', NOW)).toBeNull()
  })
  it('events are not times', () => {
    expect(parseAsOf('What was the budget before the proposal?', NOW)).toBeNull()
    expect(parseAsOf('What changed after the demo?', NOW)).toBeNull()
  })
  // CORRECTED, M37 2026-09-07. This test's NAME stated the guarantee and its
  // BODY pinned the violation: it asserted that "What will the budget be in
  // December?" resolves to 2025-12-31, with an inline comment rationalising it
  // as "the last December that happened". So the app answered a question about
  // the future with a confident claim about ten months earlier, and the suite
  // called that correct — while the module header separately claimed the
  // future was dropped. The name, the header and the behaviour disagreed, and
  // the two prose documents agreed with each other rather than with the code.
  it('the future is not answerable from validity windows', () => {
    const now = new Date('2026-09-06T12:00:00.000Z')
    expect(parseAsOf('What will the budget be in December?', now)).toBeNull()
    expect(parseAsOf('Are we going to close in November?', now)).toBeNull()
    expect(parseAsOf('What happens in December 2027?', NOW)).toBeNull()
    expect(parseAsOf('What is planned for Q4 2026?', NOW)).toBeNull()
    // the past form of the same words still works: the marker decides, not the month
    expect(parseAsOf('What was the budget in December?', now)).toMatchObject({ asOf: '2025-12-31T23:59:59.999Z' })
  })
  it('ambiguous numeric dates are not parsed', () => {
    expect(parseAsOf('What happened on 6/7?', NOW)).toBeNull()
  })
  it('context is never consulted: the same words give the same moment regardless of anything but the clock', () => {
    const a = parseAsOf('what was the budget in June?', NOW)
    const b = parseAsOf('WHAT WAS THE BUDGET IN JUNE?', NOW)
    expect(a).toEqual(b)
  })
})
