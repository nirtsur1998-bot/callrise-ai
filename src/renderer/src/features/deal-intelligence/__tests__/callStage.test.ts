import { describe, expect, it } from 'vitest'
import { detectCallStage } from '../tier0/callStage'
import { createInitialState, type LiveCallState, type LiveTurn, type Objection } from '../types'

const turn = (role: LiveTurn['role'], text: string, atMs: number, speaker = 0): LiveTurn => ({
  speaker,
  text,
  role,
  atMs
})

const state = (overrides: Partial<LiveCallState> = {}): LiveCallState => ({
  ...createInitialState(0),
  ...overrides
})

const fakeObjection = (): Objection => ({
  type: 'price',
  status: 'raised',
  raisedEvidence: { role: 'other', text: 'too expensive', atMs: 0 },
  lastMentionedAtMs: 0
})

describe('detectCallStage', () => {
  it('reads as opening for a fresh call with no objections and low elapsed time', () => {
    const s = state()
    const t = turn('rep', 'Hi, thanks for joining today', 5_000)

    expect(detectCallStage(s, t)).toBe('opening')
  })

  it('flips immediately to closing on a closing keyword, regardless of prior stage', () => {
    const s = state({ callStage: 'discovery' })
    const t = turn('other', "Let's talk about next steps", 120_000)

    expect(detectCallStage(s, t)).toBe('closing')
  })

  it('flips to closing on "sign", even mid-objection stage', () => {
    const s = state({ callStage: 'objections', objections: [fakeObjection()] })
    const t = turn('other', "Okay, let's sign and get this moving", 200_000)

    expect(detectCallStage(s, t)).toBe('closing')
  })

  // Deals don't un-close — once closing is reached, nothing later moves it
  // back, even text that would otherwise read as an objection.
  it('is sticky once closing — later turns never move it away', () => {
    const s = state({ callStage: 'closing', objections: [fakeObjection()] })
    const t = turn('other', "Actually, that's too expensive, I'm not sure about this", 300_000)

    expect(detectCallStage(s, t)).toBe('closing')
  })

  it('reads as objections when any objection is present and not already closing', () => {
    // Elapsed time is deliberately still inside the "opening window" here —
    // an objection existing overrides the opening read regardless of clock.
    const s = state({ objections: [fakeObjection()] })
    const t = turn('other', "Let's talk about integration", 5_000)

    expect(detectCallStage(s, t)).toBe('objections')
  })

  it('reads as demo-pitch on a demo keyword', () => {
    const s = state()
    const t = turn('rep', 'Let me show you how the dashboard works', 200_000)

    expect(detectCallStage(s, t)).toBe('demo-pitch')
  })

  it('reads as demo-pitch on "walk you through"', () => {
    const s = state()
    const t = turn('rep', "I'll walk you through the setup now", 200_000)

    expect(detectCallStage(s, t)).toBe('demo-pitch')
  })

  it('defaults to discovery past the opening window with none of the above', () => {
    const s = state()
    const t = turn('other', "Tell me about your team's current process", 200_000)

    expect(detectCallStage(s, t)).toBe('discovery')
  })
})
