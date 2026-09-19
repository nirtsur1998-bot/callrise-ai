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
    const detectedState = detector.getState()
    expect(detectedState.name).toBe('detected')

    detector.applyCommand({
      type: 'start-capture',
      callId: detectedState.name === 'detected' ? detectedState.call.id : '',
      sessionId: 's1',
      mode: 'full'
    })
    expect(detector.getState().name).toBe('capturing')
    expect(events.some((e) => e.type === 'capture-started')).toBe(true)

    detector.stop()
  })

  it('BUG-007 regression: setting the CURRENTLY-CAPTURING app to never must not stop the live recording', () => {
    // A settings edit mid-call must not silently end a live recording - that
    // is a recorded call lost, not a suppressed prompt. isAppBlocked is read
    // live (so a Settings change takes effect immediately), and it must only
    // ever stop a candidate from being OFFERED, never make the FSM lose track
    // of the call it is already capturing.
    const adapter = new NullAdapter()
    let blockZoom = false
    const detector = new CallDetector({
      adapter,
      now: () => T0,
      isAppBlocked: (appId) => (blockZoom ? appId === 'zoom' : false)
    })
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
    const detectedState = detector.getState()
    expect(detectedState.name).toBe('detected')
    detector.applyCommand({
      type: 'start-capture',
      callId: detectedState.name === 'detected' ? detectedState.call.id : '',
      sessionId: 's1',
      mode: 'full'
    })
    expect(detector.getState().name).toBe('capturing')

    // The rep opens Settings mid-call and sets Zoom to 'never'.
    blockZoom = true
    let t = T0 + DETECTION_TUNING.startSustainMs
    // Keep emitting the same zoom signal the whole time - only the policy
    // predicate changed, the app itself never stopped talking.
    for (let elapsed = 0; elapsed <= DETECTION_TUNING.endSustainMs + 5_000; elapsed += 1_000) {
      t = T0 + DETECTION_TUNING.startSustainMs + elapsed
      adapter.emit({
        kind: 'own-virtual-device',
        appId: 'zoom',
        displayName: 'Zoom',
        pid: 1,
        observedAt: t,
        weight: 0
      })
      detector.tick(t)
    }

    expect(detector.getState().name).toBe('capturing')
    expect(events.some((e) => e.type === 'capture-ended')).toBe(false)

    detector.stop()
  })

  it('BUG-007: an app blocked by isAppBlocked never becomes a switch-offer candidate mid-capture', () => {
    const adapter = new NullAdapter()
    const detector = new CallDetector({
      adapter,
      now: () => T0,
      isAppBlocked: (appId) => appId === 'teams' // stands in for a 'never' appOverride
    })
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
    const detectedState = detector.getState()
    expect(detectedState.name).toBe('detected')
    detector.applyCommand({
      type: 'start-capture',
      callId: detectedState.name === 'detected' ? detectedState.call.id : '',
      sessionId: 's1',
      mode: 'full'
    })
    expect(detector.getState().name).toBe('capturing')

    // Teams shows up with signals that would normally sustain into a
    // switch-offer - it must never even become a shadow candidate.
    let t = T0 + DETECTION_TUNING.startSustainMs
    for (let i = 0; i < 5; i++) {
      t += 1_000
      // Keep zoom's own signal fresh so it isn't mistaken for the call ending.
      adapter.emit({
        kind: 'own-virtual-device',
        appId: 'zoom',
        displayName: 'Zoom',
        pid: 1,
        observedAt: t,
        weight: 0
      })
      adapter.emit({
        kind: 'mic-session',
        appId: 'teams',
        displayName: 'Teams',
        pid: 2,
        observedAt: t,
        weight: 0
      })
      adapter.emit({
        kind: 'process',
        appId: 'teams',
        displayName: 'Teams',
        pid: 2,
        observedAt: t,
        weight: 0
      })
      detector.tick(t)
    }
    t += DETECTION_TUNING.startSustainMs + 1_000
    adapter.emit({
      kind: 'own-virtual-device',
      appId: 'zoom',
      displayName: 'Zoom',
      pid: 1,
      observedAt: t,
      weight: 0
    })
    detector.tick(t)

    expect(detector.getState().name).toBe('capturing') // never capturing-with-pending
    expect(events.some((e) => e.type === 'switch-offered')).toBe(false)

    detector.stop()
  })
})
