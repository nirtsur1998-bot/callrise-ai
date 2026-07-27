import { describe, expect, it } from 'vitest'
import { groupKeyFor, type FusedCandidate } from '../fusion'
import { initialFsmContext, step, type FsmContext } from '../stateMachine'
import { DETECTION_TUNING } from '../types'

const T0 = 1_000_000

function candidate(
  overrides: Partial<FusedCandidate> & { appId: string; pid?: number }
): FusedCandidate {
  return {
    key: groupKeyFor(overrides.appId, overrides.pid),
    displayName: overrides.appId,
    confidence: 0.7,
    signals: ['process'],
    lastObservedAt: T0,
    firstObservedAt: T0,
    ...overrides
  }
}

/** Drive the FSM through a plain list of {now, candidates, command?} ticks, returning every result. */
function run(
  ticks: Array<{
    now: number
    candidates?: FusedCandidate[]
    command?: Parameters<typeof step>[1]['command']
  }>
): { context: FsmContext; results: ReturnType<typeof step>[] } {
  let context: FsmContext = initialFsmContext
  const results: ReturnType<typeof step>[] = []
  for (const tick of ticks) {
    const result = step(context, {
      now: tick.now,
      candidates: tick.candidates ?? [],
      command: tick.command
    })
    context = result.context
    results.push(result)
  }
  return { context, results }
}

describe('idle -> candidate -> detected', () => {
  it('promotes to detected only after sustaining the threshold for startSustainMs', () => {
    const zoom = candidate({ appId: 'zoom', pid: 1, confidence: 0.65 })
    const { context, results } = run([
      { now: T0, candidates: [zoom] },
      { now: T0 + 1_000, candidates: [zoom] },
      { now: T0 + DETECTION_TUNING.startSustainMs, candidates: [zoom] }
    ])
    expect(results[0].context.state.name).toBe('candidate')
    expect(results[1].context.state.name).toBe('candidate')
    expect(results[2].context.state.name).toBe('detected')
    expect(results[2].events).toEqual([
      { type: 'call-detected', call: expect.objectContaining({ appId: 'zoom', pid: 1 }) }
    ])
    expect(context.state.name).toBe('detected')
  })

  it('reverts to idle with no event if confidence drops before the sustain window elapses', () => {
    const zoom = candidate({ appId: 'zoom', pid: 1, confidence: 0.65 })
    const { results } = run([
      { now: T0, candidates: [zoom] },
      { now: T0 + 1_000, candidates: [] } // vanished
    ])
    expect(results[1].context.state.name).toBe('idle')
    expect(results[1].events).toEqual([])
  })

  it('never crosses threshold for a lone unknown-app mic-session (Voice Memos style false positive)', () => {
    const voiceMemo = candidate({ appId: 'unknown:voice-memos', confidence: 0.25 })
    const { results } = run([
      { now: T0, candidates: [voiceMemo] },
      { now: T0 + DETECTION_TUNING.startSustainMs, candidates: [voiceMemo] }
    ])
    expect(results.every((r) => r.context.state.name === 'idle')).toBe(true)
  })
})

