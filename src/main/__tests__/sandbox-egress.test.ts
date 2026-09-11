// BUG-263 — the decision table, every row of the enumeration, and the cases
// that decide whether this guard is protection or theatre.
//
// The bug this replaces was not a wrong answer; it was a guard whose SCOPE was
// narrower than every reader assumed. So the assertions below are written to
// fail if the scope ever narrows again: each egress path in the tracker's
// enumeration has a row here, and `unknown` is asserted to be refused rather
// than assumed to be.
import { describe, expect, it, beforeEach } from 'vitest'
import {
  classifyEgress,
  parseGranted,
  describeSandboxEgress,
  GRANTABLE,
  resetSandboxEgressForTests,
  type EgressCategory
} from '../sandbox-egress'

const NONE = new Set<string>()
const all = (): Set<string> => new Set(GRANTABLE)

beforeEach(() => resetSandboxEgressForTests())

describe('BUG-263 — every enumerated egress path is classified', () => {
  // One row per line of the tracker's "EVERY EGRESS PATH" table. If a path is
  // ever added there and not here, this list is where the omission shows.
  const PATHS: [name: string, url: string, category: EgressCategory][] = [
    ['Supabase rows', 'https://abcd1234.supabase.co/rest/v1/calls?select=*', 'sync'],
    [
      'Supabase storage',
      'https://abcd1234.supabase.co/storage/v1/object/attachments/x.pdf',
      'sync'
    ],
    [
      'Supabase edge fn (emails)',
      'https://abcd1234.supabase.co/functions/v1/send-verification-email',
      'sync'
    ],
    [
      'Google Calendar push',
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      'calendar'
    ],
    ['Google token refresh', 'https://oauth2.googleapis.com/token', 'calendar'],
    ['Outlook Graph push', 'https://graph.microsoft.com/v1.0/me/events', 'calendar'],
    ['Microsoft token', 'https://login.microsoftonline.com/common/oauth2/v2.0/token', 'calendar'],
    ['Deepgram live audio', 'wss://api.deepgram.com/v1/listen?model=nova-3', 'transcription'],
    ['Anthropic', 'https://api.anthropic.com/v1/messages', 'ai'],
    ['OpenAI', 'https://api.openai.com/v1/chat/completions', 'ai'],
    ['Groq', 'https://api.groq.com/openai/v1/chat/completions', 'ai'],
    ['Gemini', 'https://generativelanguage.googleapis.com/v1beta/models/x:generateContent', 'ai'],
    ['Telegram alerts', 'https://api.telegram.org/bot123/sendMessage', 'alerts'],
    ['WhatsApp alerts', 'https://graph.facebook.com/v20.0/1/messages', 'alerts']
  ]

  it.each(PATHS)('%s is %s and REFUSED by default', (_name, url, category) => {
    const d = classifyEgress(url, NONE)
    expect(d.category).toBe(category)
    expect(d.allowed).toBe(false)
  })

  it.each(PATHS)('%s is allowed once its category is granted', (_name, url, category) => {
    expect(classifyEgress(url, new Set([category])).allowed).toBe(true)
  })

  it('granting one category does not grant another', () => {
    const syncOnly = new Set(['sync'])
    expect(classifyEgress('https://x.supabase.co/rest/v1/calls', syncOnly).allowed).toBe(true)
    // The exact pairing that caused the bug: cloud backup refused, calendar not.
    expect(classifyEgress('https://graph.microsoft.com/v1.0/me/events', syncOnly).allowed).toBe(
      false
    )
  })
})

