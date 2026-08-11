import { describe, expect, it } from 'vitest'
import { replaySync } from '../callSimulator'
import type { LiveTurn } from '../../types'

const turn = (role: LiveTurn['role'], text: string, atMs: number, speaker = 0): LiveTurn => ({
  speaker,
  text,
  role,
  atMs
})

describe('replaySync', () => {
  it('returns the initial state unchanged (except callStartedAtMs default) for an empty transcript', () => {
    const { state, allSignals } = replaySync([])

    expect(state.callStartedAtMs).toBe(0)
    expect(state.turnCount).toBe(0)
    expect(state.callStage).toBe('opening')
    expect(allSignals).toHaveLength(0)
  })

  it("seeds callStartedAtMs from the transcript's own first turn, not from Date.now()", () => {
    const transcript = [turn('rep', 'Hey there', 500_000), turn('other', 'Hi', 505_000)]
    const { state } = replaySync(transcript)

    expect(state.callStartedAtMs).toBe(500_000)
    expect(state.turnCount).toBe(2)
  })

  it('folds every turn in order and collects signals emitted across the whole transcript', () => {
    // Same objection-then-monologue shape as engine.test.ts-style coverage, but
    // exercised through the simulator entry point rather than ingestTurn directly
    // — this is the piece other tests/CLI usage actually call.
    const transcript: LiveTurn[] = [
      turn('rep', 'Hey thanks for hopping on, how is it going today?', 0),
      turn('other', 'Good, excited to see what you have got here.', 4_000),
      turn(
        'rep',
        'Let me walk you through the whole platform end to end, starting with lead capture, then pipeline management, then reporting, then the mobile app, then integrations with every CRM under the sun.',
        8_000
      ),
      turn(
        'rep',
        'And there is a lot more too, onboarding is white glove and most teams are live within a week of signing.',
        100_000
      ),
      turn('other', "Honestly that's too expensive for us, not in the budget.", 108_000),
      turn('rep', 'Understood, let me see what we can do on pricing.', 112_000)
    ]

    const { state, allSignals } = replaySync(transcript)

    expect(state.turnCount).toBe(transcript.length)
    expect(state.lastUpdatedAtMs).toBe(112_000)
    expect(state.longestRepMonologueMs).toBeGreaterThanOrEqual(90_000)
    expect(state.objections.map((o) => o.type)).toContain('price')

    expect(allSignals.map((s) => s.type)).toEqual(
      expect.arrayContaining(['long-monologue', 'trigger-phrase'])
    )
    // Signals come back in the same order the turns that produced them were folded.
    const monologueIdx = allSignals.findIndex((s) => s.type === 'long-monologue')
    const triggerIdx = allSignals.findIndex((s) => s.type === 'trigger-phrase')
    expect(monologueIdx).toBeLessThan(triggerIdx)
  })

  it('honors a passed-in config the same way ingestTurn does', () => {
    const transcript: LiveTurn[] = [
      turn('rep', 'Hey there', 0),
      turn('other', "We'd like to request a POC first, honestly.", 4_000)
    ]

    const { allSignals } = replaySync(transcript, { extraTriggerPhrases: ['request a poc'] })

    expect(allSignals.some((s) => s.type === 'trigger-phrase' && s.subtype === 'custom')).toBe(true)
  })
})
