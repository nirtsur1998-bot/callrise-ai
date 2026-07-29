import { describe, expect, it } from 'vitest'
import { sessionHealthNotice } from '../session-health-notice'
import type { TranscriptionHealthEvent } from '../../../../../preload/index.d'

function health(overrides: Partial<TranscriptionHealthEvent> = {}): TranscriptionHealthEvent {
  return {
    submittedSec: 10,
    acknowledgedSec: 10,
    lagSec: 0.2,
    medianLagSec: 0.2,
    tier: 'none',
    queuedSec: 0,
    shedSec: 0,
    resets: 0,
    gaps: [],
    liveness: 'ok',
    ...overrides
  }
}

describe('sessionHealthNotice', () => {
  it('is null before the first health tick', () => {
    expect(sessionHealthNotice(null)).toBeNull()
  })

  it('is null when everything is healthy — the plain latency reading stays', () => {
    expect(sessionHealthNotice(health())).toBeNull()
  })

  it('surfaces capture-dead as "No audio"', () => {
    expect(sessionHealthNotice(health({ liveness: 'capture-dead' }))?.label).toBe('No audio')
  })

  it('surfaces socket-dead as "Reconnecting…"', () => {
    expect(sessionHealthNotice(health({ liveness: 'socket-dead' }))?.label).toBe('Reconnecting…')
  })

  it('surfaces a reset tier as "Resyncing…"', () => {
    expect(sessionHealthNotice(health({ tier: 'reset' }))?.label).toBe('Resyncing…')
  })

  it('surfaces a shed tier as "Catching up…" with the measured lag in the tooltip', () => {
    const notice = sessionHealthNotice(health({ tier: 'shed', lagSec: 6.2 }))
    expect(notice?.label).toBe('Catching up…')
    expect(notice?.title).toContain('6.2s')
  })

  it('does not escalate a plain "warn" tier — that is not a real problem yet', () => {
    expect(sessionHealthNotice(health({ tier: 'warn' }))).toBeNull()
  })

  it('prioritizes liveness over tier when both are reported', () => {
    // capture-dead is the most urgent signal — it should win even if the tier
    // field happens to still read a lesser value.
    const notice = sessionHealthNotice(health({ liveness: 'capture-dead', tier: 'shed' }))
    expect(notice?.label).toBe('No audio')
  })
})
