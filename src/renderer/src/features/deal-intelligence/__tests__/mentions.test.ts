import { describe, expect, it } from 'vitest'
import { detectMentions } from '../tier0/mentions'
import { createInitialState, type LiveCallState, type LiveTurn } from '../types'

const turn = (role: LiveTurn['role'], text: string, atMs = 0, speaker = 0): LiveTurn => ({
  speaker,
  text,
  role,
  atMs
})

const noConfig = { extraTriggerPhrases: [] as string[] }
const state = (agendaTopics: string[] = []): LiveCallState => createInitialState(0, agendaTopics)

describe('detectMentions', () => {
  it('fires a trigger-phrase signal and raises a price objection for a built-in buyer phrase', () => {
    const t = turn('other', "Honestly it's just not in the budget right now", 1_000)
    const { patch, signals } = detectMentions(state(), t, noConfig)

    expect(signals).toHaveLength(1)
    expect(signals[0].type).toBe('trigger-phrase')
    expect(signals[0].subtype).toBe('price')

    expect(patch.objections).toHaveLength(1)
    expect(patch.objections?.[0].type).toBe('price')
    expect(patch.objections?.[0].status).toBe('raised')
    expect(patch.objections?.[0].lastMentionedAtMs).toBe(1_000)
  })

  // Trigger phrases are only meaningful as something the BUYER said — the
  // rep using the same words isn't the buyer raising an objection.
  it('does not fire a trigger-phrase signal or objection when the rep says the identical words', () => {
    const t = turn('rep', "Honestly it's just not in the budget right now", 1_000)
    const { patch, signals } = detectMentions(state(), t, noConfig)

    expect(signals).toHaveLength(0)
    expect(patch.objections).toHaveLength(0)
  })

  it('bumps lastMentionedAtMs on the existing objection instead of duplicating it', () => {
    const first = detectMentions(state(), turn('other', 'not in the budget', 1_000), noConfig)
    const afterFirst = { ...state(), ...first.patch }

    const second = detectMentions(
      afterFirst,
      turn('other', 'it is just too expensive for us', 5_000),
      noConfig
    )

    expect(second.patch.objections).toHaveLength(1)
    expect(second.patch.objections?.[0].lastMentionedAtMs).toBe(5_000)
    // the original raised evidence is untouched — only the timestamp bumps
    expect(second.patch.objections?.[0].raisedEvidence.atMs).toBe(1_000)
  })

  it('treats a dollar amount as a budget mention', () => {
    const t = turn('other', "It's around $5,000 give or take", 1_000)
    const { patch } = detectMentions(state(), t, noConfig)

    expect(patch.budgetMentions).toHaveLength(1)
    expect(patch.budgetMentions?.[0].term).toBe('budget')
  })

  it('accumulates evidence on the SAME budget mention across repeat turns rather than duplicating it', () => {
    const first = detectMentions(
      state(),
      turn('other', 'Our budget is pretty tight', 1_000),
      noConfig
    )
    expect(first.patch.budgetMentions).toHaveLength(1)
    expect(first.patch.budgetMentions?.[0].evidence).toHaveLength(1)

    const afterFirst = { ...state(), ...first.patch }
    const second = detectMentions(
      afterFirst,
      turn('other', 'Again, the budget just is not there', 4_000),
      noConfig
    )
    expect(second.patch.budgetMentions).toHaveLength(1)
    expect(second.patch.budgetMentions?.[0].evidence).toHaveLength(2)
  })

  it('treats the literal word "budget" as a budget mention', () => {
    const t = turn('other', "That's outside our budget for this year", 1_000)
    const { patch } = detectMentions(state(), t, noConfig)

    expect(patch.budgetMentions).toHaveLength(1)
    expect(patch.budgetMentions?.[0].term).toBe('budget')
  })

  it('flags a timeline keyword like "next quarter"', () => {
    const t = turn('other', "We're hoping to roll this out next quarter", 1_000)
    const { patch } = detectMentions(state(), t, noConfig)

    expect(patch.timelineMentions).toHaveLength(1)
    expect(patch.timelineMentions?.[0].term).toBe('next quarter')
  })

  it('treats a configured extraTriggerPhrase the same as a built-in one', () => {
    const config = { ...noConfig, extraTriggerPhrases: ['request a poc'] }
    const t = turn('other', "We'd like to request a POC first", 1_000)
    const { signals } = detectMentions(state(), t, config)

    expect(signals).toHaveLength(1)
    expect(signals[0].type).toBe('trigger-phrase')
    expect(signals[0].subtype).toBe('custom')
  })

  it('covers an agenda topic the first time it appears in any non-unknown turn, never twice', () => {
    const s0 = state(['pricing', 'integration'])

    // a REP turn covers a topic too — coverage tracks whether the topic came
    // up at all, not who brought it up
    const first = detectMentions(s0, turn('rep', "Let's talk about pricing today", 1_000), noConfig)
    expect(first.patch.topicsCovered).toEqual(['pricing'])
    const s1 = { ...s0, ...first.patch }

    const second = detectMentions(s1, turn('other', 'How does integration work?', 2_000), noConfig)
    expect(second.patch.topicsCovered).toEqual(['pricing', 'integration'])
    const s2 = { ...s1, ...second.patch }

    const third = detectMentions(s2, turn('rep', 'Circling back to pricing again', 3_000), noConfig)
    expect(third.patch.topicsCovered).toEqual(['pricing', 'integration'])
  })

  it('is a no-op for unknown-role turns', () => {
    const t = turn('unknown', 'not in the budget, pricing', 1_000)
    const { patch, signals } = detectMentions(state(['pricing']), t, noConfig)

    expect(patch).toEqual({})
    expect(signals).toEqual([])
  })
})
