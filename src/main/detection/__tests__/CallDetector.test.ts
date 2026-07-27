import { describe, expect, it } from 'vitest'
import { NullAdapter } from '../adapters/NullAdapter'
import { CallDetector } from '../CallDetector'
import { DETECTION_TUNING, type DetectorEvent } from '../types'

const T0 = 1_000_000

describe('CallDetector', () => {
  it('promotes a sustained known-app signal all the way to a call-detected event', () => {
    const adapter = new NullAdapter()
    const detector = new CallDetector({ adapter, now: () => T0 })
    const events: DetectorEvent[] = []
    detector.onEvent((e) => events.push(e))
    detector.start()

    adapter.emit({
      kind: 'mic-session',
      appId: 'zoom',
      displayName: 'Zoom',
      pid: 42,
      observedAt: T0,
      weight: 0
    })
    adapter.emit({
      kind: 'process',
      appId: 'zoom',
      displayName: 'Zoom',
      pid: 42,
      observedAt: T0,
      weight: 0
    })
    detector.tick(T0)
    expect(detector.getState().name).toBe('candidate')

    detector.tick(T0 + DETECTION_TUNING.startSustainMs)
    expect(detector.getState().name).toBe('detected')
    expect(events).toEqual([
      { type: 'call-detected', call: expect.objectContaining({ appId: 'zoom', pid: 42 }) }
    ])

    detector.stop()
  })

  it('filters out signals from our own process before they ever reach fusion', () => {
    const adapter = new NullAdapter()
    const OUR_PID = 9999
    const detector = new CallDetector({ adapter, now: () => T0, ourPid: OUR_PID })
    detector.start()

    // Our own virtual mic + capture would otherwise self-trigger a feedback loop.
    adapter.emit({
      kind: 'own-virtual-device',
      appId: 'callrise',
      displayName: 'CallRise AI',
      pid: OUR_PID,
      observedAt: T0,
      weight: 0
    })
    detector.tick(T0)
    detector.tick(T0 + DETECTION_TUNING.startSustainMs)
    expect(detector.getState().name).toBe('idle')

    detector.stop()
  })

  it('applyCommand moves a detected call into capturing immediately', () => {
    const adapter = new NullAdapter()
    const detector = new CallDetector({ adapter, now: () => T0 })
    const events: DetectorEvent[] = []
    detector.onEvent((e) => events.push(e))
    detector.start()

    adapter.emit({
      kind: 'own-virtual-device',
      appId: 'zoom',
      displayName: 'Zoom',
      pid: 1,
      observedAt: T0,
      weight: 0
    })
    detector.tick(T0)
    detector.tick(T0 + DETECTION_TUNING.startSustainMs)
    expect(detector.getState().name).toBe('detected')

    detector.applyCommand({ type: 'start-capture', sessionId: 's1', mode: 'full' })
    expect(detector.getState().name).toBe('capturing')
    expect(events.some((e) => e.type === 'capture-started')).toBe(true)

    detector.stop()
  })
})
