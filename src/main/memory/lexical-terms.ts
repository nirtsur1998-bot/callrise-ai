// M36 Stage 3, item 2 — the lexical channel's question half.
//
// MiniLM-384 embeds MEANING, and a proper noun has almost none to embed: the
// retrieval harness (retrieval-eval-corpus.ts, the `pn-*` block) showed
// "Who is Sam Okafor?" retrieving NOTHING and "What happens with the Tellus
// contract?" retrieving a Lisbon goal, with the exact statement sitting in
// the store. A name is a string to match, not a concept to approximate, so
// the store grew an FTS5 index (migration 5) and this module decides which
// words of a question are worth matching by string.
//
// The rule is deliberately dumb and deterministic: every word that is not a
// function word. No stemming, no prefix matching, no guessing — "Priyanka"
// must never match "Priya" (lexical-channel.test.ts pins it). BM25 inside
// FTS5 then does the weighting: a rare token ("okafor") outweighs a common
// one ("calls") without this module having to know which is which.
const STOP_WORDS = new Set([
  // question words
  'what', 'when', 'where', 'who', 'whom', 'whose', 'why', 'how', 'which',
  // auxiliaries and modals
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'done',
  'have', 'has', 'had', 'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must',
  // articles, conjunctions, prepositions
  'the', 'a', 'an', 'and', 'or', 'not', 'no', 'but', 'if', 'then', 'than', 'so', 'as',
  'of', 'in', 'on', 'at', 'to', 'for', 'from', 'by', 'with', 'about', 'into', 'over', 'under',
  'after', 'before', 'between', 'through', 'during', 'without', 'within', 'up', 'down', 'out', 'off',
  'vs', 'via', 'per',
  // pronouns and determiners
  'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their', 'theirs',
  'we', 'us', 'our', 'ours', 'you', 'your', 'yours', 'i', 'me', 'my', 'mine',
  'he', 'him', 'his', 'she', 'her', 'hers', 'there', 'here', 'any', 'some', 'all', 'each', 'every',
  'both', 'more', 'most', 'much', 'many', 'other', 'such', 'own', 'same', 'just', 'also', 'very',
  'too', 'again', 'still', 'ever', 'never', 'always', 'anything', 'something', 'nothing', 'everything',
  // verbs that carry a question, not a subject
  'get', 'got', 'know', 'tell', 'say', 'said', 'says', 'think', 'want', 'wants', 'need', 'needs',
  'use', 'used', 'like', 'mean', 'means', 'happen', 'happens', 'happened', 'give', 'make', 'made',
  'go', 'going', 'come', 'let', 'see', 'look', 'find', 'remember', 'recall', 'please', 'thanks'
])

/** Minimum token length. "Q1" and "2" both fall under it on purpose: a lone
 *  digit matches half the corpus ("SOC 2", "2 seconds", "20 percent"). */
const MIN_TERM_LENGTH = 3

/**
 * The words of `question` worth matching by string — lower-cased, function
 * words removed, duplicates collapsed, in the order they appeared. Empty for
 * a question made only of function words ("what is it?"), in which case the
 * caller skips the lexical channel entirely.
 */
export function lexicalTerms(question: string): string[] {
  const seen = new Set<string>()
  for (const raw of question.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < MIN_TERM_LENGTH) continue
    if (STOP_WORDS.has(raw)) continue
    seen.add(raw)
  }
  return [...seen]
}

/**
 * An FTS5 MATCH expression that matches ANY of the terms, each one quoted so
 * the FTS5 query language never sees an operator: a user typing "near" or
 * "not" gets a word, not a NEAR/NOT clause, and a stray quote (impossible
 * after tokenising, guarded anyway) is doubled rather than left to break the
 * query. Exact tokens only — no `*` prefix, so "priya" does not match
 * "priyanka".
 */
export function ftsMatchQuery(terms: ReadonlyArray<string>): string {
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')
}

/** Which of `terms` the statement actually contains, by the same
 *  tokenisation — so a result can say WHY it surfaced ("matched: okafor"). */
export function matchedTerms(statement: string, terms: ReadonlyArray<string>): string[] {
  const present = new Set(statement.toLowerCase().split(/[^\p{L}\p{N}]+/u))
  return terms.filter((t) => present.has(t))
}