describe('capturing -> ending -> idle', () => {
  function detectedContext(call: FusedCandidate): FsmContext {
    const { context } = run([
      { now: T0, candidates: [call] },
      { now: T0 + DETECTION_TUNING.startSustainMs, candidates: [call] }
    ])
    return context
  }

  it('starts capturing on a start-capture command', () => {
    const zoom = candidate({ appId: 'zoom', pid: 1, confidence: 0.65 })
    const detected = detectedContext(zoom)
    const now = T0 + DETECTION_TUNING.startSustainMs
    const result = step(detected, {
      now,
      candidates: [zoom],
      command: { type: 'start-capture', sessionId: 's1', mode: 'mic-only' }
    })
    expect(result.context.state.name).toBe('capturing')
    expect(result.events).toEqual([
      {
        type: 'capture-started',
        sessionId: 's1',
        call: expect.objectContaining({ appId: 'zoom' }),
        mode: 'mic-only'
      }
    ])
  })

  it('ends the capture after endSustainMs of low confidence, and blocks re-detection for hysteresisMs', () => {
    const zoom = candidate({ appId: 'zoom', pid: 1, confidence: 0.65 })
    let context = detectedContext(zoom)
    let now = T0 + DETECTION_TUNING.startSustainMs
    context = step(context, {
      now,
      candidates: [zoom],
      command: { type: 'start-capture', sessionId: 's1', mode: 'mic-only' }
    }).context

    // Confidence drops
    now += 1_000
    context = step(context, { now, candidates: [] }).context
    expect(context.state.name).toBe('ending')

    // Still within the grace window
    now += DETECTION_TUNING.endSustainMs - 1_000
    context = step(context, { now, candidates: [] }).context
    expect(context.state.name).toBe('ending')

    // Grace window elapses
    now += 2_000
    const ended = step(context, { now, candidates: [] })
    expect(ended.context.state.name).toBe('idle')
    expect(ended.events).toEqual([
      {
        type: 'capture-ended',
        sessionId: 's1',
        call: expect.objectContaining({ appId: 'zoom' }),
        reason: 'call-ended'
      }
    ])

    // Hysteresis: the same appId+pid can't re-trigger detection immediately after
    now += 1_000
    const zoomAgain = candidate({ appId: 'zoom', pid: 1, confidence: 0.9 })
    const blocked = step(ended.context, { now, candidates: [zoomAgain] })
    expect(blocked.context.state.name).toBe('idle')

    // But a different pid for the same app is NOT blocked
    const zoomOtherPid = candidate({ appId: 'zoom', pid: 2, confidence: 0.9 })
    const notBlocked = step(ended.context, { now, candidates: [zoomOtherPid] })
    expect(notBlocked.context.state.name).toBe('candidate')

    // After hysteresisMs elapses, the original pid can re-trigger
    const afterHysteresis = step(ended.context, {
      now: now + DETECTION_TUNING.hysteresisMs + 1,
      candidates: [zoomAgain]
    })
    expect(afterHysteresis.context.state.name).toBe('candidate')
  })

  it('recovers back to capturing if confidence rises again within the grace window (mute / breakout-room move)', () => {
    const zoom = candidate({ appId: 'zoom', pid: 1, confidence: 0.65 })
    let context = detectedContext(zoom)
    let now = T0 + DETECTION_TUNING.startSustainMs
    context = step(context, {
      now,
      candidates: [zoom],
      command: { type: 'start-capture', sessionId: 's1', mode: 'mic-only' }
    }).context

    now += 1_000
    context = step(context, { now, candidates: [] }).context
    expect(context.state.name).toBe('ending')

    // Recovers well before endSustainMs elapses
    now += 5_000
    const recovered = step(context, {
      now,
      candidates: [candidate({ appId: 'zoom', pid: 1, confidence: 0.7 })]
    })
    expect(recovered.context.state.name).toBe('capturing')
    expect((recovered.context.state as { sessionId: string }).sessionId).toBe('s1')
  })

  it("does not credit an ending detour toward a switch candidate's sustain timer", () => {
    // Regression: a stale otherCandidate.since surviving an ending->capturing
    // recovery let wall-clock time from an unrelated dip count toward the
    // OTHER call's 3s sustain requirement, firing a switch-offer the instant
    // the original call recovered instead of requiring genuine re-sustain.
    const zoom = candidate({ appId: 'zoom', pid: 1, confidence: 0.65 })
    let context = detectedContext(zoom)
    let now = T0 + DETECTION_TUNING.startSustainMs
    context = step(context, {
      now,
      candidates: [zoom],
      command: { type: 'start-capture', sessionId: 's1', mode: 'mic-only' }
    }).context

    // Teams starts accumulating sustain toward a switch-offer, but only 1s in.
    const teams = candidate({ appId: 'teams', pid: 2, confidence: 0.7 })
    now += 1_000
    context = step(context, { now, candidates: [zoom, teams] }).context
    expect(context.otherCandidate?.call.appId).toBe('teams')

    // Zoom dips below endThreshold -> 'ending'. Stay there for 4s (teams absent
    // from candidates entirely, so it's never re-evaluated during the detour).
    now += 500
    context = step(context, { now, candidates: [] }).context
    expect(context.state.name).toBe('ending')
    now += 4_000
    context = step(context, { now, candidates: [] }).context
    expect(context.state.name).toBe('ending')

    // Zoom recovers - elapsed wall-clock since teams was first seen is now
    // well past startSustainMs (3s), purely from the ending detour.
    now += 100
    const recovered = step(context, { now, candidates: [zoom, teams] })
    expect(recovered.context.state.name).toBe('capturing')
    // No switch-offer should fire on this very next tick - the fix clears
    // otherCandidate across the ending detour, so teams must sustain fresh.
    expect(recovered.events.some((e) => e.type === 'switch-offered')).toBe(false)
    expect(recovered.context.otherCandidate).toBeUndefined()

    // The following 'capturing' tick picks teams back up as a FRESH candidate
    // (since = this tick, not the stale pre-detour timestamp) - a real switch
    // offer now correctly requires its own full 3s of continuous sustain.
    now += 100
    const next = step(recovered.context, { now, candidates: [zoom, teams] })
    expect(next.context.otherCandidate?.call.appId).toBe('teams')
    expect(next.context.otherCandidate?.since).toBe(now)
  })

  it('stopping manually ends the capture with reason user-stopped', () => {
    const zoom = candidate({ appId: 'zoom', pid: 1, confidence: 0.65 })
    let context = detectedContext(zoom)
    const now = T0 + DETECTION_TUNING.startSustainMs
    context = step(context, {
      now,
      candidates: [zoom],
      command: { type: 'start-capture', sessionId: 's1', mode: 'full' }
    }).context

    const stopped = step(context, {
      now: now + 1_000,
      candidates: [zoom],
      command: { type: 'stop' }
    })
    expect(stopped.context.state.name).toBe('idle')
    expect(stopped.events).toEqual([
      {
        type: 'capture-ended',
        sessionId: 's1',
        call: expect.objectContaining({ appId: 'zoom' }),
        reason: 'user-stopped'
      }
    ])
  })
})

