// M36 Stage 3 item 5, step 4 — the question parser: WHEN is the user asking
// about? The founder's rule, held hard: "From the words typed, never guessed,
// same discipline as client inference. An unparsed question getting no asOf
// is the correct failure, and inferring a time from context would
// reintroduce the confident-wrong-answer problem in a new place."
//
// So this module is a small deterministic grammar over the question text and
// nothing else. `now` is passed in only to resolve a bare month or quarter to
// its most recent past occurrence — a convention, stated, not an inference
// from conversation context. Anything it does not recognise returns null and
// retrieval runs untimed, exactly as today.
//
// Deliberately NOT recognised (each would be a guess):
//   - a month name without a temporal preposition — "What did April say?"
//     names a person; only "in April", "during April", "as of April 3" etc.
//     read as a time;
//   - events as times — "before the proposal", "after the demo" (an event's
//     date is a fact to look up, not a word to parse);
//   - the future — "in December" when December has not happened resolves to
//     a moment after now and is dropped: a validity window cannot answer
//     what will be true;
//   - numeric dates with ambiguous order — "6/7" is June 7th or 6th July.

export interface AsOfQuestion {
  /** the moment retrieval should answer as of (ISO, UTC) */
  asOf: string
  /** the words that produced it, for the notice ("read as ...") */
  phrase: string
  /** how coarse the words were; a month resolves to its END, so the answer is
   *  "what was true by the end of June" */
  precision: 'day' | 'week' | 'month' | 'quarter' | 'year'
}

const MONTHS: Record<string, number> = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3, may: 4, june: 5, jun: 5,
  july: 6, jul: 6, august: 7, aug: 7, september: 8, sep: 8, sept: 8, october: 9, oct: 9,
  november: 10, nov: 10, december: 11, dec: 11
}
const MONTH_RE = '(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)'
/** a month must be introduced as a TIME, never bare */
const PREP = '(?:in|on|during|as of|back in|since|from|by|last|at the end of|end of|at the start of|start of|early|late|mid)'
const DAY = '(\\d{1,2})(?:st|nd|rd|th)?'
const YEAR = '(\\d{4})'

const endOfDay = (y: number, m: number, d: number): Date => new Date(Date.UTC(y, m, d, 23, 59, 59, 999))
const endOfMonth = (y: number, m: number): Date => new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999))
const endOfQuarter = (y: number, q: number): Date => endOfMonth(y, q * 3 + 2)
const endOfYear = (y: number): Date => endOfMonth(y, 11)

/** The most recent occurrence of `month` that is not after `now`'s month. */
function yearForMonth(month: number, now: Date): number {
  return month <= now.getUTCMonth() ? now.getUTCFullYear() : now.getUTCFullYear() - 1
}
function yearForQuarter(q: number, now: Date): number {
  const currentQ = Math.floor(now.getUTCMonth() / 3)
  return q <= currentQ ? now.getUTCFullYear() : now.getUTCFullYear() - 1
}

function result(at: Date, phrase: string, precision: AsOfQuestion['precision'], now: Date): AsOfQuestion | null {
  if (Number.isNaN(at.getTime()) || at.getTime() > now.getTime()) return null
  return { asOf: at.toISOString(), phrase: phrase.trim(), precision }
}

/**
 * Parses the moment a question asks about, or null. Pure; `now` is the only
 * clock. First recognised form wins, in the order below (most specific
 * first), so "on June 10 2025" is a day, not a month.
 */
export function parseAsOf(question: string, now: Date): AsOfQuestion | null {
  const q = question.toLowerCase()

  // ISO date: 2026-06-15
  let m = q.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)
  if (m) return result(endOfDay(+m[1], +m[2] - 1, +m[3]), m[0], 'day', now)

  // <prep> <month> <day>[,] [<year>]   |   <prep> <day> [of] <month> [<year>]
  m = q.match(new RegExp(`\\b${PREP}\\s+${MONTH_RE}\\s+${DAY}(?:,?\\s+${YEAR})?\\b`))
  if (m) {
    const month = MONTHS[m[1]]
    const year = m[3] ? +m[3] : yearForMonth(month, now)
    return result(endOfDay(year, month, +m[2]), m[0], 'day', now)
  }
  m = q.match(new RegExp(`\\b${PREP}\\s+(?:the\\s+)?${DAY}\\s+(?:of\\s+)?${MONTH_RE}(?:,?\\s+${YEAR})?\\b`))
  if (m) {
    const month = MONTHS[m[2]]
    const year = m[3] ? +m[3] : yearForMonth(month, now)
    return result(endOfDay(year, month, +m[1]), m[0], 'day', now)
  }

  // <prep> <month> [<year>]  → the END of that month
  m = q.match(new RegExp(`\\b${PREP}\\s+${MONTH_RE}(?:,?\\s+${YEAR})?\\b`))
  if (m) {
    const month = MONTHS[m[1]]
    const year = m[2] ? +m[2] : yearForMonth(month, now)
    return result(endOfMonth(year, month), m[0], 'month', now)
  }

  // quarters: in Q2, Q2 2026, last quarter
  m = q.match(/\bq([1-4])(?:\s+(\d{4}))?\b/)
  if (m) {
    const quarter = +m[1] - 1
    const year = m[2] ? +m[2] : yearForQuarter(quarter, now)
    return result(endOfQuarter(year, quarter), m[0], 'quarter', now)
  }
  if (/\blast quarter\b/.test(q)) {
    const currentQ = Math.floor(now.getUTCMonth() / 3)
    const y = currentQ === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear()
    return result(endOfQuarter(y, (currentQ + 3) % 4), 'last quarter', 'quarter', now)
  }

  // years: in 2025, last year
  m = q.match(/\b(?:in|during|as of|back in|since|by|end of)\s+(\d{4})\b/)
  if (m) return result(endOfYear(+m[1]), m[0], 'year', now)
  if (/\blast year\b/.test(q)) return result(endOfYear(now.getUTCFullYear() - 1), 'last year', 'year', now)

  // relative: last month, last week, yesterday, N days/weeks/months ago
  if (/\blast month\b/.test(q)) return result(endOfMonth(now.getUTCFullYear(), now.getUTCMonth() - 1), 'last month', 'month', now)
  if (/\blast week\b/.test(q)) return result(new Date(now.getTime() - 7 * 86400000), 'last week', 'week', now)
  if (/\byesterday\b/.test(q)) {
    const y = new Date(now.getTime() - 86400000)
    return result(endOfDay(y.getUTCFullYear(), y.getUTCMonth(), y.getUTCDate()), 'yesterday', 'day', now)
  }
  m = q.match(/\b(\d{1,3})\s+(day|week|month)s?\s+ago\b/)
  if (m) {
    const n = +m[1]
    const unit = m[2]
    if (unit === 'month') {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, now.getUTCDate(), 23, 59, 59, 999))
      return result(d, m[0], 'month', now)
    }
    const ms = n * (unit === 'week' ? 7 : 1) * 86400000
    return result(new Date(now.getTime() - ms), m[0], unit === 'week' ? 'week' : 'day', now)
  }

  return null
}
