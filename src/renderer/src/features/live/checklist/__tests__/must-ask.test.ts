import { describe, expect, it } from 'vitest'
import { MUST_ASK, MustAskChecklist, preHangupWarning, type MustAskItem } from '../must-ask'

const coverAll = (c: MustAskChecklist): void => {
  c.observe('what is your budget and timeline')
  c.observe('who signs and who else are you evaluating')
  c.observe('what would success look like')
}

describe('MustAskChecklist', () => {
  it('starts with everything missing', () => {
    const s = new MustAskChecklist().state()
    expect(s.covered.size).toBe(0)
    expect(s.missing).toHaveLength(MUST_ASK.length)
    expect(s.progress).toBe(0)
  })

  it('covers an item when its topic comes up', () => {
    const c = new MustAskChecklist()
    expect(c.observe('so what sort of budget do you have for this')).toEqual(['budget'])
    expect(c.state().covered.has('budget')).toBe(true)
  })

  it('reports only what is NEWLY covered', () => {
    const c = new MustAskChecklist()
    c.observe('what is the budget')
    expect(c.observe('and the budget again')).toEqual([])
  })

  it('can cover several items from one stretch of talk', () => {
    const c = new MustAskChecklist()
    const newly = c.observe('what is your budget, and what timeline are you working to')
    expect(newly.sort()).toEqual(['budget', 'timeline'])
  })

  // Something asked in minute two is still asked in minute forty. Un-checking
  // as the topic drifts would make the checklist flicker, and a flickering
  // checklist is one nobody trusts.
  it('keeps coverage sticky once earned', () => {
    const c = new MustAskChecklist()
    c.observe('what is the budget')
    c.observe('anyway, lovely weather')
    expect(c.state().covered.has('budget')).toBe(true)
  })

  it('tracks progress as a fraction', () => {
    const c = new MustAskChecklist()
    c.observe('what is the budget')
    expect(c.state().progress).toBeCloseTo(1 / MUST_ASK.length)
    coverAll(c)
    expect(c.state().progress).toBe(1)
  })

  it('keeps `missing` in list order, so the UI never reorders under the eye', () => {
    const c = new MustAskChecklist()
    c.observe('what timeline are you working to')
    const order = c.state().missing.map((m) => m.id)
    const expected = MUST_ASK.filter((m) => m.id !== 'timeline').map((m) => m.id)
    expect(order).toEqual(expected)
  })

  it('is case- and punctuation-insensitive', () => {
    const c = new MustAskChecklist()
    expect(c.observe("What's the BUDGET, then?")).toEqual(['budget'])
  })

  it('stays quiet on unrelated talk', () => {
    const c = new MustAskChecklist()
    expect(c.observe('how was your weekend then')).toEqual([])
    expect(c.observe('')).toEqual([])
  })

  it('resets for the next call', () => {
    const c = new MustAskChecklist()
    coverAll(c)
    c.reset()
    expect(c.state().covered.size).toBe(0)
  })
})

describe('preHangupWarning', () => {
  const state = (coveredIds: string[]): ReturnType<MustAskChecklist['state']> => {
    const c = new MustAskChecklist()
    const phraseFor: Record<string, string> = {
      budget: 'what is the budget',
      timeline: 'what timeline are you working to',
      'decision-process': 'who signs off on this',
      competition: 'who else are you evaluating',
      success: 'what would success look like'
    }
    for (const id of coveredIds) c.observe(phraseFor[id])
    return c.state()
  }

  // A checklist that congratulates you is noise.
  it('says nothing when everything is covered', () => {
    expect(
      preHangupWarning(state(['budget', 'timeline', 'decision-process', 'competition', 'success']))
    ).toBeNull()
  })

  // Nothing covered is not a rep who forgot five questions — it is a call that
  // was never a discovery call. Listing all five at them is how a feature gets
  // switched off.
  it('says nothing when NOTHING was covered', () => {
    expect(preHangupWarning(state([]))).toBeNull()
  })

  it('names the single gap directly', () => {
    const warning = preHangupWarning(
      state(['budget', 'decision-process', 'competition', 'success'])
    )
    expect(warning).toBe('You never asked about their timeline.')
  })

  it('lists several gaps readably', () => {
    const warning = preHangupWarning(state(['budget', 'timeline']))
    expect(warning).toContain('Before you go')
    expect(warning).toContain(' or ')
    expect(warning).toContain('competition')
  })

  it('joins exactly two gaps with "or" and no comma', () => {
    const warning = preHangupWarning(state(['budget', 'timeline', 'decision-process']))
    expect(warning).toBe("Before you go: you haven't covered competition or success criteria.")
  })
})

describe('the must-ask list itself', () => {
  it('covers the five things a discovery call has to establish', () => {
    expect(MUST_ASK.map((m) => m.id).sort()).toEqual([
      'budget',
      'competition',
      'decision-process',
      'success',
      'timeline'
    ])
  })

  it('gives every item patterns and something to say when missed', () => {
    for (const item of MUST_ASK as MustAskItem[]) {
      expect(item.patterns.length).toBeGreaterThan(0)
      expect(item.label.trim()).not.toBe('')
      expect(item.missedPrompt.trim().endsWith('.')).toBe(true)
    }
  })

  // A phrase in two items means one of them can never be the reason a box got
  // ticked, which makes the checklist quietly wrong.
  it('does not share a phrase between two items', () => {
    const seen = new Map<string, string>()
    for (const item of MUST_ASK) {
      for (const p of item.patterns) {
        expect(seen.has(p), `"${p}" is in both ${seen.get(p)} and ${item.id}`).toBe(false)
        seen.set(p, item.id)
      }
    }
  })

  // Precision over recall, as with battlecards: a box that ticks itself on
  // ordinary conversation makes the whole checklist a lie.
  it('has no pattern short enough to fire on anything', () => {
    for (const item of MUST_ASK) {
      for (const p of item.patterns) {
        expect(p.length, `${item.id}: "${p}"`).toBeGreaterThan(4)
      }
    }
  })
})
