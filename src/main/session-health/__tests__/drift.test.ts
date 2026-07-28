import { describe, expect, it } from 'vitest'
import { DriftMeter, DRIFT_ALERT_MS } from '../drift'

const RATE = 16000
const CHANNELS = 1
/** 100ms of mono 16-bit PCM. */
const FRAME_BYTES = 0.1 * RATE * 2

/**
 * Feed frames for `seconds` of wall time where the device actually runs at
 * `rateFactor` x nominal (1.0 = perfect).
 */
function feed(meter: DriftMeter, seconds: number, rateFactor: number, fromMs = 0): number {
  let t = fromMs
  for (let i = 0; i < seconds * 10; i++) {
    t = fromMs + i * 100
    meter.onFrame(t, Math.round((FRAME_BYTES * rateFactor) / 2) * 2)
  }
  return t
}

describe('DriftMeter', () => {
  it('reads ~0 ppm for a perfect clock', () => {
    const m = new DriftMeter(RATE, CHANNELS)
    feed(m, 30, 1)
    expect(Math.abs(m.read().ppm)).toBeLessThan(1000)
    expect(Math.abs(m.read().offsetMs)).toBeLessThan(DRIFT_ALERT_MS)
  })

  it('reports a positive ppm for a device running fast', () => {
    const m = new DriftMeter(RATE, CHANNELS)
    feed(m, 30, 1.001) // +1000ppm
    const reading = m.read()
    expect(reading.ppm).toBeGreaterThan(500)
    expect(reading.points).toBeGreaterThan(10)
  })

  it('reports a negative ppm for a device running slow', () => {
    const m = new DriftMeter(RATE, CHANNELS)
    feed(m, 30, 0.999)
    expect(m.read().ppm).toBeLessThan(-500)
  })

  it('accumulates offset in the direction of the drift', () => {
    const m = new DriftMeter(RATE, CHANNELS)
    feed(m, 60, 1.01) // 1% fast for a minute ≈ +600ms of audio
    expect(m.read().offsetMs).toBeGreaterThan(DRIFT_ALERT_MS)
  })

  it('refuses to guess a ppm from too little data', () => {
    const m = new DriftMeter(RATE, CHANNELS)
    expect(m.read()).toEqual({ ppm: 0, offsetMs: 0, points: 0 })
    m.onFrame(0, FRAME_BYTES)
    expect(m.read().ppm).toBe(0)
  })

  // A discontinuity is a device event or a sleep, not accumulated drift.
  // Letting a controller absorb it is how a sync bug becomes a latency bug.
  it('reports a jump rather than folding a discontinuity into the slope', () => {
    const m = new DriftMeter(RATE, CHANNELS)
    const t = feed(m, 10, 1)
    // One frame carrying 2 seconds of audio: a resync-worthy discontinuity.
    const jump = m.onFrame(t + 100, 2 * RATE * 2)
    expect(jump).not.toBeNull()
    expect(jump?.deltaMs).toBeGreaterThan(200)
  })

  it('does not call ordinary jitter a jump', () => {
    const m = new DriftMeter(RATE, CHANNELS)
    let jumps = 0
    let t = 0
    for (let i = 0; i < 200; i++) {
      t += i % 3 === 0 ? 90 : 110 // ±10ms of delivery jitter
      if (m.onFrame(t, FRAME_BYTES)) jumps++
    }
    expect(jumps).toBe(0)
  })

  it('forgets history on resync', () => {
    const m = new DriftMeter(RATE, CHANNELS)
    feed(m, 30, 1.01)
    expect(m.read().offsetMs).toBeGreaterThan(DRIFT_ALERT_MS)
    m.resync()
    expect(m.read()).toEqual({ ppm: 0, offsetMs: 0, points: 0 })
  })

  it('accounts for channel count when converting bytes to sample frames', () => {
    const mono = new DriftMeter(RATE, 1)
    const stereo = new DriftMeter(RATE, 2)
    feed(mono, 20, 1)
    // Stereo frames carry twice the bytes for the same duration.
    let t = 0
    for (let i = 0; i < 200; i++) {
      t = i * 100
      stereo.onFrame(t, FRAME_BYTES * 2)
    }
    expect(Math.abs(mono.read().ppm)).toBeLessThan(1000)
    expect(Math.abs(stereo.read().ppm)).toBeLessThan(1000)
  })
})
