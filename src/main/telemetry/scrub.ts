// M29 A1.0 — the scrubber. P0 for Workstream A: nothing leaves the machine
// (telemetry, support bundle, diagnostics zip) and nothing is written to the
// local log without passing through `scrub()` first.
//
// WHY THIS EXISTS. The Phase 0 audit (docs/M29-audit.md §1.4, §1.7) found
// that no redaction of any kind existed anywhere in the app, and that every
// stack trace and every path field carried the Windows username via
// `C:\Users\<name>\…`. Building telemetry on top of that would have shipped
// the founder's — and every user's — account name in every crash report.
//
// DESIGN RULES.
// - Pure: no Electron import, so it runs under plain vitest and inside any
//   process. The OS-specific values (home dir, username) are injected via
//   `createScrubber`; the default export uses `node:os`.
// - Applied by construction, not by callers remembering: the telemetry event
//   builder, the log writer and the bundle builders call this. There is no
//   "trusted" path that skips it.
// - Specific rules first, generic last, so a key inside a path inside a URL
//   still comes out fully redacted.
// - The username is redacted ONLY where it is anchored to a path
//   (`…\Users\<name>\…`, `/home/<name>/`, the literal home directory). It is
//   deliberately NOT replaced as a bare word: on this dev machine the
//   username is literally "User", and a bare-word rule would have mangled
//   every sentence containing the word. Emails and paths are where a
//   username actually leaks; that is what the tests prove.
// - Never throws. A scrubber that can fail is a scrubber callers will wrap
//   in try/catch and skip.

import { homedir as osHomedir, userInfo } from 'node:os'

export interface ScrubberOptions {
  /** The OS home directory, e.g. `C:\Users\jane` or `/Users/jane`. */
  homedir?: string
  /** The OS account name, e.g. `jane`. Only used anchored to a path. */
  username?: string
  /** Hard cap on any single string; longer input is truncated with a marker. */
  maxLength?: number
}

export interface Scrubber {
  /** Redact one string. Always returns a string; never throws. */
  (text: unknown): string
  /** Redact every string inside an arbitrary value (objects/arrays walked, depth-limited). */
  deep<T>(value: T): T
}

const DEFAULT_MAX_LENGTH = 4096
const MAX_DEPTH = 8

