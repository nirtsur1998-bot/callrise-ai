import { describe, expect, it } from 'vitest'
import { BattlecardMatcher, DEFAULT_COOLDOWN_MS, normalize, type Trigger } from '../match'
import { STARTER_TRIGGERS } from '../library'

const PRICE: Trigger = {
  id: 'price',
  patterns: ['too expensive', 'too pricey'],
  card: {
    id: 'price',
    label: 'Too expensive',
    say: 'Ask what they compare it to.',
    category: 'pricing'
  }
}
const LEGAL: Trigger = {
  id: 'legal',
  patterns: ['legal review'],
  card: { id: 'legal', label: 'Legal', say: 'Start it in parallel.', category: 'process' }
}

describe('normalize', () => {
  it('is case- and punctuation-insensitive', () => {
    expect(normalize("It's TOO Expensive!")).toBe(' its too expensive ')
  })

  // Spacing an apostrophe would turn "you're" into "you re", matching neither
  // "you are" nor "youre" — so a card written for a contraction could never
  // fire on the contraction. Other punctuation genuinely separates words.
  it('joins contractions but separates on other punctuation', () => {
    expect(normalize("you're a startup")).toBe(' youre a startup ')
    expect(normalize('we won’t use it')).toBe(' we wont use it ')
    expect(normalize('expensive,really')).toBe(' expensive really ')
  })

  it('lets a contraction fire a pattern written without the apostrophe', () => {
    const m = new BattlecardMatcher([
      { id: 'x', patterns: ['youre a startup'], card: { ...PRICE.card, id: 'x' } }
    ])
    expect(m.match("honestly, you're a startup", 0)).toHaveLength(1)
  })

  it('collapses runs of whitespace', () => {
    expect(normalize('too    expensive\n\nreally')).toBe(' too expensive really ')
  })

  it('pads, so matching can respect word boundaries', () => {
    expect(normalize('arm').startsWith(' ')).toBe(true)
    expect(normalize('arm').endsWith(' ')).toBe(true)
  })
})

describe('BattlecardMatcher', () => {
  it('fires on a phrase in the transcript', () => {
    const m = new BattlecardMatcher([PRICE])
    expect(m.match('honestly it feels too expensive for us', 0).map((c) => c.id)).toEqual(['price'])
  })

  it('matches regardless of case and punctuation', () => {
    const m = new BattlecardMatcher([PRICE])
    expect(m.match("That's TOO EXPENSIVE!", 0)).toHaveLength(1)
  })

  it('fires on any of a trigger’s phrasings', () => {
    const m = new BattlecardMatcher([PRICE])
    expect(m.match('bit too pricey', 0)).toHaveLength(1)
  })

  // The rolling buffer hands the same words over and over — interim results
  // grow a sentence a word at a time, and a finalized turn sits in the window
  // for many seconds. Without the cooldown one objection papers the screen.
  it('does not re-fire while the same words sit in the buffer', () => {
    const m = new BattlecardMatcher([PRICE])
    expect(m.match('too expensive', 0)).toHaveLength(1)
    expect(m.match('too expensive for us', 200)).toHaveLength(0)
    expect(m.match('it is too expensive for us really', 1500)).toHaveLength(0)
    expect(m.match('too expensive', DEFAULT_COOLDOWN_MS - 1)).toHaveLength(0)
  })

  it('fires again once the cooldown has passed', () => {
    const m = new BattlecardMatcher([PRICE])
    m.match('too expensive', 0)
    expect(m.match('still too expensive', DEFAULT_COOLDOWN_MS)).toHaveLength(1)
  })

  it('cools down each trigger independently', () => {
    const m = new BattlecardMatcher([PRICE, LEGAL])
    expect(m.match('too expensive', 0)).toHaveLength(1)
    expect(m.match('too expensive and we need a legal review', 500).map((c) => c.id)).toEqual([
      'legal'
    ])
  })

  it('fires several triggers from one window', () => {
    const m = new BattlecardMatcher([PRICE, LEGAL])
    const fired = m.match('too expensive, and it needs a legal review', 0)
    expect(fired.map((c) => c.id).sort()).toEqual(['legal', 'price'])
  })

  it('honours a per-trigger cooldown override', () => {
    const m = new BattlecardMatcher([{ ...PRICE, cooldownMs: 1000 }])
    m.match('too expensive', 0)
    expect(m.match('too expensive', 999)).toHaveLength(0)
    expect(m.match('too expensive', 1000)).toHaveLength(1)
  })

  // A card firing when it should not is worse than one that stays quiet: it
  // trains the rep to ignore the rail, and an ignored surface is a dead one.
  it('does not match a phrase buried inside a longer word', () => {
    const m = new BattlecardMatcher([
      { id: 'arm', patterns: ['arm'], card: { ...PRICE.card, id: 'arm' } }
    ])
    expect(m.match('we need to set an alarm about this', 0)).toHaveLength(0)
    expect(m.match('twist my arm then', 0)).toHaveLength(1)
  })

  it('stays quiet on unrelated talk', () => {
    const m = new BattlecardMatcher([PRICE, LEGAL])
    expect(m.match('how was your weekend, did you get out at all', 0)).toHaveLength(0)
  })

  it('handles an empty window', () => {
    const m = new BattlecardMatcher([PRICE])
    expect(m.match('', 0)).toHaveLength(0)
  })

  it('makes every trigger eligible again on reset', () => {
    const m = new BattlecardMatcher([PRICE])
    m.match('too expensive', 0)
    expect(m.match('too expensive', 100)).toHaveLength(0)
    m.reset()
    expect(m.match('too expensive', 100)).toHaveLength(1)
  })
})

describe('the starter library', () => {
  it('ships a usable set out of the box', () => {
    expect(STARTER_TRIGGERS.length).toBeGreaterThanOrEqual(30)
  })

  it('has unique ids', () => {
    const ids = STARTER_TRIGGERS.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every trigger at least one phrase and every card something to say', () => {
    for (const t of STARTER_TRIGGERS) {
      expect(t.patterns.length).toBeGreaterThan(0)
      expect(t.patterns.every((p) => p.trim().length > 0)).toBe(true)
      expect(t.card.label.trim().length).toBeGreaterThan(0)
      expect(t.card.say.trim().length).toBeGreaterThan(0)
    }
  })

  // If the rep has to stop listening to parse it, it has cost them the
  // conversation it was meant to save.
  it('keeps every line readable mid-call', () => {
    for (const t of STARTER_TRIGGERS) {
      expect(t.card.say.length, `${t.id} is too long to read mid-call`).toBeLessThanOrEqual(90)
      expect(t.card.label.length, `${t.id} label is too long`).toBeLessThanOrEqual(24)
    }
  })

  it('has no trigger whose phrase would fire on almost any sentence', () => {
    for (const t of STARTER_TRIGGERS) {
      for (const p of t.patterns) {
        expect(p.trim().length, `${t.id}: "${p}" is too short to be specific`).toBeGreaterThan(3)
      }
    }
  })

  // A phrase belonging to two cards means one of them can never be the reason
  // the rail fired, which makes the library quietly untrustworthy.
  it('does not use the same phrase in two different triggers', () => {
    const seen = new Map<string, string>()
    for (const t of STARTER_TRIGGERS) {
      for (const p of t.patterns) {
        const key = p.toLowerCase().trim()
        expect(seen.has(key), `"${p}" is in both ${seen.get(key)} and ${t.id}`).toBe(false)
        seen.set(key, t.id)
      }
    }
  })
})
