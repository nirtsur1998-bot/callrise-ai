// BUG-176 — the in-call notice for near-total capture loss.
//
// Every fixture below is built from a REAL call in the founder's store, named
// by date, rather than from numbers chosen to make the rule look good.
import { describe, expect, it } from 'vitest'
import {
  lowCaptureNotice,
  LOW_CAPTURE_MIN_SUBMITTED_SEC
} from '../low-capture-notice'
import type { TranscriptionHealthEvent } from '../../../../../preload/index.d'

const health = (over: Partial<TranscriptionHealthEvent> = {}): TranscriptionHealthEvent =>
  ({
    submittedSec: 342,
    acknowledgedSec: 340,
    lagSec: 0.2,
    medianLagSec: 0.2,
    tier: 'none',
    queuedSec: 0,
    shedSec: 0,
    resets: 0,
    gaps: [],
    liveness: 'ok',
    driftPpm: 40,
    rejectedProducerFrames: 0,
    ...over
  }) as TranscriptionHealthEvent

describe('BUG-176 — near-total capture loss is said out loud, during the call', () => {
  it("fires on the founder's real 2026-09-02 call: 1 segment, 5m42s", () => {
    // 5m42s = 342s of audio, one segment. 0.18 segments/min.
    const n = lowCaptureNotice({ health: health({ submittedSec: 342 }), segmentCount: 1 })
    expect(n).not.toBeNull()
    expect(n!.title).toContain('Only 1 transcript segment')
  })

  it('fires on the other real failure the same morning: 1 segment, 4.6 min', () => {
    expect(lowCaptureNotice({ health: health({ submittedSec: 276 }), segmentCount: 1 })).not.toBeNull()
  })

  // CONTROLS — each is a real call shape that must NOT be warned about.
  it('CONTROL — a healthy call is silent: 204 segments in 16.5 min', () => {
    expect(lowCaptureNotice({ health: health({ submittedSec: 990 }), segmentCount: 204 })).toBeNull()
  })

  it('CONTROL — the quietest HEALTHY call measured (1.7 seg/min) is not warned about', () => {
    // 2026-09-01, 13 segments in 7.5 min. Above the 1.0 line, so it stays quiet:
    // the trigger sits inside an order-of-magnitude gap, not against real calls.
    expect(lowCaptureNotice({ health: health({ submittedSec: 450 }), segmentCount: 13 })).toBeNull()
  })

  it('CONTROL — nobody is speaking: liveness "silent" is not our failure to report', () => {
    expect(
      lowCaptureNotice({ health: health({ liveness: 'silent' }), segmentCount: 0 })
    ).toBeNull()
  })

  it('CONTROL — a dead capture or socket already has its own notice, never two', () => {
    for (const liveness of ['capture-dead', 'socket-dead'] as const) {
      expect(lowCaptureNotice({ health: health({ liveness }), segmentCount: 0 })).toBeNull()
    }
  })

  it('CONTROL — a call that has barely started is not judged', () => {
    expect(
      lowCaptureNotice({
        health: health({ submittedSec: LOW_CAPTURE_MIN_SUBMITTED_SEC - 1 }),
        segmentCount: 0
      })
    ).toBeNull()
    // ...and the moment it has enough audio, it is.
    expect(
      lowCaptureNotice({
        health: health({ submittedSec: LOW_CAPTURE_MIN_SUBMITTED_SEC }),
        segmentCount: 0
      })
    ).not.toBeNull()
  })

  it('CONTROL — no health payload yet means no claim', () => {
    expect(lowCaptureNotice({ health: null, segmentCount: 0 })).toBeNull()
  })

  it('pluralises honestly', () => {
    const n = lowCaptureNotice({ health: health({ submittedSec: 600 }), segmentCount: 2 })
    expect(n!.title).toContain('2 transcript segments')
  })
})
