import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  githubRepoFromFeed,
  isSafeFilename,
  isTrustedFeed,
  isWellFormedSha512,
  parseVersion,
  validateUpdate
} from '../updater/policy'

/** A syntactically valid base64 SHA-512. */
const SHA = `${'A'.repeat(86)}==`
const GOOD = { version: '2.0.0', path: 'CallRise-AI-2.0.0.exe', sha512: SHA }

describe('isTrustedFeed', () => {
  it('accepts an https feed on a real host', () => {
    expect(isTrustedFeed('https://updates.callrise.ai/').ok).toBe(true)
  })

  // Shipping an updater pointed at a domain you do not control is a
  // supply-chain compromise waiting for someone to register it. This one is
  // real: electron-vite scaffolds `publish.url` to exactly this.
  it('refuses the scaffold placeholder', () => {
    const v = isTrustedFeed('https://example.com/auto-updates')
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toContain('placeholder')
  })

  it('refuses plain http, which can be rewritten in transit', () => {
    expect(isTrustedFeed('http://updates.callrise.ai/').ok).toBe(false)
  })

  it('refuses an unconfigured or malformed feed', () => {
    for (const input of ['', '   ', undefined, null, 'not a url', 'ftp://x/y']) {
      expect(isTrustedFeed(input as string).ok).toBe(false)
    }
  })
})

describe('parseVersion', () => {
  it('parses a release and a prerelease', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null })
    expect(parseVersion('1.2.3-beta.1')?.prerelease).toBe('beta.1')
  })

  // A version we cannot read is one we cannot compare, so it is rejected
  // rather than coerced to something that happens to sort.
  it('returns null rather than guessing', () => {
    for (const v of ['v1.2.3', '1.2', '1.2.3.4', 'latest', '', ' ', null, 42, {}]) {
      expect(parseVersion(v)).toBeNull()
    }
  })
})

describe('compareVersions', () => {
  const p = (v: string): NonNullable<ReturnType<typeof parseVersion>> => parseVersion(v)!

  it('orders by major, minor, then patch', () => {
    expect(compareVersions(p('2.0.0'), p('1.9.9'))).toBe(1)
    expect(compareVersions(p('1.3.0'), p('1.2.9'))).toBe(1)
    expect(compareVersions(p('1.2.4'), p('1.2.3'))).toBe(1)
    expect(compareVersions(p('1.2.3'), p('1.2.3'))).toBe(0)
  })

  it('sorts a prerelease below its own release', () => {
    expect(compareVersions(p('1.0.0-beta'), p('1.0.0'))).toBe(-1)
    expect(compareVersions(p('1.0.0'), p('1.0.0-beta'))).toBe(1)
  })

  it('does not compare 10 as smaller than 9', () => {
    expect(compareVersions(p('1.10.0'), p('1.9.0'))).toBe(1)
  })
})

describe('isSafeFilename — the Doyensec surface', () => {
  it('accepts an ordinary installer name', () => {
    expect(isSafeFilename('CallRise-AI-2.0.0.exe').ok).toBe(true)
    expect(isSafeFilename('CallRise AI 2.0.0.dmg').ok).toBe(true)
  })

  // The 2020 bypass exactly: a single quote caused a PowerShell parse error,
  // the signature check returned null, null read as "no problem found", and
  // the update installed anyway. Nobody defeated the cryptography.
  it('refuses the single quote that broke the signature check', () => {
    expect(isSafeFilename("CallRise'AI.exe").ok).toBe(false)
  })

  it.each([
    ['double quote', 'a"b.exe'],
    ['backtick', 'a`b.exe'],
    ['dollar', 'a$b.exe'],
    ['semicolon', 'a;calc.exe'],
    ['pipe', 'a|calc.exe'],
    ['ampersand', 'a&calc.exe'],
    ['redirect', 'a>b.exe'],
    ['newline', 'a\nb.exe'],
    ['null byte', 'a\0b.exe'],
    ['parent traversal', '../../evil.exe'],
    ['forward slash', 'dir/evil.exe'],
    ['backslash', 'dir\\evil.exe']
  ])('refuses %s', (_label, name) => {
    expect(isSafeFilename(name).ok).toBe(false)
  })

  it('refuses an absent or empty filename', () => {
    for (const v of [undefined, null, '', '   ', 42]) {
      expect(isSafeFilename(v).ok).toBe(false)
    }
  })

  it('refuses an implausibly long filename', () => {
    expect(isSafeFilename(`${'a'.repeat(300)}.exe`).ok).toBe(false)
  })
})

