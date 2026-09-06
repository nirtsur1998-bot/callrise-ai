// M36 Stage 2 — the glance HUD's rules, each one the founder's or the
// proposal's, pinned where a test can reach them.
import { beforeEach, describe, expect, it } from 'vitest'
import {
  canDeliverNow,
  hasEvidence,
  loadAbsorption,
  loadHudLayout,
  loadTranscriptCollapsed,
  recordAbsorption,
  saveHudLayout,
  saveTranscriptCollapsed,
  summarizeAbsorption,
  talkShare,
  trimQuote,
  whoIsSpeaking
} from '../hudCore'

const store = new Map<string, string>()
beforeEach(() => {
  store.clear()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k)
  }
})

describe('layout preference — glance by default, full as the switch, transcript on and remembered', () => {
  it('defaults to glance and remembers full', () => {
    expect(loadHudLayout()).toBe('glance')
    saveHudLayout('full')
    expect(loadHudLayout()).toBe('full')
  })
  it("transcript is ON by default (the founder's amendment) and its collapse is remembered", () => {
    expect(loadTranscriptCollapsed()).toBe(false)
    saveTranscriptCollapsed(true)
    expect(loadTranscriptCollapsed()).toBe(true)
  })
})

describe('evidence — no cue without it', () => {
  it('a heard quote or a measured label counts; blanks and absence do not', () => {
    expect(hasEvidence({ kind: 'heard', quote: "that's more than we budgeted" })).toBe(true)
    expect(hasEvidence({ kind: 'measured', label: 'you: 205 wpm over the last 30 s' })).toBe(true)
    expect(hasEvidence({ kind: 'heard', quote: '   ' })).toBe(false)
    expect(hasEvidence({ kind: 'measured', label: '' })).toBe(false)
    expect(hasEvidence(undefined)).toBe(false)
    expect(hasEvidence(null)).toBe(false)
  })
  it('a quote is trimmed to a glance with an ellipsis, never cut mid-space', () => {
    expect(trimQuote('a  b   c')).toBe('a b c')
    const long = 'x'.repeat(100)
    expect(trimQuote(long, 20)).toHaveLength(20)
    expect(trimQuote(long, 20).endsWith('…')).toBe(true)
  })
})

describe('lull-gated delivery — never over the rep\'s own sentence', () => {
  it('delivers when nobody has spoken yet', () => {
    expect(canDeliverNow({ now: 1000, repLastSpokeAt: null, otherLastSpokeAt: null })).toBe(true)
  })
  it('holds while the rep spoke within the hold window and nobody else since', () => {
    expect(canDeliverNow({ now: 1000, repLastSpokeAt: 900, otherLastSpokeAt: 100 })).toBe(false)
  })
  it('delivers once the rep has been silent for the hold', () => {
    expect(canDeliverNow({ now: 2600, repLastSpokeAt: 1000, otherLastSpokeAt: 100 })).toBe(true)
  })
  it('delivers when the other party has spoken since the rep (the rep is listening)', () => {
    expect(canDeliverNow({ now: 1200, repLastSpokeAt: 1000, otherLastSpokeAt: 1100 })).toBe(true)
  })
})

describe('the absorption instrument — the number nobody has published', () => {
  it('counts shown, useful once per cue, expired and dismissed; rate is null with nothing shown', () => {
    expect(summarizeAbsorption([]).usefulRate).toBeNull()
    recordAbsorption({ type: 'shown', cueId: 1, kind: 'pace', at: 1 })
    recordAbsorption({ type: 'useful', cueId: 1, kind: 'pace', at: 2 })
    recordAbsorption({ type: 'useful', cueId: 1, kind: 'pace', at: 3 }) // a second mark on the same cue
    recordAbsorption({ type: 'shown', cueId: 2, kind: 'objection', at: 4 })
    recordAbsorption({ type: 'expired', cueId: 2, kind: 'objection', at: 25 })
    recordAbsorption({ type: 'shown', cueId: 3, kind: 'objection', at: 30 })
    recordAbsorption({ type: 'dismissed', cueId: 3, kind: 'objection', at: 31 })
    const s = summarizeAbsorption(loadAbsorption())
    expect(s).toMatchObject({ shown: 3, useful: 1, expired: 1, dismissed: 1 })
    expect(s.usefulRate).toBeCloseTo(1 / 3)
    expect(s.byKind.pace).toMatchObject({ shown: 1, useful: 1, usefulRate: 1 })
    expect(s.byKind.objection).toMatchObject({ shown: 2, useful: 0, usefulRate: 0 })
  })
  it('a broken store never breaks the call', () => {
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      }
    }
    expect(() => recordAbsorption({ type: 'shown', cueId: 9, kind: 'pace', at: 1 })).not.toThrow()
    expect(loadAbsorption()).toEqual([])
  })
})

describe('the state strip facts — true by construction', () => {
  it('who is speaking: you / them / unsure kept visible / nobody when stale', () => {
    expect(whoIsSpeaking({ role: 'rep', at: 900 }, 1000)).toBe('you')
    expect(whoIsSpeaking({ role: 'other', at: 900 }, 1000)).toBe('them')
    expect(whoIsSpeaking({ role: 'unknown', at: 900 }, 1000)).toBe('unsure')
    expect(whoIsSpeaking({ at: 900 }, 1000)).toBe('unsure')
    expect(whoIsSpeaking({ role: 'rep', at: 0 }, 10_000)).toBe('nobody')
    expect(whoIsSpeaking(null, 1000)).toBe('nobody')
  })
  it('talk share counts measured words by role and reports unsure words rather than assigning them', () => {
    const t = talkShare([
      { role: 'rep', text: 'one two three' },
      { role: 'other', text: 'four' },
      { text: 'five six' }
    ])
    expect(t).toEqual({ youWords: 3, themWords: 1, unsureWords: 2, youShare: 0.75 })
    expect(talkShare([]).youShare).toBeNull()
  })
})
