// M26 Phase 4.4 — the repeat-fault threshold's own counting logic.
//
// Extracted as a pure function (transcription.ts's faultThresholdCrossed) so
// it can be tested directly, without a live Deepgram connection — there is no
// clean way to force healthTick, ingestAudio, or the socket message handler
// to genuinely throw from outside the module.
//
// THE BAR THIS PROTECTS: ending a session on the FIRST transient fault would
// be stricter than today's behaviour. Today an uncaught throw in healthTick
// is silently swallowed by the process-wide uncaughtException handler and the
// next tick proceeds normally — confirmed empirically during 4.4's design.
// Only faults that are clearly RECURRING within a short window should end the
// call; a hair-trigger threshold is a regression this test exists to catch.
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

const { faultThresholdCrossed, FAULT_THRESHOLD, FAULT_WINDOW_MS } = await import('../transcription')

describe('faultThresholdCrossed', () => {
  it('does not cross on a single fault', () => {
    const state = { faultCount: 0, firstFaultAt: null as number | null }
    expect(faultThresholdCrossed(state, 1000)).toBe(false)
    expect(state.faultCount).toBe(1)
  })

  it('does not cross for fewer than the threshold, all within the window', () => {
    const state = { faultCount: 0, firstFaultAt: null as number | null }
    for (let i = 0; i < FAULT_THRESHOLD - 1; i++) {
      expect(faultThresholdCrossed(state, 1000 + i)).toBe(false)
    }
    expect(state.faultCount).toBe(FAULT_THRESHOLD - 1)
  })

  it('crosses exactly on the threshold-th fault within the window', () => {
    const state = { faultCount: 0, firstFaultAt: null as number | null }
    let crossed = false
    for (let i = 0; i < FAULT_THRESHOLD; i++) {
      crossed = faultThresholdCrossed(state, 1000 + i)
    }
    expect(crossed).toBe(true)
    expect(state.faultCount).toBe(FAULT_THRESHOLD)
  })

  it('a fault after the window resets the count — not simply cumulative forever', () => {
    const state = { faultCount: 0, firstFaultAt: null as number | null }
    // One fault, then silence past the window — a genuinely isolated blip.
    faultThresholdCrossed(state, 0)
    const crossed = faultThresholdCrossed(state, FAULT_WINDOW_MS + 1)
    expect(crossed).toBe(false)
    expect(state.faultCount).toBe(1) // restarted, not 2
  })

  it('a fault exactly at the window boundary still counts as recurring, not a reset', () => {
    // The check is `now - firstFaultAt > FAULT_WINDOW_MS` — strictly greater
    // than, so landing EXACTLY on the boundary must still accumulate against
    // the original fault rather than starting a fresh window.
    const state = { faultCount: 0, firstFaultAt: null as number | null }
    faultThresholdCrossed(state, 0)
    faultThresholdCrossed(state, FAULT_WINDOW_MS)
    expect(state.faultCount).toBe(2)
    expect(state.firstFaultAt).toBe(0) // anchor unchanged — this was not a reset
  })

  it('three isolated blips, each outside the window, never end the session', () => {
    const state = { faultCount: 0, firstFaultAt: null as number | null }
    expect(faultThresholdCrossed(state, 0)).toBe(false)
    expect(faultThresholdCrossed(state, (FAULT_WINDOW_MS + 1) * 2)).toBe(false)
    expect(faultThresholdCrossed(state, (FAULT_WINDOW_MS + 1) * 4)).toBe(false)
  })
})
