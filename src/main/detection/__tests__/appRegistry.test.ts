import { describe, expect, it } from 'vitest'
import { looksLikeCallTitle, matchTitle } from '../appRegistry'

describe('looksLikeCallTitle (M17 §2.2 generic fallback)', () => {
  it('matches explicit call/meeting words', () => {
    expect(looksLikeCallTitle('zzq-4471 — Call with Acme Co')).toBe(true)
    expect(looksLikeCallTitle('Weekly Sync Meeting')).toBe(true)
    expect(looksLikeCallTitle('Conference Room B')).toBe(true)
    expect(looksLikeCallTitle('Video Chat — Acme')).toBe(true)
    expect(looksLikeCallTitle('Team Huddle')).toBe(true)
    expect(looksLikeCallTitle('Q3 Webinar')).toBe(true)
    expect(looksLikeCallTitle('SIP Dialer')).toBe(true)
    expect(looksLikeCallTitle('On a call with support')).toBe(true)
  })

  it('does not match ordinary window titles', () => {
    expect(looksLikeCallTitle('Untitled Document')).toBe(false)
    expect(looksLikeCallTitle('inbox@example.com — Mail')).toBe(false)
    expect(looksLikeCallTitle('main.ts — my-project')).toBe(false)
    expect(looksLikeCallTitle('Finder')).toBe(false)
    expect(looksLikeCallTitle('')).toBe(false)
  })

  it('deliberately does not match bare elapsed-time patterns (too false-positive-prone)', () => {
    expect(looksLikeCallTitle('MicroSIP — 00:12:34')).toBe(false)
  })
})

describe('matchTitle vs looksLikeCallTitle precedence', () => {
  it('a known app is matched by matchTitle first, never falls through to the generic heuristic', () => {
    const known = matchTitle('Zoom Meeting')
    expect(known?.appId).toBe('zoom')
  })

  it('an unrecognized title still passes the generic heuristic even when matchTitle finds nothing', () => {
    const title = 'zzq-4471 — Call with Acme Co'
    expect(matchTitle(title)).toBeUndefined()
    expect(looksLikeCallTitle(title)).toBe(true)
  })
})