describe('detected without a decision', () => {
  it('emits call-lost and returns to idle if the call vanishes before any command arrives', () => {
    const zoom = candidate({ appId: 'zoom', pid: 1, confidence: 0.65 })
    const { context } = run([
      { now: T0, candidates: [zoom] },
      { now: T0 + DETECTION_TUNING.startSustainMs, candidates: [zoom] }
    ])
    expect(context.state.name).toBe('detected')

    const now = T0 + DETECTION_TUNING.startSustainMs + 1_000
    const result = step(context, { now, candidates: [] })
    expect(result.context.state.name).toBe('idle')
    expect(result.events).toEqual([
      { type: 'call-lost', call: expect.objectContaining({ appId: 'zoom' }) }
    ])
  })

  it('decline-detection returns to idle and still applies hysteresis (no re-nag loop)', () => {
    const zoom = candidate({ appId: 'zoom', pid: 1, confidence: 0.65 })
    const { context } = run([
      { now: T0, candidates: [zoom] },
      { now: T0 + DETECTION_TUNING.startSustainMs, candidates: [zoom] }
    ])
    const now = T0 + DETECTION_TUNING.startSustainMs + 1_000
    const declined = step(context, {
      now,
      candidates: [zoom],
      command: { type: 'decline-detection' }
    })
    expect(declined.context.state.name).toBe('idle')

    const stillBlocked = step(declined.context, { now: now + 1_000, candidates: [zoom] })
    expect(stillBlocked.context.state.name).toBe('idle')
  })
})