describe('isWellFormedSha512', () => {
  it('accepts a correctly shaped base64 SHA-512', () => {
    expect(isWellFormedSha512(SHA).ok).toBe(true)
  })

  it('refuses a checksum that is missing, empty or the wrong length', () => {
    for (const v of [undefined, null, '', 'abc', 'A'.repeat(88), `${'A'.repeat(86)}=`]) {
      expect(isWellFormedSha512(v).ok).toBe(false)
    }
  })

  it('refuses non-base64 characters', () => {
    expect(isWellFormedSha512(`${'A'.repeat(85)}!==`).ok).toBe(false)
  })
})

describe('validateUpdate', () => {
  it('accepts a well-formed newer release', () => {
    expect(validateUpdate(GOOD, '1.0.0').ok).toBe(true)
  })

  it('refuses the same version — that is not an update', () => {
    expect(validateUpdate({ ...GOOD, version: '1.0.0' }, '1.0.0').ok).toBe(false)
  })

  // The move an attacker makes: reinstall a version whose bugs they know.
  it('refuses a DOWNGRADE', () => {
    const v = validateUpdate({ ...GOOD, version: '0.9.0' }, '1.0.0')
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toContain('not newer')
  })

  it('refuses an unparseable offered version rather than trying it', () => {
    expect(validateUpdate({ ...GOOD, version: 'latest' }, '1.0.0').ok).toBe(false)
    expect(validateUpdate({ ...GOOD, version: undefined }, '1.0.0').ok).toBe(false)
  })

  it('refuses when the RUNNING version is unparseable', () => {
    expect(validateUpdate(GOOD, 'dev').ok).toBe(false)
  })

  it('refuses a newer version carrying an unsafe filename', () => {
    expect(validateUpdate({ ...GOOD, path: "evil'.exe" }, '1.0.0').ok).toBe(false)
  })

  it('refuses a newer version with no checksum at all', () => {
    expect(validateUpdate({ ...GOOD, sha512: undefined }, '1.0.0').ok).toBe(false)
  })

  // The whole design premise: every unexpected input is a refusal, never a
  // pass-through. A check that fails must not read as a check that passed.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'nope'],
    ['a number', 7],
    ['an empty object', {}]
  ])('refuses %s rather than failing open', (_label, input) => {
    expect(validateUpdate(input as never, '1.0.0').ok).toBe(false)
  })

  it('always explains why, so a refusal is actionable', () => {
    const v = validateUpdate({}, '1.0.0')
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason.length).toBeGreaterThan(10)
  })
})

// M23: lets registerUpdater() pick electron-updater's dedicated 'github'
// provider (reads a repo's Releases assets directly) for a feed that's a
// github.com repo URL, without changing isTrustedFeed's own trust decision
// at all — this is pure parsing, called only after the URL is already
// accepted.
describe('githubRepoFromFeed', () => {
  it('extracts owner/repo from a plain github.com repo URL', () => {
    expect(githubRepoFromFeed('https://github.com/nirtsur1998-bot/callrise-ai')).toEqual({
      owner: 'nirtsur1998-bot',
      repo: 'callrise-ai'
    })
  })

  it('tolerates a trailing slash and extra path segments', () => {
    expect(githubRepoFromFeed('https://github.com/nirtsur1998-bot/callrise-ai/')).toEqual({
      owner: 'nirtsur1998-bot',
      repo: 'callrise-ai'
    })
    expect(githubRepoFromFeed('https://github.com/nirtsur1998-bot/callrise-ai/releases')).toEqual({
      owner: 'nirtsur1998-bot',
      repo: 'callrise-ai'
    })
  })

  it('strips a .git suffix', () => {
    expect(githubRepoFromFeed('https://github.com/nirtsur1998-bot/callrise-ai.git')).toEqual({
      owner: 'nirtsur1998-bot',
      repo: 'callrise-ai'
    })
  })

  it('accepts www.github.com too', () => {
    expect(githubRepoFromFeed('https://www.github.com/nirtsur1998-bot/callrise-ai')).toEqual({
      owner: 'nirtsur1998-bot',
      repo: 'callrise-ai'
    })
  })

  it('returns null for a non-github host — the generic provider handles it instead', () => {
    expect(githubRepoFromFeed('https://updates.callrise.ai/')).toBeNull()
  })

  it('returns null for a github.com URL with no repo path (just the host)', () => {
    expect(githubRepoFromFeed('https://github.com/')).toBeNull()
    expect(githubRepoFromFeed('https://github.com/onlyowner')).toBeNull()
  })

  it('returns null rather than throwing on an unparseable URL', () => {
    expect(githubRepoFromFeed('not a url')).toBeNull()
  })
})
