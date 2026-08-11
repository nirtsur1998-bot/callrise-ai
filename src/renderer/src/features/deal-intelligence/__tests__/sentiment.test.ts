import { describe, expect, it } from 'vitest'
import { detectSentiment } from '../tier0/sentiment'
import { createInitialState, SENTIMENT_TRAJECTORY_CAP, type LiveTurn } from '../types'

const turn = (role: LiveTurn['role'], text: string, atMs: number, speaker = 0): LiveTurn => ({
  speaker,
  text,
  role,
  atMs
})

describe('detectSentiment', () => {
  it('appends a positive sample for a buyer turn with a positive-lexicon word', () => {
    const t = turn('other', 'This looks great to us', 1_000)
    const { patch } = detectSentiment(createInitialState(0), t)

    expect(patch.sentimentTrajectory).toHaveLength(1)
    expect(patch.sentimentTrajectory?.[0].atMs).toBe(1_000)
    expect(patch.sentimentTrajectory?.[0].score).toBeGreaterThan(0)
  })

  it('appends a negative sample for a buyer turn with a negative-lexicon word', () => {
    const t = turn('other', "Honestly we're a bit concerned about this", 1_000)
    const { patch } = detectSentiment(createInitialState(0), t)

    expect(patch.sentimentTrajectory).toHaveLength(1)
    expect(patch.sentimentTrajectory?.[0].score).toBeLessThan(0)
  })

  // A neutral turn carries no signal — appending a 0 would dilute the trend
  // rather than describe it, per the file's own comment.
  it('does not append anything for a neutral buyer turn', () => {
    const t = turn('other', 'Can you repeat that please', 1_000)
    const { patch } = detectSentiment(createInitialState(0), t)

    expect(patch).toEqual({})
  })

  it('never scores a rep turn, regardless of wording', () => {
    const t = turn('rep', "This is great, I love it, it's perfect", 1_000)
    const { patch } = detectSentiment(createInitialState(0), t)

    expect(patch).toEqual({})
  })

  it('caps the trajectory at SENTIMENT_TRAJECTORY_CAP', () => {
    let state = createInitialState(0)
    const overflow = SENTIMENT_TRAJECTORY_CAP + 10
    for (let i = 0; i < overflow; i++) {
      const { patch } = detectSentiment(state, turn('other', 'great', i * 1_000, 0))
      state = { ...state, ...patch }
    }

    expect(state.sentimentTrajectory).toHaveLength(SENTIMENT_TRAJECTORY_CAP)
    // the newest sample survives — the cap drops from the front, not the back
    const last = state.sentimentTrajectory[state.sentimentTrajectory.length - 1]
    expect(last.atMs).toBe((overflow - 1) * 1_000)
  })
})
