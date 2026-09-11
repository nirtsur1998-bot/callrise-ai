// @vitest-environment node
//
// BUG-263 — the guard is only as good as its enumeration, so the enumeration is
// held against the code rather than against the memory of whoever wrote it.
//
// The original bug was a scope everyone mis-read. The way that happens again is
// a new egress path appearing somewhere this file does not look: a provider
// added to the registry, a `fetch(` landing in the renderer where the node-side
// patch cannot see it, or a new host nobody classified. Each of those has an
// assertion below, and each fails LOUDLY at gate time rather than silently at
// runtime in someone's real mailbox.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { classifyEgress, GRANTABLE } from '../sandbox-egress'

const SRC = join(__dirname, '..', '..')

/** Matches a real call to global `fetch(`, not `refetch(` / `this.fetch(`. */
const FETCH_CALL = /(?<![A-Za-z0-9_$.])fetch\s*\(/
const WEBSOCKET_NEW = /new\s+WebSocket\s*\(/

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue
      walk(p, out)
    } else if (/\.tsx?$/.test(name) && !name.endsWith('.test.ts')) {
      out.push(p)
    }
  }
  return out
}

describe('BUG-263 — every AI provider host is classified, from the registry itself', () => {
  // sandbox-egress.ts lists AI hosts for convenience. This is the check that
  // stops that list from becoming a SECOND SOURCE OF TRUTH that drifts — the
  // exact failure that hid the missing deal stage one milestone earlier: an
  // instrument and the product each holding their own copy of a rule, with
  // nothing comparing them.
  const registry = readFileSync(join(SRC, 'main', 'ai', 'registry.ts'), 'utf8')
  const hosts = [...registry.matchAll(/baseURL:\s*[`'"]https:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1])

  it('finds the registry base URLs at all (guards against a silent zero)', () => {
    // A regex that matched nothing would make every assertion below vacuous —
    // a pass over zero executions.
    expect(hosts.length).toBeGreaterThanOrEqual(6)
  })

  it.each([...new Set(hosts)])('%s classifies as ai, not unknown', (host) => {
    const d = classifyEgress(`https://${host}/v1/chat/completions`, new Set(['ai']))
    expect(
      d.category,
      `${host} is configured in ai/registry.ts but sandbox-egress.ts does not know it. ` +
        `Add it to HOSTS as 'ai' — until then a sandbox refuses it as an unlisted host, ` +
        `which is safe but confusing.`
    ).toBe('ai')
    expect(d.allowed).toBe(true)
  })
})

describe('BUG-263 — nothing in the renderer talks to the network directly', () => {
  // The node-side patch cannot see Chromium's network stack. Today every
  // enumerated path originates in main, which is what makes a main-only guard
  // honest. If that stops being true, this is where it surfaces.
  const files = walk(join(SRC, 'renderer', 'src'))

  it('found renderer sources to scan', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  it('no renderer source calls fetch() or opens a WebSocket', () => {
    const offenders: string[] = []
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      if (FETCH_CALL.test(text) || WEBSOCKET_NEW.test(text)) offenders.push(f.slice(SRC.length + 1))
    }
    expect(
      offenders,
      'Renderer network calls bypass the main-process egress guard entirely. ' +
        'Either route this through IPC, or extend the guard to ' +
        'session.defaultSession.webRequest and update sandbox-egress.ts s scope note.'
    ).toEqual([])
  })
})

describe('BUG-263 — the categories stay meaningful', () => {
  it('every grantable category is reachable by at least one classified host', () => {
    // A category nobody can trigger is a checkbox, not a gate.
    const probes: Record<string, string> = {
      sync: 'https://p.supabase.co/rest/v1/x',
      calendar: 'https://graph.microsoft.com/v1.0/me/events',
      transcription: 'wss://api.deepgram.com/v1/listen',
      ai: 'https://api.anthropic.com/v1/messages',
      alerts: 'https://api.telegram.org/bot1/sendMessage'
    }
    for (const c of GRANTABLE) {
      expect(Object.keys(probes), `no probe URL for category "${c}"`).toContain(c)
      expect(classifyEgress(probes[c], new Set([c])).category).toBe(c)
    }
  })
})