describe('BUG-263 — the cases that must NEVER be refused', () => {
  it('Supabase auth stays open so a copy can stay signed in (BUG-186s decision)', () => {
    const d = classifyEgress(
      'https://abcd.supabase.co/auth/v1/token?grant_type=refresh_token',
      NONE
    )
    expect(d.category).toBe('auth')
    expect(d.allowed).toBe(true)
  })

  it('the SAME host is split by path — auth open, records closed', () => {
    expect(classifyEgress('https://p.supabase.co/auth/v1/user', NONE).allowed).toBe(true)
    expect(classifyEgress('https://p.supabase.co/rest/v1/contacts', NONE).allowed).toBe(false)
  })

  it.each([
    'http://localhost:5173/index.html',
    'ws://127.0.0.1:9347/devtools/page/1',
    'http://[::1]:3000/',
    'http://app.localhost:3000/'
  ])('loopback stays open (%s) or the dev app cannot launch', (url) => {
    expect(classifyEgress(url, NONE).allowed).toBe(true)
  })

  it.each(['file:///C:/app/index.html', 'data:text/html,hi', 'devtools://devtools/bundled/x.js'])(
    'non-network scheme is not egress (%s)',
    (url) => {
      const d = classifyEgress(url, NONE)
      expect(d.category).toBe('local')
      expect(d.allowed).toBe(true)
    }
  )
})

describe('BUG-263 — it fails CLOSED', () => {
  it('an unlisted host is refused, not allowed', () => {
    const d = classifyEgress('https://some-new-integration.example.com/v1/send', NONE)
    expect(d.category).toBe('unknown')
    expect(d.allowed).toBe(false)
  })

  it('an unlisted host is STILL refused when every grantable category is granted', () => {
    // `all` means "everything I enumerated", never "everything that exists".
    // A new integration must be noticed, not inherited.
    expect(classifyEgress('https://some-new-integration.example.com/x', all()).allowed).toBe(false)
  })

  it.each(['', 'not a url', '://missing-scheme', 'https://'])(
    'a URL that cannot be parsed is refused (%s)',
    (url) => {
      expect(classifyEgress(url, all()).allowed).toBe(false)
    }
  )

  it('suffix matching respects label boundaries', () => {
    // `endsWith('graph.facebook.com')` would classify this as a known alerts
    // host; it is somebody else's domain entirely.
    expect(classifyEgress('https://notgraph.facebook.com/x', new Set(['alerts'])).allowed).toBe(
      false
    )
    expect(classifyEgress('https://graph.facebook.com.evil.test/x', all()).allowed).toBe(false)
    // …while a real subdomain still matches.
    expect(classifyEgress('https://abc.supabase.co/rest/v1/x', new Set(['sync'])).allowed).toBe(
      true
    )
  })
})

describe('BUG-263 — parsing the grant', () => {
  it('grants nothing by default', () => {
    expect([...parseGranted(undefined, false)]).toEqual([])
  })

  it('keeps CALLRISE_SANDBOX_ALLOW_SYNC=1 working as an alias for sync', () => {
    // BUG-186's flag is documented in the vault and in old scripts; breaking it
    // would silently change what an existing sandbox launch can reach.
    expect([...parseGranted(undefined, true)]).toEqual(['sync'])
  })

  it('accepts a comma list, trims, and is case-insensitive', () => {
    const g = parseGranted(' Sync , calendar ', false)
    expect(g.has('sync')).toBe(true)
    expect(g.has('calendar')).toBe(true)
    expect(g.has('ai')).toBe(false)
  })

  it('"all" grants every grantable category and nothing more', () => {
    const g = parseGranted('all', false)
    for (const c of GRANTABLE) expect(g.has(c)).toBe(true)
    expect(g.has('unknown')).toBe(false)
    expect(g.has('auth')).toBe(false) // not grantable: never refused
  })

  it('a typo grants nothing rather than everything', () => {
    expect([...parseGranted('calender', false)]).toEqual([])
  })

  it('the launch line names what is refused, not only what is allowed', () => {
    const line = describeSandboxEgress(parseGranted('sync', false))
    expect(line).toContain('refused:')
    expect(line).toContain('calendar')
    expect(line).toContain('allowed:')
    // The failure this whole entry exists for: a reader inferring total
    // isolation from a line about one subsystem.
    expect(line).toContain('unlisted hosts are REFUSED')
  })
})
