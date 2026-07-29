import { describe, expect, it } from 'vitest'
import { tone, interleave } from '../channel-test'
import { CrossTalkGate, dominantChannel, CROSSTALK_TUNING } from '../crosstalk-gate'

const RATE = 16000

function silentLike(signal: Int16Array): Int16Array {
  return new Int16Array(signal.length)
}

/** One interleaved stereo frame: [mic, buyer]. */
function stereoFrame(micHz: number | null, buyerHz: number | null, ms = 20): ArrayBufferLike {
  const mic = micHz ? tone(micHz, ms, RATE) : silentLike(tone(440, ms, RATE))
  const buyer = buyerHz ? tone(buyerHz, ms, RATE) : silentLike(tone(440, ms, RATE))
  return interleave([mic, buyer])
}

describe('dominantChannel — pure decision', () => {
  it('picks the louder channel when the ratio clears the threshold', () => {
    const verdict = dominantChannel(0.3, 0.05)
    expect(verdict).toMatchObject({ state: 'dominant', channel: 0 })
  })

  it('picks channel 1 when it dominates', () => {
    const verdict = dominantChannel(0.02, 0.3)
    expect(verdict).toMatchObject({ state: 'dominant', channel: 1 })
  })

  it('calls it ambiguous when both channels carry comparable energy (real cross-talk)', () => {
    const verdict = dominantChannel(0.2, 0.15)
    expect(verdict.state).toBe('ambiguous')
  })

  it('calls it silent when both channels are below the floor', () => {
    const verdict = dominantChannel(0.001, 0.002)
    expect(verdict.state).toBe('silent')
  })

  it('treats a silent second channel as full dominance for the other, regardless of ratio', () => {
    const verdict = dominantChannel(0.02, 0.001)
    expect(verdict).toMatchObject({ state: 'dominant', channel: 0 })
  })

  it('honors a custom dominance ratio', () => {
    const loose = dominantChannel(0.1, 0.06, { silenceFloor: 0.01, dominanceRatio: 1.5 })
    expect(loose.state).toBe('dominant')
    const strict = dominantChannel(0.1, 0.06, { silenceFloor: 0.01, dominanceRatio: 3 })
    expect(strict.state).toBe('ambiguous')
  })
})

describe('CrossTalkGate — headphones (clean separation)', () => {
  it('agrees with Deepgram when only the claimed channel has energy', () => {
    const gate = new CrossTalkGate()
    for (let t = 0; t < 200; t += 20) {
      gate.observe({ atMs: t, bytes: stereoFrame(200, null) }) // mic only
    }
    expect(gate.disagreesWithClaim(0, 0, 200)).toBe(false)
  })

  it('agrees with Deepgram for the buyer channel too', () => {
    const gate = new CrossTalkGate()
    for (let t = 0; t < 200; t += 20) {
      gate.observe({ atMs: t, bytes: stereoFrame(null, 200) }) // buyer only
    }
    expect(gate.disagreesWithClaim(1, 0, 200)).toBe(false)
  })
})

describe('CrossTalkGate — loudspeaker (acoustic leak)', () => {
  it('flags a disagreement when the OTHER channel actually dominated', () => {
    const gate = new CrossTalkGate()
    // Deepgram says channel 0 (mic) spoke, but the real energy is on
    // channel 1 (buyer) the whole time — the leak signature.
    for (let t = 0; t < 200; t += 20) {
      gate.observe({ atMs: t, bytes: stereoFrame(null, 200) })
    }
    expect(gate.disagreesWithClaim(0, 0, 200)).toBe(true)
  })

  it('does NOT flag a disagreement for genuine simultaneous talk (ambiguous, not wrong)', () => {
    const gate = new CrossTalkGate()
    for (let t = 0; t < 200; t += 20) {
      gate.observe({ atMs: t, bytes: stereoFrame(200, 220) }) // both channels loud
    }
    // Ambiguous must never be reported as "disagrees" — that would imply
    // confident reassignment where there is none.
    expect(gate.disagreesWithClaim(0, 0, 200)).toBe(false)
    expect(gate.disagreesWithClaim(1, 0, 200)).toBe(false)
  })

  it('does not flag genuine silence as a disagreement', () => {
    const gate = new CrossTalkGate()
    for (let t = 0; t < 200; t += 20) {
      gate.observe({ atMs: t, bytes: stereoFrame(null, null) })
    }
    expect(gate.disagreesWithClaim(0, 0, 200)).toBe(false)
  })
})

describe('CrossTalkGate — windowing', () => {
  it('returns no-data for a window with no observed samples', () => {
    const gate = new CrossTalkGate()
    gate.observe({ atMs: 0, bytes: stereoFrame(200, null) })
    expect(gate.dominantChannelFor(10_000, 10_200)).toEqual({ state: 'no-data' })
  })

  it('evicts samples older than the configured window', () => {
    const gate = new CrossTalkGate(1_000)
    gate.observe({ atMs: 0, bytes: stereoFrame(200, null) })
    gate.observe({ atMs: 5_000, bytes: stereoFrame(null, 200) })
    // The t=0 sample should be long evicted by the time t=5000 lands.
    expect(gate.dominantChannelFor(0, 100)).toEqual({ state: 'no-data' })
  })

  it('reset() clears all history', () => {
    const gate = new CrossTalkGate()
    gate.observe({ atMs: 0, bytes: stereoFrame(200, null) })
    gate.reset()
    expect(gate.dominantChannelFor(0, 100)).toEqual({ state: 'no-data' })
  })

  it('only considers samples within the queried window, not the whole history', () => {
    const gate = new CrossTalkGate()
    gate.observe({ atMs: 0, bytes: stereoFrame(200, null) }) // mic-only, early
    gate.observe({ atMs: 1000, bytes: stereoFrame(null, 200) }) // buyer-only, later
    // Querying only the early window should see mic dominance, unaffected
    // by the later buyer-only sample.
    const early = gate.dominantChannelFor(0, 50)
    expect(early).toMatchObject({ state: 'dominant', channel: 0 })
    const late = gate.dominantChannelFor(950, 1050)
    expect(late).toMatchObject({ state: 'dominant', channel: 1 })
  })
})

describe('CROSSTALK_TUNING', () => {
  it('has a dominance ratio comfortably above 1 (not trivially satisfied by noise)', () => {
    expect(CROSSTALK_TUNING.dominanceRatio).toBeGreaterThan(1)
  })
})
