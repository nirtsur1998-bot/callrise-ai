// BUG-152 — the Live screen's exit, as a decision a test can actually reach.
import { describe, expect, it } from 'vitest'
import { shouldOfferPostCallExit, isTerminalStatus } from '../post-call-exit'
import type { LiveStatus } from '../types'

describe('post-call exit', () => {
  it('THE BUG: a call that died with a transcript on screen gets an exit', () => {
    // The founder's case. The watchdog fired onCaptureLost, which sets
    // 'no-device' — it does NOT save-and-navigate the way Stop does — and
    // LiveView's `if (!hasTranscript)` gate then skips every full-screen
    // state, leaving the in-call layout whose only control is "Reconnect"
    // (which starts a NEW call). No way back.
    expect(shouldOfferPostCallExit('no-device', true)).toBe(true)
  })

  it('every terminal status with a transcript offers the exit', () => {
    // Not just no-device: 'error' has the identical shape, and a call that
    // reaches 'idle' while its transcript is still on screen is stuck the
    // same way. Enumerated rather than spot-checked so a new terminal status
    // has to be considered here.
    for (const s of ['idle', 'no-device', 'error', 'denied', 'no-key'] as LiveStatus[]) {
      expect(shouldOfferPostCallExit(s, true), `${s} should offer an exit`).toBe(true)
    }
  })

  it('a LIVE call never offers it — that would be a second stop button', () => {
    // The control that matters most. Offering "Done" mid-call, next to Stop,
    // is a way to lose a call in progress.
    for (const s of [
      'attaching',
      'requesting',
      'connecting',
      'listening',
      'paused'
    ] as LiveStatus[]) {
      expect(shouldOfferPostCallExit(s, true), `${s} must NOT offer an exit`).toBe(false)
    }
  })

  it('no transcript means the full-screen states already have their own actions', () => {
    for (const s of ['idle', 'no-device', 'error'] as LiveStatus[]) {
      expect(shouldOfferPostCallExit(s, false)).toBe(false)
    }
  })

  it('isTerminalStatus does not quietly treat a live status as finished', () => {
    expect(isTerminalStatus('listening')).toBe(false)
    expect(isTerminalStatus('paused')).toBe(false)
    expect(isTerminalStatus('reconnecting')).toBe(false)
    expect(isTerminalStatus('idle')).toBe(true)
  })
})
