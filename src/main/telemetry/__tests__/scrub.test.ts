// M29 A1.0 — the scrubber's proof. Every "it is gone" assertion is paired with
// a control assertion that the RAW input contained the thing, so no test here
// can pass vacuously (hollow-green species: the assertion that is always true).
//
// The red-check for the rule that matters most (the user-profile path) was
// performed by hand: WIN_PROFILE disabled → the Windows-stack tests below go
// red naming the username → restored. Recorded in docs/M29-A1-plan.md's
// claim table for this step.
import { homedir, userInfo } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createScrubber, scrub } from '../scrub'

const NAME = 'nirtsur'
const jane = createScrubber({ homedir: 'C:\\Users\\jane', username: 'jane' })

describe('user-profile paths — the Windows username must never survive', () => {
  it('a real-shaped Windows stack trace (the packaged app path)', () => {
    const raw = [
      'TypeError: Cannot read properties of undefined (reading "id")',
      `    at startCall (C:\\Users\\${NAME}\\AppData\\Local\\Programs\\CallRiseAI\\resources\\app.asar\\out\\main\\index.js:4123:17)`,
      `    at async C:\\Users\\${NAME}\\AppData\\Local\\Programs\\CallRiseAI\\resources\\app.asar\\out\\main\\index.js:77:3`
    ].join('\n')
    expect(raw).toContain(NAME) // control: the input really carries it
    const out = jane(raw)
    expect(out).not.toContain(NAME)
    expect(out).toContain('C:\\Users\\<user>\\AppData') // the rest of the path survives for debugging
    expect(out).toContain('TypeError: Cannot read properties') // the error itself survives
  })

  it('JSON-escaped double backslashes (what JSON.stringify does to a stack)', () => {
    const raw = JSON.stringify({ stack: `at x (C:\\Users\\${NAME}\\AppData\\x.js:1:1)` })
    expect(raw).toContain(`C:\\\\Users\\\\${NAME}`)
    expect(jane(raw)).not.toContain(NAME)
  })

  it('forward slashes, file:// URLs, and the long-path prefix', () => {
    for (const raw of [
      `C:/Users/${NAME}/AppData/Roaming/sales-os/logs/callrise.log`,
      `file:///C:/Users/${NAME}/AppData/Local/Programs/CallRiseAI/resources/app.asar/out/main/index.js`,
      `\\\\?\\C:\\Users\\${NAME}\\AppData\\Local\\Temp\\callrise-diag-1.zip`,
      `d:\\users\\${NAME}\\Desktop\\x` // other drive, lower case
    ]) {
      expect(raw).toContain(NAME)
      expect(jane(raw)).not.toContain(NAME)
    }
  })

  it('macOS and Linux spellings, including inside parentheses and file URLs', () => {
    for (const raw of [
      `/Users/${NAME}/Library/Application Support/sales-os/x.json`,
      `    at f (/Users/${NAME}/dev/app/out/main/index.js:1:1)`,
      `file:///Users/${NAME}/dev/x.js`,
      `/home/${NAME}/.config/sales-os/x.json`,
      `ENOENT: no such file, open '/home/${NAME}/x'`
    ]) {
      expect(raw).toContain(NAME)
      expect(jane(raw)).not.toContain(NAME)
    }
  })

  it('the literal home directory is replaced even when it is not under Users', () => {
    const custom = createScrubber({ homedir: 'D:\\Profiles\\jane', username: 'jane' })
    const raw = 'wrote D:\\Profiles\\jane\\AppData\\x and D:/Profiles/jane/y'
    expect(raw).toContain('jane')
    const out = custom(raw)
    expect(out).not.toContain('jane')
    expect(out).toContain('<home>')
  })

  it('does not half-match a longer username that shares a prefix', () => {
    const raw = 'C:\\Users\\janeway\\x'
    const out = jane(raw)
    // The profile rule still redacts janeway (it is a username in a path), but
    // the home-dir rule must not have produced "<home>way".
    expect(out).not.toContain('<home>way')
    expect(out).not.toContain('janeway')
  })

  it('does NOT replace the username as a bare word — only where it is a path segment', () => {
    // This dev machine's account is literally "User". A bare-word rule would
    // turn "User cancelled" into "<user> cancelled" and mangle every log line.
    const local = createScrubber({ homedir: 'C:\\Users\\User', username: 'User' })
    const raw = 'User cancelled the dialog; saved to C:\\Users\\User\\AppData\\x'
    const out = local(raw)
    expect(out.startsWith('User cancelled the dialog')).toBe(true)
    expect(out).not.toContain('Users\\User\\')
    expect(out).not.toContain('<home>\\\\') // no double escaping introduced
  })
})

