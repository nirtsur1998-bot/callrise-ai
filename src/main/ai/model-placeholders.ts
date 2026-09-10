/** BUG-163 — "the model said null, and we hired them."
 *
 *  A tool schema that declares an optional value as `type: ['string','null']`
 *  AND lists it in `required` puts the model in an impossible position when
 *  the honest answer is "there isn't one". Some providers emit the JSON
 *  literal `null` as intended; others coerce the field to its primary
 *  declared type and emit the four-character STRING "null". Both are the
 *  model saying the same thing. Only one of them survives a
 *  `typeof x === 'string' && x.trim()` guard.
 *
 *  This was found on screen: a call-detail banner reading "Detected null on
 *  this call" over a button offering "Create contact for null", from a
 *  persisted record `{ name: 'null', source: 'self-intro' }`. Nothing between
 *  the model and the CRM had any reason to object — "null" is a perfectly
 *  good string.
 *
 *  Sibling of BUG-162, where an enum's DESCRIPTION named a value the enum
 *  itself forbade. Both are the same shape: the model's literal answer
 *  colliding with the app's own value space. The general rule this file
 *  encodes — **a model's way of saying "nothing" must be read as nothing,
 *  in whatever form it arrives.** */

/** Compared against the answer lowercased, trimmed, and stripped of
 *  surrounding quotes/brackets — a model that has been told to return null
 *  will reach for one of these, or wrap one. Matched WHOLE, never as a
 *  substring: "Nunes", "Noneli" and "Anna Nullman" are real names, and a
 *  substring check would silently delete the person. */
const ABSENCE_WORDS = new Set([
  'null',
  'nil',
  'none',
  'undefined',
  'unknown',
  'unspecified',
  'not specified',
  'not provided',
  'not given',
  'not stated',
  'not mentioned',
  'not available',
  'unclear',
  'n/a',
  'na',
  'no name',
  'no name given',
  'empty',
  'blank',
  ''
])

/** True when a model's string answer is really a way of saying "nothing".
 *  Use on every free-text field a model is allowed to decline to fill. */
export function isAbsenceAnswer(raw: unknown): boolean {
  if (typeof raw !== 'string') return true
  const stripped = raw
    .trim()
    // Wrappers a model reaches for when it is quoting its own non-answer:
    // "null", 'null', `null`, (null), [null], <null>, {null}.
    .replace(/^[\s"'`([<{]+|[\s"'`)\]>}]+$/g, '')
    .trim()
    .toLowerCase()
  if (ABSENCE_WORDS.has(stripped)) return true
  // Punctuation-only answers ("-", "--", ".", "?") say nothing either.
  if (stripped.length > 0 && !/[\p{L}\p{N}]/u.test(stripped)) return true
  return stripped.length === 0
}

/** The trimmed answer, or null when the model was really saying "nothing".
 *  `maxLen` caps a runaway field the same way the call sites already did. */
export function modelStringOrNull(raw: unknown, maxLen = 200): string | null {
  if (isAbsenceAnswer(raw)) return null
  return (raw as string).trim().slice(0, maxLen)
}

/**
 * M39 — the SECOND way a model declines to name someone, and the one
 * `isAbsenceAnswer` cannot see.
 *
 * MEASURED on the founder's profile 2026-09-10: 47 calls carry a `self-intro`
 * speaker identity, 30 distinct names. Twenty-nine are real people. One is the
 * word **"someone"**, stored six times as a person's name, and it is why six
 * calls read "someone" where a client's name belongs. `isAbsenceAnswer` caught
 * 0 of those 6, because "someone" is not a way of saying *nothing* — it is a
 * way of saying *a person, but I could not tell you which*. Different sentence,
 * different list.
 *
 * SPECIES 86 — a word list catches every example it was built from, which reads
 * as coverage. Two things are done about that here rather than hoped:
 *
 *  1. The list is a CATEGORY, not a collection of sightings: generic references
 *     to a person (role, pronoun-ish noun, anonymisation placeholder). "someone"
 *     is one member, added last rather than first.
 *  2. Articles are stripped before matching, so "the buyer" and "buyer" cost one
 *     entry, not two, and an unseen "an attendee" is covered by an entry written
 *     for "attendee".
 *
 * AND WHAT IT STILL CANNOT TELL YOU: the corpus contains exactly ONE distinct
 * escape, so this measures that the fix catches the one real case. It does NOT
 * establish a low escape rate for the rest — that number is UNKNOWN, not zero.
 *
 * DELIBERATELY ABSENT: "guy", "lady", "gentleman". A wrong strip deletes a real
 * person, Guy is a real first name, and these are rare as model placeholders —
 * the multi-word forms ("a guy", "some guy") are unambiguous and are listed.
 */
const GENERIC_PERSON_WORDS = new Set([
  // "a person, but I can't say which"
  'someone',
  'somebody',
  'person',
  'individual',
  'human',
  'some guy',
  'a guy',
  'some person',
  'other person',
  'other party',
  'other speaker',
  'second speaker',
  'first speaker',
  'speaker',
  // roles this app talks about — the model answering with the SLOT, not the filler
  'client',
  'buyer',
  'customer',
  'caller',
  'callee',
  'prospect',
  'lead',
  'contact',
  'guest',
  'participant',
  'attendee',
  'rep',
  'sales rep',
  'salesperson',
  'representative',
  'agent',
  'user',
  'member',
  // anonymisation placeholders
  'anonymous',
  'anonymous caller',
  'unidentified',
  'unidentified speaker',
  'unidentified caller',
  'unnamed',
  'unnamed speaker',
  'no one',
  'nobody',
  'undisclosed',
  'redacted',
  'withheld',
  'name withheld',
  'not applicable',
  'not a name',
  'no speaker',
  'test',
  'test user',
  'example'
])

/** "speaker 0", "speaker 1", "spk2", "channel 1", "participant 3" — a diarizer
 *  label handed back as if it were a name. */
const SPEAKER_LABEL_RE = /^(speaker|spk|channel|ch|participant|party|caller)\s*[-_#]?\s*\d+$/

/**
 * True when a model's answer to "what is this person's NAME" is not a name.
 *
 * Use ONLY on name fields. It is deliberately not folded into
 * `isAbsenceAnswer`, which every free-text field calls: "someone" is a perfectly
 * good answer to a question that is not "who is this", and widening the global
 * absence vocabulary to fix a name field would change fields nobody looked at.
 */
export function isNonName(raw: unknown): boolean {
  if (isAbsenceAnswer(raw)) return true
  const stripped = String(raw)
    .trim()
    .replace(/^[\s"'`([<{]+|[\s"'`)\]>}]+$/g, '')
    .replace(/[.,!?]+$/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
  // Articles first, so one entry covers "buyer", "the buyer" and "a buyer".
  const bare = stripped.replace(/^(the|a|an|this|that|my|our)\s+/, '')
  if (GENERIC_PERSON_WORDS.has(stripped) || GENERIC_PERSON_WORDS.has(bare)) return true
  if (SPEAKER_LABEL_RE.test(bare)) return true
  return false
}
