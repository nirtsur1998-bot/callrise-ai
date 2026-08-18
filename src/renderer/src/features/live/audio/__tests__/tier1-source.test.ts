import { describe, expect, it } from 'vitest'
import { shouldUseDenoisedSource, tier1UiState, Tier1Ring } from '../tier1-source'
import type { Tier1Status } from '../tier1-types'

function status(over: Partial<Tier1Status> = {}): Tier1Status {
  return {
    engineAvailable: true,
    engineRunning: true,
    connected: true,
    denoisingActive: true,
    enginePath: 'C:\\x\\kern_bridge.exe',
    ...over
  }
}

// THE GUARD THAT DECIDES WHETHER A USER'S CALL AUDIO GETS REPLACED.
//
// Routing a PASSTHROUGH pipe into the call is worse than doing nothing: raw
// getUserMedia audio gets Chromium's echo cancellation, noise suppression and
// gain control, and this path bypasses all three. So "connected" must never
// be enough on its own.
describe('shouldUseDenoisedSource — connected is not enough', () => {
  it('uses the pipe only when denoising is actually confirmed active', () => {
    expect(shouldUseDenoisedSource(status())).toBe(true)
  })

  it('REFUSES a healthy connected pipe that is running in passthrough', () => {
    // Everything reads green except the one field that means anything.
    const s = status({ denoisingActive: false })
    expect(s.connected).toBe(true)
    expect(s.engineRunning).toBe(true)
    expect(shouldUseDenoisedSource(s)).toBe(false)
  })

  it('REFUSES when denoise state is unknown — null is not a maybe', () => {
    // An older engine build, or one that never wrote its status file. An
    // unverifiable claim of denoising must not become a silent downgrade.
    expect(shouldUseDenoisedSource(status({ denoisingActive: null }))).toBe(false)
  })

  it('refuses when not connected or not running, whatever the model says', () => {
    expect(shouldUseDenoisedSource(status({ connected: false }))).toBe(false)
    expect(shouldUseDenoisedSource(status({ engineRunning: false }))).toBe(false)
  })

  it('refuses a null status rather than throwing on first render', () => {
    expect(shouldUseDenoisedSource(null)).toBe(false)
  })
})

describe('tier1UiState — passthrough is a visible error, not a quiet degrade', () => {
  it('reports model-missing rather than pretending to be off or starting', () => {
    // The failure this whole release exists to fix: a feature that reports
    // healthy and does nothing. It must be nameable in the UI.
    expect(tier1UiState(status({ denoisingActive: false }), true)).toBe('model-missing')
  })

  it('reports active only when genuinely denoising', () => {
    expect(tier1UiState(status(), true)).toBe('active')
  })

  it('does not claim active while denoise state is unknown', () => {
    expect(tier1UiState(status({ denoisingActive: null }), true)).toBe('starting')
  })

  it('hides the feature entirely when no engine binary exists', () => {
    expect(tier1UiState(status({ engineAvailable: false }), true)).toBe('unavailable')
  })

  it('is off when available but not switched on', () => {
    expect(tier1UiState(status(), false)).toBe('off')
  })

  it('is starting while the pipe is still coming up', () => {
    expect(tier1UiState(status({ connected: false }), true)).toBe('starting')
  })
})

describe('Tier1Ring — the pipe and the audio graph run on different clocks', () => {
  it('returns exactly what was pushed, in order', () => {
    const r = new Tier1Ring(16)
    r.push(Float32Array.from([0.1, 0.2, 0.3, 0.4]))
    const out = new Float32Array(4)
    r.pull(out)
    expect(Array.from(out).map((v) => +v.toFixed(3))).toEqual([0.1, 0.2, 0.3, 0.4])
  })

  it('pads with silence on underrun and always fills the output', () => {
    // A pull landing between two IPC deliveries. Handing back a short buffer
    // would push the gap onto every caller instead of handling it once.
    const r = new Tier1Ring(16)
    r.push(Float32Array.from([0.5, 0.5]))
    const out = new Float32Array(4).fill(9)
    r.pull(out)
    expect(Array.from(out)).toEqual([0.5, 0.5, 0, 0])
    expect(r.underrunSamples).toBe(2)
  })

  // UNBOUNDED GROWTH WOULD BE A LATENCY BUG, NOT A MEMORY BUG. If the graph
  // consumes slower than the pipe delivers, a growing queue means the user
  // hears themselves further behind with every second, and it never recovers.
  // Dropping the oldest audio bounds latency at the ring size.
  it('drops the OLDEST audio on overflow, keeping latency bounded', () => {
    const r = new Tier1Ring(4)
    r.push(Float32Array.from([1, 2, 3, 4]))
    r.push(Float32Array.from([5, 6]))
    const out = new Float32Array(4)
    r.pull(out)
    // 1 and 2 are gone; the newest audio survives.
    expect(Array.from(out)).toEqual([3, 4, 5, 6])
    expect(r.overflowSamples).toBe(2)
  })

  it('counts overflow rather than swallowing it — a silent drop looks like working', () => {
    const r = new Tier1Ring(4)
    r.push(Float32Array.from([1, 2, 3, 4]))
    expect(r.overflowSamples).toBe(0)
    r.push(Float32Array.from([5]))
    expect(r.overflowSamples).toBe(1)
  })

  it('handles a single frame larger than the entire ring by keeping its TAIL', () => {
    // Keeping the head would play audio we are about to overwrite.
    const r = new Tier1Ring(3)
    r.push(Float32Array.from([1, 2, 3, 4, 5]))
    const out = new Float32Array(3)
    r.pull(out)
    expect(Array.from(out)).toEqual([3, 4, 5])
    expect(r.overflowSamples).toBe(2)
  })

  it('survives sustained wrap-around without drift', () => {
    const r = new Tier1Ring(8)
    const out = new Float32Array(4)
    let next = 0
    for (let round = 0; round < 50; round++) {
      r.push(Float32Array.from([next, next + 1, next + 2, next + 3]))
      r.pull(out)
      expect(Array.from(out)).toEqual([next, next + 1, next + 2, next + 3])
      next += 4
    }
    expect(r.overflowSamples).toBe(0)
    expect(r.underrunSamples).toBe(0)
  })
})