describe('on THIS machine — the founder-demanded proof, against the real identity', () => {
  const realHome = homedir()
  const realUser = userInfo().username
  const norm = (x: string): string => x.toLowerCase().replace(/\\/g, '/')
  // Escaped: a username is arbitrary text, and an unescaped one builds a regex
  // that either throws or quietly matches something other than the username.
  const userSegment = new RegExp(
    `[\\\\/]${realUser.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\\\/]`,
    'i'
  )

  // Can a real stack from THIS run carry the home directory at all? True on a
  // dev machine, where the checkout lives under the profile. FALSE on a CI
  // runner: the workspace is D:\a\<repo>\<repo> while the profile is
  // C:\Users\runneradmin, so a real stack holds no identity to strip and the
  // proof is simply unavailable there.
  //
  // The original control said "if this ever stops being true the test must say
  // so rather than pass silently" — right, and it did say so, by failing the
  // first CI run it ever had (this file arrived with the M29 merge and had
  // never been through the release workflow). But an unsatisfiable premise is
  // not a defect to block a release on, and the answer is not to relax it into
  // a vacuous pass either. So the real-stack proof is skipped WITH ITS REASON
  // where the premise cannot hold, and the planted-identity test below — true
  // by construction, so it runs everywhere including CI — carries the
  // invariant in its place.
  const realStackCarriesHome = norm(new Error('probe').stack ?? '').includes(norm(realHome))

  it.skipIf(!realStackCarriesHome)(
    'a real Error().stack from this test run arrives without the home dir or the username path segment',
    () => {
      const raw = new Error('planted').stack ?? ''
      expect(norm(raw)).toContain(norm(realHome)) // control, guarded by skipIf
      const out = scrub(raw)
      expect(norm(out)).not.toContain(norm(realHome))
      expect(out).not.toMatch(userSegment)
      expect(out).toContain('Error: planted')
    }
  )

  it('the REAL home and username are stripped from a stack-shaped string (runs everywhere, CI included)', () => {
    // The same real identity values, in a stack shape built by hand so the
    // control holds on any machine. This is what stops CI proving nothing on
    // the runs where the test above skips.
    const planted = [
      'Error: planted',
      `    at doThing (${realHome}\\CallRise\\src\\main\\telemetry\\scrub.ts:12:5)`,
      `    at file:///${norm(realHome)}/CallRise/node_modules/x/index.js:3:1`
    ].join('\n')
    expect(norm(planted)).toContain(norm(realHome)) // control: true by construction
    const out = scrub(planted)
    expect(norm(out)).not.toContain(norm(realHome))
    expect(out).not.toMatch(userSegment)
    expect(out).toContain('Error: planted')
  })

  it('scrub(Error) and scrub.deep({ error }) behave the same as scrub(stack)', () => {
    const err = new Error('deep planted')
    // Plant the real home INTO the stack. Without this these assertions pass
    // vacuously anywhere the checkout is not under the profile: the stack never
    // contained the home dir, so "does not contain it" is true for the wrong
    // reason. That was a hollow green sitting beside the honest failure above.
    err.stack = `Error: deep planted\n    at x (${realHome}\\CallRise\\a\\b.ts:1:1)`
    expect(norm(err.stack)).toContain(norm(realHome)) // control
    expect(scrub(err).toLowerCase()).not.toContain(realHome.toLowerCase())
    const walked = scrub.deep({ err, nested: [{ stack: err.stack }] })
    expect(JSON.stringify(walked).toLowerCase()).not.toContain(realHome.toLowerCase())
  })
})

