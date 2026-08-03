// Update-acceptance policy (§5.3).
//
// An auto-updater is the most dangerous code in a desktop app: it is the one
// component whose whole job is to download a file and execute it with the
// user's privileges. Everything here is written to DEFAULT DENY, because the
// canonical failure in this class does not look like an attack — it looks like
// a bug.
//
// In the 2020 Doyensec bypass of electron-updater, an update filename
// containing a single quote caused a PowerShell parse error, the signature
// check returned null instead of throwing, the caller read null as "no problem
// found", and the update installed anyway. Nobody defeated the cryptography.
// The check simply failed, and failing was interpreted as passing.
//
// So: every function below returns an explicit verdict, never a boolean that
// could be undefined, and every unparseable input is a REJECT rather than a
// pass-through. `latest.yml` is attacker-controlled input — it is fetched over
// the network before anything about it has been verified — and is treated
// throughout as exactly that.

export type UpdateVerdict = { ok: true } | { ok: false; reason: string }

const reject = (reason: string): UpdateVerdict => ({ ok: false, reason })

/** The scaffold placeholder electron-vite ships with. Shipping an updater
 *  pointed at a domain you do not control is a supply-chain compromise waiting
 *  for someone to register it. */
const PLACEHOLDER_HOSTS = new Set(['example.com', 'www.example.com', 'example.org', 'localhost'])

/**
 * Is this feed safe to fetch update metadata from at all?
 *
 * Checked before any request is made, because the first fetch is itself the
 * exposure: an attacker who controls the feed controls what we install.
 */
export function isTrustedFeed(rawUrl: string | undefined | null): UpdateVerdict {
  if (!rawUrl || !rawUrl.trim()) return reject('no update feed is configured')
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return reject('the update feed URL is not a valid URL')
  }
  if (url.protocol !== 'https:') {
    return reject('the update feed must be https — plain http can be rewritten in transit')
  }
  if (PLACEHOLDER_HOSTS.has(url.hostname)) {
    return reject(`the update feed is still the scaffold placeholder (${url.hostname})`)
  }
  return { ok: true }
}

/** A strictly-parsed version. Anything unparseable is rejected rather than
 *  coerced, because a version we cannot read is one we cannot compare. */
interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** Present for 1.2.3-beta.1. A prerelease always sorts BELOW its release. */
  prerelease: string | null
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function parseVersion(value: unknown): ParsedVersion | null {
  if (typeof value !== 'string') return null
  const m = VERSION_RE.exec(value.trim())
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null
  }
}

/** −1, 0 or 1. Prerelease sorts below the same release, per semver. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === null) return 1 // 1.0.0 > 1.0.0-beta
  if (b.prerelease === null) return -1
  return a.prerelease < b.prerelease ? -1 : 1
}

/**
 * Characters that must never appear in an update filename.
 *
 * This is the Doyensec bug's actual surface. The filename from `latest.yml`
 * reaches a shell on Windows, so a quote, a backtick, a `$`, a `;` or a newline
 * is either command injection or — more likely, and more dangerous — a parse
 * error that makes a validation step return nothing at all. Path separators and
 * `..` are here too: an updater that writes outside its own staging directory
 * is a file-overwrite primitive.
 */
const UNSAFE_FILENAME = /['"`$;|&<>\\/\n\r\t\0]|\.\./

export function isSafeFilename(value: unknown): UpdateVerdict {
  if (typeof value !== 'string' || value.trim() === '') return reject('the update has no filename')
  if (value.length > 255) return reject('the update filename is implausibly long')
  if (UNSAFE_FILENAME.test(value)) {
    return reject(`the update filename contains an unsafe character: ${JSON.stringify(value)}`)
  }
  return { ok: true }
}

/** SHA-512, base64: 64 bytes → 88 base64 characters ending in one `=`. */
const SHA512_B64 = /^[A-Za-z0-9+/]{86}==$/

export function isWellFormedSha512(value: unknown): UpdateVerdict {
  if (typeof value !== 'string' || value.trim() === '') {
    return reject('the update has no sha512 checksum')
  }
  if (!SHA512_B64.test(value.trim())) {
    return reject('the update sha512 is not a well-formed base64 SHA-512')
  }
  return { ok: true }
}

/** The shape we accept from `latest.yml`. Everything is `unknown` on purpose:
 *  this is network input, and typing it as anything else is a lie. */
export interface RawUpdateInfo {
  version?: unknown
  path?: unknown
  sha512?: unknown
}

/**
 * The whole gate. Called with the parsed feed document and the running app's
 * version; returns a single verdict the caller must treat as authoritative.
 *
 * Deliberately returns on the FIRST failure with a specific reason, so a
 * refusal can be logged as something a human can act on rather than a bare
 * "update failed".
 */
export function validateUpdate(info: RawUpdateInfo, currentVersion: string): UpdateVerdict {
  if (!info || typeof info !== 'object') return reject('the update feed returned no information')

  const current = parseVersion(currentVersion)
  if (!current) return reject(`the running version is unparseable: ${String(currentVersion)}`)

  const next = parseVersion(info.version)
  if (!next) return reject(`the offered version is unparseable: ${String(info.version)}`)

  // Strictly newer. Equal is not an update, and older is a DOWNGRADE — the
  // move an attacker makes to reinstall a version whose bugs they know.
  if (compareVersions(next, current) <= 0) {
    return reject(`the offered version ${String(info.version)} is not newer than ${currentVersion}`)
  }

  const filename = isSafeFilename(info.path)
  if (!filename.ok) return filename

  const checksum = isWellFormedSha512(info.sha512)
  if (!checksum.ok) return checksum

  return { ok: true }
}
