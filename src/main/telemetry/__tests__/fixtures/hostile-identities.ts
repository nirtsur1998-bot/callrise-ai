// M29 FIX B / BUG-093 — the hostile identity fixture set.
//
// STANDING RULE (founder, 2026-08-24): "Every privacy test from now on runs
// against a hostile fixture set, not this machine's happy accident."
//
// The bug that forced this existed for the whole milestone and was invisible
// to 24 scrubber tests, for a purely environmental reason: **this dev machine's
// Windows account is literally named `User`** — a single word, no space, no
// punctuation, no non-ASCII. Every test therefore exercised the easiest
// possible identity, and a name with a SPACE in it leaked its tail through
// three separate rules at once.
//
// So: no privacy suite may assert against one identity again. Each entry below
// exists to break something specific, and the `breaks` field says what, so a
// future reader can tell a deliberate case from decoration.
//
// USAGE. For every fixture, a privacy test must show BOTH halves:
//   1. the raw identity really is present in the input (the control), and
//   2. it is absent from the output.
// A test that only checks (2) cannot tell "scrubbed" from "never there".

export interface HostileIdentity {
  /** Short id for test names. */
  id: string
  /** The OS account name (`userInfo().username`). */
  username: string
  /** The home directory that account would have. */
  homedir: string
  /** What this entry is designed to break. */
  breaks: string
}

export const HOSTILE_IDENTITIES: readonly HostileIdentity[] = [
  {
    id: 'space',
    username: 'Nir Tsur',
    homedir: 'C:\\Users\\Nir Tsur',
    breaks:
      'BUG-093 itself. WIN_PROFILE negates \\s so its capture stops at the space; the ' +
      'homedir and username rules both used a slash-only lookahead. All three failed together.'
  },
  {
    id: 'apostrophe',
    username: "O'Brien",
    homedir: "C:\\Users\\O'Brien",
    breaks:
      'Regex-escaping. An unescaped apostrophe is also a quote character, which is what ' +
      'terminates several of the surrounding shapes (EPERM messages, JSON).'
  },
  {
    id: 'non-ascii-space',
    username: 'José García',
    homedir: 'C:\\Users\\José García',
    breaks: 'Non-ASCII AND a space together — accents plus the BUG-093 shape in one name.'
  },
  {
    id: 'cjk',
    username: '李明',
    homedir: 'C:\\Users\\李明',
    breaks: 'No Latin characters at all. Any rule assuming [A-Za-z] boundaries fails here.'
  },
  {
    id: 'common-word',
    username: 'User',
    breaks:
      "This machine's happy accident, kept DELIBERATELY. It is also a common English word, " +
      'so it doubles as the over-redaction control: prose containing "User" must survive.',
    homedir: 'C:\\Users\\User'
  },
  {
    id: 'prefix-short',
    username: 'Nir',
    homedir: 'C:\\Users\\Nir',
    breaks:
      'Prefix collision with `Nir Tsur`: the short name must not half-match the long one, ' +
      'and redacting `Nir` must not leave a dangling ` Tsur`.'
  },
  {
    id: 'single-char',
    username: 'a',
    homedir: 'C:\\Users\\a',
    breaks: 'Maximal false-positive pressure — a one-character name appears inside every word.'
  },
  {
    id: 'dotted',
    username: 'Administrator.DOMAIN',
    homedir: 'C:\\Users\\Administrator.DOMAIN',
    breaks: 'A dot in the name — the domain-joined shape, and `.` is a regex metacharacter.'
  },
  {
    id: 'long',
    username: 'A'.repeat(200),
    homedir: `C:\\Users\\${'A'.repeat(200)}`,
    breaks: 'Length, and its interaction with the scrubber\u2019s 4096-char cap.'
  },
  // Founder's additions, 2026-09-05 (BUG-091 fix-shape item 4, answered).
  {
    id: 'hyphen-apostrophe',
    username: "O'Neill-Smith",
    homedir: "C:\\Users\\O'Neill-Smith",
    breaks:
      'A hyphen AND an apostrophe together: the hyphen is a word boundary to a naive rule, ' +
      'so half the name can match on its own; the apostrophe is the quote hazard again.'
  },
  {
    id: 'common-word-admin',
    username: 'Admin',
    homedir: 'C:\\Users\\Admin',
    breaks:
      "A second account name that is also an ordinary English word (this machine's `User` is " +
      'the first). Over-redaction pressure: prose mentioning admins must not be scrubbed.'
  },
  {
    id: 'corporate-dot',
    username: 'nir.tsur',
    homedir: 'C:\\Users\\nir.tsur',
    breaks:
      'A dot that is NOT a domain — the corporate first.last shape, and the one most likely ' +
      'to be half-matched by a rule written against Administrator.DOMAIN.'
  }
] as const

/**
 * The shapes a username actually reaches a log or a bundle in. BUG-093 leaked
 * through three of these while the first one (a plain path) was caught — which
 * is exactly why a single-shape test was not enough.
 */
export function identityShapes(homedir: string): { label: string; text: string }[] {
  return [
    { label: 'plain path, separator follows', text: `ENOENT open ${homedir}\\Desktop\\a.txt` },
    { label: 'JSON.stringify of an object', text: JSON.stringify({ dir: homedir }) },
    { label: 'quoted at end (EPERM/scandir shape)', text: `EPERM scandir '${homedir}'` },
    { label: 'prose, space follows', text: `profile root is ${homedir} and it is fine` },
    { label: 'end of string, no trailing anything', text: `cwd=${homedir}` },
    { label: 'inside a longer path', text: `${homedir}\\AppData\\Roaming\\sales-os\\memory.db` }
  ]
}

/** UNC paths carry a server and share name and have no drive letter to anchor on. */
export const UNC_PATHS = [
  '\\\\ACME-FS01\\Deals\\2026\\acme-contract.pdf',
  '\\\\fileserver.corp.local\\Shared\\Sales\\pipeline.xlsx'
] as const
