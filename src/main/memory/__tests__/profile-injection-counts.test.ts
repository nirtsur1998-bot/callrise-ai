// BUG-258 — count the empty branch, because a well-behaved empty case is
// indistinguishable from a feature that has never worked.
//
// `section()` returns '' — not even the header — when there is nothing to
// inject. Correct prompt hygiene, and exactly what hid a dead Sales Brain for
// months: six consumers concatenating an empty string, no log line, no failed
// call, no counter. The tell was that nothing anywhere recorded how often the
// empty branch was taken.
//
// These tests pin the distinction that matters: "off", "no database" and
// "compiled but EMPTY" were previously one indistinguishable silence, and only
// the third is a fault.
import { describe, expect, it, beforeEach, vi } from 'vitest'

let brainEnabled = true
let db: object | null = {}
let compiled: { text: string } | undefined = { text: 'a fact' }

vi.mock('../../app-settings', () => ({ isSalesBrainEnabled: () => brainEnabled }))
vi.mock('../memory-runtime', () => ({ getMemoryDb: () => db }))
vi.mock('../memories-store', () => ({ getCompiledProfile: () => compiled }))

const { repProfileSection, clientProfileSection, businessProfileSection, injectionStats, resetInjectionStats } =
  await import('../profile-injection')

beforeEach(() => {
  resetInjectionStats()
  brainEnabled = true
  db = {}
  compiled = { text: 'a fact' }
})

describe('BUG-258 — the three silences are told apart', () => {
  it('records a real injection as injected', () => {
    repProfileSection('micro')
    expect(injectionStats()).toEqual({ 'rep:injected': 1 })
  })

  it('records a COMPILED BUT EMPTY profile — the state that means something is wrong', () => {
    // This is the founder's machine: the profile row exists, was recompiled
    // this morning, and is zero characters because nothing was ever promoted.
    compiled = { text: '' }
    repProfileSection('micro')
    expect(injectionStats()).toEqual({ 'rep:compiled-but-empty': 1 })
  })

  it('does NOT confuse a user turning Sales Brain off with a fault', () => {
    brainEnabled = false
    repProfileSection('micro')
    expect(injectionStats()).toEqual({ 'rep:brain-off': 1 })
  })

  it('does NOT confuse a fresh install with a fault', () => {
    db = null
    repProfileSection('micro')
    expect(injectionStats()).toEqual({ 'rep:no-db': 1 })
  })

  it('the empty case and the working case produce the SAME STRING, which is the whole problem', () => {
    // Both return ''. Without the counter there is nothing to tell them apart,
    // which is why the counter is the fix and not a nicer empty string.
    compiled = { text: '' }
    const empty = repProfileSection('micro')
    brainEnabled = false
    const off = repProfileSection('micro')
    expect(empty).toBe('')
    expect(off).toBe('')
    expect(injectionStats()).toEqual({ 'rep:compiled-but-empty': 1, 'rep:brain-off': 1 })
  })
})

describe('BUG-258 — the counter is safe to put in a support bundle', () => {
  it('collapses every client scope into one family, so no contact id can leak', () => {
    clientProfileSection('contact-aaaa-1111', 'micro')
    clientProfileSection('contact-bbbb-2222', 'micro')
    const stats = injectionStats()
    expect(stats).toEqual({ 'client:injected': 2 })
    expect(JSON.stringify(stats)).not.toContain('contact-')
  })

  it('carries integers only — no statements, no scope ids', () => {
    compiled = { text: 'the CFO signs off above 40k' }
    repProfileSection('micro')
    businessProfileSection('standard')
    const json = JSON.stringify(injectionStats())
    expect(json).not.toContain('CFO')
    for (const v of Object.values(injectionStats())) expect(typeof v).toBe('number')
  })

  it('keeps the scopes apart — one working scope must not mask another that is empty', () => {
    repProfileSection('micro')
    compiled = { text: '' }
    businessProfileSection('standard')
    expect(injectionStats()).toEqual({ 'rep:injected': 1, 'business:compiled-but-empty': 1 })
  })

  it('a null contactId never reaches the counter at all', () => {
    // clientProfileSection returns '' before touching the store when there is
    // no contact — that is not an injection failure, it is "no client here".
    expect(clientProfileSection(null, 'micro')).toBe('')
    expect(injectionStats()).toEqual({})
  })

  it('accumulates across calls rather than reporting only the last', () => {
    compiled = { text: '' }
    for (let i = 0; i < 5; i++) repProfileSection('micro')
    expect(injectionStats()['rep:compiled-but-empty']).toBe(5)
  })
})
