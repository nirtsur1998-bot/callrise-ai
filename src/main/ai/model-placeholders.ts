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