describe('second-call switch prompt', () => {
  function capturingContext(): { context: FsmContext; now: number } {
    const zoom = candidate({ appId: 'zoom', pid: 1, confidence: 0.65 })
    let now = T0
    let context = step(initialFsmContext, { now, candidates: [zoom] }).context
    now += DETECTION_TUNING.startSustainMs
    context = step(context, { now, candidates: [zoom] }).context
    context = step(context, {
      now,
      candidates: [zoom],
      command: { type: 'start-capture', sessionId: 's-zoom', mode: 'mic-only' }
    }).context
    return { context, now }
  }

  it('offers a switch once the second call sustains the start threshold while capturing', () => {
    let { context, now } = capturingContext()
    const zoom = candidate({ appId: 'zoom', pid: 1, confidence: 0.7 })
    const teams = candidate({ appId: 'teams', pid: 2, confidence: 0.65 })

    now += 1_000
    let result = step(context, { now, candidates: [zoom, teams] })
    context = result.context
    expect(context.state.name).toBe('capturing') // teams is only a shadow candidate so far

    now += DETECTION_TUNING.startSustainMs
    result = step(context, { now, candidates: [zoom, teams] })
    expect(result.context.state.name).toBe('capturing-with-pending')
    expect(result.events).toEqual([
      {
        type: 'switch-offered',
        current: expect.objectContaining({ appId: 'zoom' }),
        pending: expect.objectContaining({ appId: 'teams' })
      }
    ])
  })

  it('switching finalizes the old session and moves the pending call to detected (to go through the normal start flow)', () => {
    let { context, now } = capturingContext()
    const zoom = candidate({ appId: 'zoom', pid: 1, confidence: 0.7 })
    const teams = candidate({ appId: 'teams', pid: 2, confidence: 0.65 })
    now += 1_000
    context = step(context, { now, candidates: [zoom, teams] }).context
    now += DETECTION_TUNING.startSustainMs
    context = step(context, { now, candidates: [zoom, teams] }).context
    expect(context.state.name).toBe('capturing-with-pending')

    const switched = step(context, {
      now,
      candidates: [zoom, teams],
      command: { type: 'respond-to-switch', decision: 'switch' }
    })
    expect(switched.context.state.name).toBe('detected')
    expect(switched.events).toEqual([
      { type: 'switch-resolved', decision: 'switched' },
      {
        type: 'capture-ended',
        sessionId: 's-zoom',
        call: expect.objectContaining({ appId: 'zoom' }),
        reason: 'switched'
      }
    ])
  })

  it('keeping current returns to capturing on the original call', () => {
    let { context, now } = capturingContext()
    const zoom = candidate({ appId: 'zoom', pid: 1, confidence: 0.7 })
    const teams = candidate({ appId: 'teams', pid: 2, confidence: 0.65 })
    now += 1_000
    context = step(context, { now, candidates: [zoom, teams] }).context
    now += DETECTION_TUNING.startSustainMs
    context = step(context, { now, candidates: [zoom, teams] }).context

    const kept = step(context, {
      now,
      candidates: [zoom, teams],
      command: { type: 'respond-to-switch', decision: 'keep' }
    })
    expect(kept.context.state.name).toBe('capturing')
    expect(kept.events).toEqual([{ type: 'switch-resolved', decision: 'kept-current' }])
  })

  it('defaults to keep-current if the prompt times out with no response', () => {
    let { context, now } = capturingContext()
    const zoom = candidate({ appId: 'zoom', pid: 1, confidence: 0.7 })
    const teams = candidate({ appId: 'teams', pid: 2, confidence: 0.65 })
    now += 1_000
    context = step(context, { now, candidates: [zoom, teams] }).context
    now += DETECTION_TUNING.startSustainMs
    context = step(context, { now, candidates: [zoom, teams] }).context
    expect(context.state.name).toBe('capturing-with-pending')

    now += DETECTION_TUNING.switchPromptTimeoutMs + 1
    const timedOut = step(context, { now, candidates: [zoom, teams] })
    expect(timedOut.context.state.name).toBe('capturing')
    expect(timedOut.events).toEqual([{ type: 'switch-resolved', decision: 'timed-out' }])
  })

  it('if the original call ends naturally while a switch is pending, moves straight to the pending call', () => {
    let { context, now } = capturingContext()
    const zoom = candidate({ appId: 'zoom', pid: 1, confidence: 0.7 })
    const teams = candidate({ appId: 'teams', pid: 2, confidence: 0.65 })
    now += 1_000
    context = step(context, { now, candidates: [zoom, teams] }).context
    now += DETECTION_TUNING.startSustainMs
    context = step(context, { now, candidates: [zoom, teams] }).context
    expect(context.state.name).toBe('capturing-with-pending')

    now += 1_000
    const result = step(context, { now, candidates: [teams] }) // zoom vanished
    expect(result.context.state.name).toBe('detected')
    expect(result.events).toEqual([
      {
        type: 'capture-ended',
        sessionId: 's-zoom',
        call: expect.objectContaining({ appId: 'zoom' }),
        reason: 'call-ended'
      }
    ])
  })
})
