import { describe, expect, it } from 'vitest'
import { ingestTurn, LiveCallStateEngine } from '../engine'
import { createInitialState, type LiveTurn } from '../types'

// A short, realistic transcript touching several Tier 0 extractors at once:
// a rep question, a price/budget objection, a rep monologue with a demo
// keyword, and a buyer sentiment turn. Individual extractor behavior is
// covered by their own test files — this only checks the wiring holds them
// all together correctly.
const transcript: LiveTurn[] = [
  { speaker: 1, role: 'other', text: 'Hi, thanks for hopping on the call today.', atMs: 0 },
  {
    speaker: 0,
    role: 'rep',
    text: 'Of course! To start, what does your team use today for this?',
    atMs: 4_000
  },
  {
    speaker: 1,
    role: 'other',
    text: 'Honestly it is just not in the budget right now, this quarter has been tight.',
    atMs: 9_000
  },
  {
    speaker: 0,
    role: 'rep',
    text: 'Got it, that makes sense. Let me walk you through how the pricing actually breaks down.',
    atMs: 14_000
  },
  {
    speaker: 1,
    role: 'other',
    text: 'That sounds great, I am excited to see it.',
    atMs: 40_000
  }
]

describe('LiveCallStateEngine', () => {
  it('wires every Tier 0 extractor together: folding a short transcript populates fields from multiple extractors at once', () => {
    const engine = new LiveCallStateEngine(0)
    for (const t of transcript) engine.ingest(t)
    const { state } = engine

    // detectQuestionDrought
    expect(state.turnCount).toBe(transcript.length)
    // detectSilenceGap
    expect(state.recentSilenceGapsMs).toHaveLength(transcript.length)
    // detectTalkRatio
    expect(state.talkRatio).not.toBeNull()
    // detectSentiment ("great", "excited" on the buyer's last turn)
    expect(state.sentimentTrajectory.length).toBeGreaterThan(0)
    // detectMentions ("not in the budget" trigger phrase)
    expect(state.budgetMentions.length).toBeGreaterThan(0)
    expect(state.objections.map((o) => o.type)).toContain('price')
    // detectCallStage (an objection surfaces mid-call, so it never reads as
    // 'opening' by the end even though the whole call is under a minute)
    expect(state.callStage).toBe('objections')
  })
})

describe('ingestTurn', () => {
  it('is pure: the same state, turn, and config produce deep-equal results without mutating the input state', () => {
    const state = createInitialState(0)
    const before = JSON.parse(JSON.stringify(state))
    const t: LiveTurn = {
      speaker: 0,
      role: 'rep',
      text: 'Quick question — how many seats do you need?',
      atMs: 1_000
    }

    const resultA = ingestTurn(state, t, {})
    const resultB = ingestTurn(state, t, {})

    expect(resultA).toEqual(resultB)
    expect(state).toEqual(before)
  })

  it('sets repSpeaker from the first rep turn and keeps it across subsequent turns', () => {
    let state = createInitialState(0)
    expect(state.repSpeaker).toBeNull()

    ;({ state } = ingestTurn(state, { speaker: 1, role: 'other', text: 'Hello', atMs: 0 }, {}))
    expect(state.repSpeaker).toBeNull()

    ;({ state } = ingestTurn(
      state,
      { speaker: 3, role: 'rep', text: 'Hi there, how can I help today?', atMs: 1_000 },
      {}
    ))
    expect(state.repSpeaker).toBe(3)

    ;({ state } = ingestTurn(
      state,
      { speaker: 1, role: 'other', text: 'Just looking around.', atMs: 2_000 },
      {}
    ))
    expect(state.repSpeaker).toBe(3)
  })
})