describe('secrets — every key shape the app stores, plus the generic ones', () => {
  const KEYS = [
    'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-abcdef',
    'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    'sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    'sk-or-v1-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    'gsk_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    'AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz012345678',
    'nvapi-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    'csk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    'xai-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    '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'
  ]

  it.each(KEYS)('redacts %s wherever it appears', (key) => {
    const raw = `provider rejected key ${key} (401)`
    expect(raw).toContain(key)
    const out = scrub(raw)
    expect(out).not.toContain(key)
    expect(out).toContain('(401)')
  })

  it('a Deepgram key (40 hex chars) and an Authorization header', () => {
    const dg = 'a3f9c2e1b7d04f6a8c5e2d1b9f7a6c4e3d2b1a09'
    const raw = `Authorization: Token ${dg}\nAuthorization: Bearer abc.def-ghi_JKL123456`
    expect(raw).toContain(dg)
    const out = scrub(raw)
    expect(out).not.toContain(dg)
    expect(out).not.toContain('abc.def-ghi_JKL123456')
  })

  it('a Supabase-shaped JWT (the session token and the anon key)', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZwaHZzdXZwc2txd2tjcGlvY2Z6In0.FGtBQ3FmOd0JAS55ctb6eLNQ2GoN2h'
    const raw = `apikey=${jwt}`
    expect(raw).toContain(jwt)
    expect(scrub(raw)).not.toContain(jwt)
  })

  it('key=value and "key": "value" leaks in messages and serialized objects', () => {
    for (const raw of [
      'api_key=supersecretvalue&x=1',
      'password: hunter2hunter2',
      JSON.stringify({ token: 'abcdef123456xyz' }),
      "apiKey='qwertyuiop1234'"
    ]) {
      const out = scrub(raw)
      for (const secret of [
        'supersecretvalue',
        'hunter2hunter2',
        'abcdef123456xyz',
        'qwertyuiop1234'
      ]) {
        if (raw.includes(secret)) expect(out).not.toContain(secret)
      }
    }
  })

  it('any long opaque token is redacted even without a known prefix', () => {
    const tok = 'Q'.repeat(20) + 'z9'.repeat(20) // 60 chars
    expect(scrub(`got ${tok} back`)).toBe('got <token> back')
  })
})

describe('identity shapes', () => {
  it('emails', () => {
    const raw = 'signed in as nir.tsur+test@gmail.com; cc Someone@Example.co.uk'
    const out = scrub(raw)
    expect(out).not.toContain('gmail.com')
    expect(out).not.toContain('Example.co.uk')
    expect(out).toContain('<email>')
  })

  it('UUIDs (the Supabase user id shape) in any case', () => {
    const id = 'E8328791-A06E-5AF3-BD54-A1995B9C350B'
    const out = scrub(`user ${id} / ${id.toLowerCase()}`)
    expect(out).not.toContain('a1995b9c350b')
    expect(out).not.toContain('A1995B9C350B')
    expect(out).toBe('user <uuid> / <uuid>')
  })

  it('URL query strings and fragments go; the path stays', () => {
    const out = scrub('GET https://api.example.com/v1/items?token=abc&user=me#frag failed')
    expect(out).toBe('GET https://api.example.com/v1/items?<query> failed')
  })

  it('IPv4 addresses except loopback', () => {
    const out = scrub('from 203.0.113.42 via 127.0.0.1 and 0.0.0.0')
    expect(out).toBe('from <ip> via 127.0.0.1 and 0.0.0.0')
  })
})

describe('never throws, always returns a string; deep() walks structures', () => {
  it('non-string inputs', () => {
    expect(scrub(null)).toBe('')
    expect(scrub(undefined)).toBe('')
    expect(scrub(42)).toBe('42')
    expect(scrub({ a: 'x@y.io' })).toBe('{"a":"<email>"}')
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(scrub(circular)).toBe('<unscrubbable>')
  })

  it('deep() scrubs keys and values, arrays, and stops at the depth limit instead of recursing forever', () => {
    const out = scrub.deep({
      'owner@x.io': { path: 'C:\\Users\\zed\\a', list: ['sk-ant-' + 'a'.repeat(30), 7, true] }
    }) as Record<string, { path: string; list: unknown[] }>
    expect(Object.keys(out)).toEqual(['<email>'])
    expect(out['<email>'].path).toBe('C:\\Users\\<user>\\a')
    expect(out['<email>'].list).toEqual(['<redacted-key>', 7, true])

    // 12 levels deep: beyond MAX_DEPTH the walker substitutes a marker.
    let deepest: unknown = 'leaf'
    for (let i = 0; i < 12; i++) deepest = { n: deepest }
    expect(JSON.stringify(scrub.deep(deepest))).toContain('<depth-limit>')
  })

  it('caps very long strings with a visible marker', () => {
    const small = createScrubber({ maxLength: 50 })
    const out = small('word '.repeat(40)) // 200 chars, with spaces so the long-token rule doesn't apply
    expect(out.length).toBeLessThan(100)
    expect(out).toContain('<truncated 150 chars>')
  })

  it('leaves an ordinary log line alone', () => {
    const line = '[2026-08-23T10:00:00.000Z] INFO updater: update-not-available (1.3.2)'
    expect(scrub(line)).toBe(line)
  })
})
