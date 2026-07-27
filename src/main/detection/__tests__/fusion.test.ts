import { describe, expect, it } from 'vitest'
import { fuseSignals, weightForSignal } from '../fusion'
import { DETECTION_TUNING, type DetectionSignal } from '../types'

const T0 = 1_000_000

function signal(overrides: Partial<DetectionSignal>): DetectionSignal {
  return {
    kind: 'process',
    appId: 'zoom',
    displayName: 'Zoom',
    observedAt: T0,
    weight: 0,
    ...overrides
  }
}

describe('weightForSignal', () => {
  it('scores own-virtual-device the strongest', () => {
    expect(weightForSignal(signal({ kind: 'own-virtual-device' }))).toBe(
      DETECTION_TUNING.weights['own-virtual-device']
    )
  })

  it('scores mic-session higher for a known app than an unknown one', () => {
    const known = signal({ kind: 'mic-session', appId: 'zoom' })
    const unknown = signal({ kind: 'mic-session', appId: 'unknown:some-voice-memo-app' })
    expect(weightForSignal(known)).toBe(DETECTION_TUNING.weights['mic-session-known'])
    expect(weightForSignal(unknown)).toBe(DETECTION_TUNING.weights['mic-session-unknown'])
    expect(weightForSignal(known)).toBeGreaterThan(weightForSignal(unknown))
  })
})

describe('fuseSignals', () => {
  it('sums distinct signal kinds for the same group and caps at 1.0', () => {
    const signals = [
      signal({ kind: 'mic-session', pid: 100 }),
      signal({ kind: 'process', pid: 100 }),
      signal({ kind: 'window-title', pid: 100, title: 'Zoom Meeting' }),
      signal({ kind: 'output-activity', pid: 100 }),
      signal({ kind: 'calendar', pid: 100 })
    ]
    const [candidate] = fuseSignals(signals, T0)
    const expected = Math.min(
      1,
      DETECTION_TUNING.weights['mic-session-known'] +
        DETECTION_TUNING.weights.process +
        DETECTION_TUNING.weights['window-title'] +
        DETECTION_TUNING.weights['output-activity'] +
        DETECTION_TUNING.weights.calendar
    )
    expect(candidate.confidence).toBeCloseTo(expected)
    expect(candidate.signals).toHaveLength(5)
  })

  it('does not double-count two signals of the same kind', () => {
    const signals = [
      signal({ kind: 'process', pid: 1 }),
      signal({ kind: 'process', pid: 1, observedAt: T0 + 100 })
    ]
    const [candidate] = fuseSignals(signals, T0 + 100)
    expect(candidate.confidence).toBeCloseTo(DETECTION_TUNING.weights.process)
  })

  it('keeps distinct pids as separate candidates', () => {
    const signals = [signal({ pid: 1, appId: 'zoom' }), signal({ pid: 2, appId: 'teams' })]
    const candidates = fuseSignals(signals, T0)
    expect(candidates).toHaveLength(2)
  })

  it('groups signals with no pid by appId (browser-hosted apps)', () => {
    const signals = [
      signal({ kind: 'window-title', appId: 'meet', title: 'Meet - abc' }),
      signal({ kind: 'process', appId: 'meet' })
    ]
    const candidates = fuseSignals(signals, T0)
    expect(candidates).toHaveLength(1)
    expect(candidates[0].confidence).toBeCloseTo(
      DETECTION_TUNING.weights['window-title'] + DETECTION_TUNING.weights.process
    )
  })

  it('drops signals outside the rolling window', () => {
    const stale = signal({ pid: 5, observedAt: T0 - DETECTION_TUNING.signalWindowMs - 1 })
    const fresh = signal({ pid: 5, kind: 'window-title', observedAt: T0 })
    const candidates = fuseSignals([stale, fresh], T0)
    expect(candidates[0].signals).toEqual(['window-title'])
  })

  it('sorts candidates by confidence descending', () => {
    const weak = signal({ pid: 1, kind: 'process' })
    const strong = signal({ pid: 2, kind: 'own-virtual-device' })
    const candidates = fuseSignals([weak, strong], T0)
    expect(candidates[0].pid).toBe(2)
  })

  it('a lone unknown-app mic-session never reaches the start threshold on its own', () => {
    // This is exactly the "Voice Memos / dictation" false-positive case: mic-session
    // on an unrecognized app scores 0.25, well under the 0.60 start threshold.
    const [candidate] = fuseSignals(
      [signal({ kind: 'mic-session', appId: 'unknown:voice-memos' })],
      T0
    )
    expect(candidate.confidence).toBeLessThan(DETECTION_TUNING.startThreshold)
  })
})
