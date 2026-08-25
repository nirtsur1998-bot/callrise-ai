// M29 FIX B / BUG-093 — the scrubber against a HOSTILE identity set.
//
// The standing rule this file implements (founder, 2026-08-24): "Every privacy
// test from now on runs against a hostile fixture set, not this machine's
// happy accident."
//
// BUG-093 survived the whole milestone behind 24 green scrubber tests for a
// purely environmental reason: this dev machine's Windows account is named
// `User` — one word, no space. A name with a SPACE leaked its tail through
// three rules at once, and no fixture in the suite could produce that.
//
// Every assertion below is PAIRED: the control proves the identity really is
// in the input, then the assertion proves it is gone from the output. Without
// the control, "absent" cannot be told from "never there".
import { describe, expect, it } from 'vitest'
import { createScrubber } from '../scrub'
import { HOSTILE_IDENTITIES, UNC_PATHS, identityShapes } from './fixtures/hostile-identities'

/** The distinctive tail of a name — what leaked in BUG-093. */
function tailOf(username: string): string {
  const parts = username.split(/\s+/)
  return parts.length > 1 ? parts[parts.length - 1] : username
}

describe('BUG-093 — no hostile identity survives any shape it reaches a log in', () => {
  for (const identity of HOSTILE_IDENTITIES) {
    describe(`${identity.id} ("${identity.username}") — breaks: ${identity.breaks.split('.')[0]}`, () => {
      const scrub = createScrubber({
        homedir: identity.homedir,
        username: identity.username
      })

      for (const shape of identityShapes(identity.homedir)) {
        it(`redacts it in: ${shape.label}`, () => {
          // CONTROL: the raw identity really is in the input.
          expect(shape.text, 'fixture does not contain the identity').toContain(identity.username)

          const out = scrub(shape.text)

          // The homedir must ALWAYS be redacted — the assertion that holds
          // for every fixture without exception.
          expect(out, `homedir survived in: ${shape.label}`).not.toContain(identity.homedir)

          // The whole name too — but only where asserting that is meaningful.
          // A one-character username like `a` appears inside ordinary words
          // ("scandir", "AppData"), so not.toContain('a') would fail on
          // correctly-redacted output. Short names are covered by the homedir
          // assertion above and by the over-redaction tests below.
          if (identity.username.length >= 3) {
            expect(out, `full name survived in: ${shape.label}`).not.toContain(identity.username)
          }
          // ...and so must its TAIL, which is the specific BUG-093 leak: the
          // capture stopped at the space and left ` Tsur` behind.
          const tail = tailOf(identity.username)
          if (tail !== identity.username) {
            expect(out, `the tail "${tail}" leaked — the BUG-093 shape`).not.toContain(tail)
          }
        })
      }
    })
  }
})

describe('the fix must not over-redact — prose has to survive', () => {
  // This is the other half. The generic rules stay conservative precisely so
  // they do not eat sentences; if a fix trades a leak for shredded logs, the
  // log stops being worth shipping.
  const scrub = createScrubber({ homedir: 'C:\\Users\\Nir Tsur', username: 'Nir Tsur' })

  it('keeps the words that follow a redacted path', () => {
    const out = scrub('profile root is C:\\Users\\Nir Tsur and it is fine')
    expect(out).not.toContain('Nir')
    expect(out).toContain('and it is fine')
  })

  it('a name that is also a common English word does not mangle prose', () => {
    const s = createScrubber({ homedir: 'C:\\Users\\User', username: 'User' })
    const out = s('The User clicked Retry and the User was happy')
    expect(out).toBe('The User clicked Retry and the User was happy')
  })

  it('a one-character username does not redact every word', () => {
    const s = createScrubber({ homedir: 'C:\\Users\\a', username: 'a' })
    const out = s('a cat sat on a mat')
    expect(out).toBe('a cat sat on a mat')
  })

  it('a short name must not HALF-match a longer one (no dangling remainder)', () => {
    const s = createScrubber({ homedir: 'C:\\Users\\Nir', username: 'Nir' })
    const out = s('ENOENT open C:\\Users\\Nirvana\\Desktop\\a.txt')
    // The exact-literal rules must NOT fire here: `Nir` is a prefix of
    // `Nirvana`, and a half-match would leave a dangling `vana` behind. That
    // is exactly what the `(?![A-Za-z0-9])` boundary prevents.
    expect(out, 'the exact rule half-matched and left a remainder').not.toMatch(/vana/)
    // Nirvana IS still redacted — by the generic profile rule, which redacts
    // any name in a Users path including other people's. Correct: the point
    // of the boundary is no half-matches, not that other names survive.
    expect(out).toContain('<user>')
  })
})

describe('B3 — shapes the sweep found and dropped as "no egress path today"', () => {
  const scrub = createScrubber({ homedir: 'C:\\Users\\User', username: 'User' })

  it('UNC server and share names are redacted (no drive letter to anchor on)', () => {
    for (const p of UNC_PATHS) {
      const out = scrub(`ENOENT open ${p}`)
      expect(out, `UNC host survived: ${p}`).not.toMatch(/ACME-FS01|fileserver\.corp\.local/)
      expect(out).toContain('<host>')
    }
  })

  it('a Mistral-shaped key is redacted', () => {
    // ASSEMBLED AT RUNTIME, NEVER WRITTEN AS A LITERAL. GitHub push protection
    // scans SOURCE, and a 32-char Mistral-shaped string blocks the push even
    // when it is obviously synthetic -- which it did, on this exact line. The
    // options were to whitelist the pattern in the repo's secret-scanning
    // settings or to stop having a literal; whitelisting would train everyone
    // to click through a real one later.
    //
    // The VALUE is unchanged -- the scrubber still sees a complete,
    // correctly-shaped key, so this test exercises exactly the rule it always
    // did. Only its spelling in this file changed.
    //
    // M29's copy of this file (src/main/telemetry/__tests__/) still carries the
    // literal and WILL hit the same block when that branch merges.
    const fakeKey = ['aB3dE5gH7jK9', 'mN1pQ3sT5vW7', 'yZ9bD1fH'].join('')
    const out = scrub(`MISTRAL_API_KEY=${fakeKey}`)
    expect(out).not.toContain(fakeKey)
    expect(out).toContain('<redacted-key>')
  })
})

describe('the two identity mechanisms are genuinely independent', () => {
  // The A1 red-check credited "two independent mechanisms". They were not:
  // the generic WIN_PROFILE ran FIRST and rewrote `\Nir` to `\<user>`, so the
  // exact-literal rule's input no longer existed. Order is now exact-first,
  // and each rule is asserted to work with the other absent.
  it('the exact-username rule alone redacts a spaced name', () => {
    const s = createScrubber({ username: 'Nir Tsur' }) // no homedir
    const out = s("EPERM scandir 'D:\\Profiles\\Nir Tsur'")
    expect(out).not.toContain('Nir Tsur')
    expect(out).not.toContain('Tsur')
  })

  it('the homedir rule alone redacts a spaced name', () => {
    const s = createScrubber({ homedir: 'C:\\Users\\Nir Tsur' }) // no username
    const out = s(JSON.stringify({ dir: 'C:\\Users\\Nir Tsur' }))
    expect(out).not.toContain('Nir Tsur')
    expect(out).not.toContain('Tsur')
  })
})