// --- Secret shapes -----------------------------------------------------------
// Provider key prefixes the app actually stores (src/main/ai-keys.ts) plus the
// generic shapes any of them could take. Order: the specific prefixes first,
// then JWTs, then bearer tokens, then the generic long-token heuristic.
const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, '<redacted-key>'], // Anthropic
  [/\bsk-or-[A-Za-z0-9_-]{16,}/g, '<redacted-key>'], // OpenRouter
  [/\bsk-proj-[A-Za-z0-9_-]{16,}/g, '<redacted-key>'], // OpenAI project keys
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '<redacted-key>'], // OpenAI legacy
  [/\bgsk_[A-Za-z0-9_-]{16,}/g, '<redacted-key>'], // Groq
  [/\bAIza[0-9A-Za-z_-]{20,}/g, '<redacted-key>'], // Google AI Studio
  [/\bnvapi-[A-Za-z0-9_-]{16,}/g, '<redacted-key>'], // NVIDIA NIM
  [/\bcsk-[A-Za-z0-9_-]{16,}/g, '<redacted-key>'], // Cerebras
  [/\bpplx-[A-Za-z0-9_-]{16,}/g, '<redacted-key>'], // Perplexity (via OpenRouter-compatible)
  [/\bxai-[A-Za-z0-9_-]{16,}/g, '<redacted-key>'], // xAI
  [/\bGOCSPX-[A-Za-z0-9_-]{10,}/g, '<redacted-key>'], // Google OAuth client secret shape
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '<jwt>'], // JWT (Supabase session / anon key)
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <redacted>'], // Authorization headers
  [
    /\b(api[_-]?key|apikey|token|secret|password|passwd|pwd)(["']?\s*[=:]\s*)["']?[^\s"'&,;]{6,}/gi,
    '$1$2<redacted>'
  ], // key=value and "key": "value" leaks
  [/\b[A-Fa-f0-9]{40}\b/g, '<hex40>'], // Deepgram key shape (also git SHAs — harmless to redact)
  [/\b[A-Za-z0-9_-]{48,}\b/g, '<token>'], // any long opaque token — secrets far more often than not
  // B3 (M29 sweep): Mistral is a first-class registered provider whose key
  // is a bare 32-char alphanumeric — it matches NONE of the shapes above
  // (not 40-hex, not 48+, and `\bapi[_-]?key` cannot match inside
  // MISTRAL_API_KEY because `_` gives no word boundary). No concrete egress
  // path was found for it, which is exactly why it is cheap to close now
  // rather than after one appears.
  [/\bMISTRAL_API_KEY\s*[=:]\s*["']?[A-Za-z0-9]{24,}/gi, 'MISTRAL_API_KEY=<redacted-key>']
]

// --- Identity shapes ---------------------------------------------------------
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const IPV4 = /\b(?!127\.0\.0\.1\b)(?!0\.0\.0\.0\b)(?:\d{1,3}\.){3}\d{1,3}\b/g
const URL_QUERY = /(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi

// --- User-profile paths ------------------------------------------------------
// Every spelling a stack trace or a path field can take:
//   C:\Users\name\…   C:/Users/name/…   C:\\Users\\name\\…  (JSON-escaped)
//   file:///C:/Users/name/…   \\?\C:\Users\name   (long-path prefix)
//   /Users/name/…  (macOS)    /home/name/…  (Linux)
// The drive letter anchor avoids matching the word "Users" in prose.
// Case-insensitive: Windows paths are, and `d:\users\…` is a real spelling.
const WIN_PROFILE = /([A-Za-z]:[\\/]+Users[\\/]+)([^\\/\s"'<>|:*?]+)/gi
// B3 (M29 sweep): a UNC path has no drive letter, so WIN_PROFILE cannot see
// it, and both the server and the share name are organisation identifiers.
// Dropped from the sweep as "no concrete egress path today"; closed here
// because the fix is one rule and the next path is not announced.
const UNC_PREFIX = /\\\\([^\\/\s"'<>|:*?]+)\\([^\\/\s"'<>|:*?]+)/g
const MAC_PROFILE = /((?:^|[\s"'(=:/])\/Users\/)([^\\/\s"'<>|:*?]+)/g
const LINUX_PROFILE = /((?:^|[\s"'(=:/])\/home\/)([^\\/\s"'<>|:*?]+)/g

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Build a regex that matches the literal home directory in either slash style, any case. */
function homedirPattern(homedir: string): RegExp | null {
  const trimmed = homedir.trim().replace(/[\\/]+$/, '')
  if (!trimmed) return null
  // Split on either separator and rejoin with a class that accepts one or more
  // of either (so `C:\\Users\\x` JSON-escaped form also matches).
  const parts = trimmed.split(/[\\/]+/).map(escapeRegExp)
  // Trailing lookahead: `C:\Users\jo` must not half-match `C:\Users\joanna`.
  // BUG-093: this used to end `(?=[\\/]|$)` — a slash-only lookahead — so a
  // quote or a space after the path defeated it. `EPERM scandir 'C:\\Users\\Nir Tsur'`
  // and `JSON.stringify({dir})` both leaked. The rule is an EXACT literal, so it
  // does not need a slash to know where it ends: it only needs to refuse a
  // longer name (`C:\\Users\\Nir` must not match inside `C:\\Users\\Nirvana`).
  // A non-alphanumeric boundary does exactly that and accepts quote, space,
  // comma and end-of-string.
  return new RegExp(`${parts.join('[\\\\/]+')}(?![A-Za-z0-9])`, 'gi')
}

export function createScrubber(options: ScrubberOptions = {}): Scrubber {
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH
  const homeRe = options.homedir ? homedirPattern(options.homedir) : null
  const username = options.username?.trim() ?? ''
  // Username anchored to a path separator on both sides, e.g. `\User\` or
  // `/User/`, any case. Catches spellings the profile regexes miss (a custom
  // profile root like `D:\Profiles\jane\`). NOT applied as a bare word.
  // BUG-093, same fix as homedirPattern: an exact literal needs a
  // word boundary, not a slash. `(?![A-Za-z0-9])` still refuses `Nir Tsur`
  // inside `Nir Tsurson` while allowing a quote/space/comma/end to close it.
  const userPathRe =
    username.length > 0
      ? new RegExp(`([\\\\/]+)${escapeRegExp(username)}(?![A-Za-z0-9])`, 'gi')
      : null

  const scrubString = (input: string): string => {
    let s = input
    try {
      for (const [re, rep] of SECRET_PATTERNS) s = s.replace(re, rep)
      s = s.replace(EMAIL, '<email>')
      // ORDER MATTERS, and getting it wrong was half of BUG-093.
      //
      // The exact-literal rules (this machine's real homedir and username, from
      // os.userInfo()) are the MOST precise thing we have, and they used to run
      // LAST — after WIN_PROFILE had already rewritten `\Nir` to `\<user>`, so
      // the literal `\Nir Tsur` they were searching for no longer existed. The
      // generic rule destroyed the exact rule's input, which is why the A1
      // red-check's "two independent mechanisms" were not independent.
      //
      // Exact first, generic second. The generic rules remain deliberately
      // conservative (their capture class still stops at whitespace) because
      // they fire on OTHER people's names in paths, where there is no literal
      // to anchor on and over-redaction would eat prose.
      if (homeRe) s = s.replace(homeRe, '<home>')
      if (userPathRe) s = s.replace(userPathRe, '$1<user>')
      s = s.replace(WIN_PROFILE, '$1<user>')
      s = s.replace(MAC_PROFILE, '$1<user>')
      s = s.replace(LINUX_PROFILE, '$1<user>')
      s = s.replace(UNC_PREFIX, '\\\\<host>\\<share>')
      s = s.replace(URL_QUERY, '$1?<query>')
      s = s.replace(UUID, '<uuid>')
      s = s.replace(IPV4, '<ip>')
    } catch {
      // A regex engine failure (catastrophic backtracking guard, etc.) must
      // never leak the raw input: fall back to the safest thing we have.
      return '<unscrubbable>'
    }
    if (s.length > maxLength)
      s = `${s.slice(0, maxLength)}…<truncated ${s.length - maxLength} chars>`
    return s
  }

  const scrub = ((text: unknown): string => {
    if (typeof text === 'string') return scrubString(text)
    if (text instanceof Error) return scrubString(text.stack ?? `${text.name}: ${text.message}`)
    if (text === null || text === undefined) return ''
    try {
      return scrubString(typeof text === 'object' ? JSON.stringify(text) : String(text))
    } catch {
      return '<unscrubbable>'
    }
  }) as Scrubber

  const deep = <T>(value: T, depth = 0): T => {
    if (depth > MAX_DEPTH) return '<depth-limit>' as unknown as T
    if (typeof value === 'string') return scrubString(value) as unknown as T
    if (value instanceof Error) return scrub(value) as unknown as T
    if (Array.isArray(value)) return value.map((v) => deep(v, depth + 1)) as unknown as T
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[scrubString(k)] = deep(v, depth + 1)
      }
      return out as T
    }
    return value
  }
  scrub.deep = deep

  return scrub
}

/** Resolve this machine's identity values without ever throwing (userInfo can throw on exotic setups). */
function localIdentity(): Pick<ScrubberOptions, 'homedir' | 'username'> {
  let homedir: string | undefined
  let username: string | undefined
  try {
    homedir = osHomedir()
  } catch {
    /* leave undefined — the path rules still apply */
  }
  try {
    username = userInfo().username
  } catch {
    /* same */
  }
  return { homedir, username }
}

/**
 * A scrubber bound to THIS machine's identity, with the other options
 * overridable. Use this rather than `createScrubber({...})` directly whenever
 * the scrubber must still redact the local user — a bare `createScrubber` has
 * no homedir or username and silently redacts less.
 *
 * The reason it exists: the support bundle needs the same redaction rules with
 * NO length cap (it scrubs whole documents, not single fields), and building
 * that with `createScrubber({ maxLength })` would have dropped the local
 * identity rules entirely — a quieter version of the bug it was fixing.
 */
export function createLocalScrubber(options: Omit<ScrubberOptions, 'homedir' | 'username'> = {}): Scrubber {
  return createScrubber({ ...localIdentity(), ...options })
}

/** The app-wide scrubber, bound to this machine's home directory and username. */
export const scrub: Scrubber = createScrubber(localIdentity())
