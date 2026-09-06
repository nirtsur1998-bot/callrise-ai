// M36 Stage 3 item 2 — the question half of the lexical channel. Determinism
// is the whole point: the same question always yields the same terms, and a
// term is never invented (no stemming, no prefixes, no synonyms).
import { describe, expect, it } from 'vitest'
import { ftsMatchQuery, lexicalTerms, matchedTerms } from '../lexical-terms'

describe('lexicalTerms', () => {
  it('keeps the words that could name something and drops the function words', () => {
    expect(lexicalTerms('Who is Sam Okafor?')).toEqual(['sam', 'okafor'])
    expect(lexicalTerms('What happens with the Tellus contract?')).toEqual(['tellus', 'contract'])
    expect(lexicalTerms('What do we know about Marseille?')).toEqual(['marseille'])
    expect(lexicalTerms('When does Priya want the SOC 2 report?')).toEqual(['priya', 'soc', 'report'])
  })

  it('a question made only of function words yields nothing — the channel stays silent', () => {
    expect(lexicalTerms('what is it?')).toEqual([])
    expect(lexicalTerms('')).toEqual([])
    expect(lexicalTerms('   ')).toEqual([])
  })

  it('lower-cases, de-duplicates, and drops tokens shorter than three characters', () => {
    expect(lexicalTerms('Tellus, TELLUS, tellus')).toEqual(['tellus'])
    expect(lexicalTerms('Q1 2 Q2 SOC')).toEqual(['soc'])
  })

  it('splits on every non-letter, non-digit character, including punctuation glued to a name', () => {
    expect(lexicalTerms("What's Okafor's role? (Globex)")).toEqual(['okafor', 'role', 'globex'])
  })
})

describe('ftsMatchQuery', () => {
  it('quotes every term and joins with OR — an FTS5 operator typed as a word stays a word', () => {
    expect(ftsMatchQuery(['near', 'okafor'])).toBe('"near" OR "okafor"')
  })
  it('doubles a stray double quote instead of letting it end the string', () => {
    expect(ftsMatchQuery(['a"b'])).toBe('"a""b"')
  })
  it('no terms → empty query (the store refuses to run it)', () => {
    expect(ftsMatchQuery([])).toBe('')
  })
})

describe('matchedTerms', () => {
  it('reports which of the question terms the statement contains, whole-token only', () => {
    expect(matchedTerms('Sam Okafor is the internal champion', ['sam', 'okafor', 'coo'])).toEqual(['sam', 'okafor'])
    expect(matchedTerms('Priyanka wants nothing', ['priya'])).toEqual([])
  })
})
