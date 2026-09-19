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
    driftPpm: 0,
    rejectedProducerFrames: 0,
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

  it('BUG-009: surfaces silence as "Listening…", not nothing', () => {
    // The gap this bug reports: during silence the transcript stops growing
    // and the UI looked EXACTLY like a healthy session (this test's own
    // "everything is healthy" case above) — nothing distinguished "still
    // recording, nobody's talking" from "quietly dead".
    const notice = sessionHealthNotice(health({ liveness: 'silent' }))
    expect(notice?.label).toBe('Listening…')
    expect(notice?.title).toMatch(/still recording/i)
  })

  it('BUG-009: a real lag problem is never masked by the silence label', () => {
    // 'silent' is deliberately non-fatal (per liveness.ts's own comment) and
    // must never outrank an actual reset/shed condition that happens to
    // coincide with a quiet stretch.
    expect(sessionHealthNotice(health({ liveness: 'silent', tier: 'reset' }))?.label).toBe(
      'Resyncing…'
    )
    expect(sessionHealthNotice(health({ liveness: 'silent', tier: 'shed' }))?.label).toBe(
      'Catching up…'
    )
  })

  it('BUG-009: capture-dead and socket-dead still outrank silence', () => {
    expect(sessionHealthNotice(health({ liveness: 'capture-dead' }))?.label).toBe('No audio')
    expect(sessionHealthNotice(health({ liveness: 'socket-dead' }))?.label).toBe('Reconnecting…')
  })
})
