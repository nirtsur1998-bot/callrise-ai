import { describe, expect, it } from 'vitest'
import {
  PcmAccumulator,
  planDenoisedHalf,
  denoisedTakeUsable,
  MIC_TEST_SECONDS
} from '../mic-test'
import type { Tier1Status } from '@renderer/features/live/audio/tier1-types'

function status(over: Partial<Tier1Status> = {}): Tier1Status {
  return {
    engineAvailable: true,
    engineRunning: false,
    connected: false,
    denoisingActive: null,
    enginePath: 'C:\\x\\kern_bridge.exe',
    ...over
  }
}

describe('PcmAccumulator — a test take keeps its BEGINNING', () => {
  it('accumulates in arrival order and merges contiguously', () => {
    const a = new PcmAccumulator(8)
    a.push(Float32Array.from([1, 2]))
    a.push(Float32Array.from([3, 4, 5]))
    expect(Array.from(a.merged())).toEqual([1, 2, 3, 4, 5])
    expect(a.sampleCount).toBe(5)
  })

  it('drops the NEWEST once full — opposite of the live ring, deliberately', () => {
    // A live stream keeps the freshest audio (latency); a recorded TAKE keeps
    // its start — "the first thing I said is missing" reads as broken, a take
    // that simply ends at the cap reads as complete.
    const a = new PcmAccumulator(4)
    a.push(Float32Array.from([1, 2, 3]))
    a.push(Float32Array.from([4, 5, 6]))
    expect(Array.from(a.merged())).toEqual([1, 2, 3, 4])
    expect(a.droppedSamples).toBe(2)
    a.push(Float32Array.from([7]))
    expect(a.droppedSamples).toBe(3)
    expect(Array.from(a.merged())).toEqual([1, 2, 3, 4])
  })

  it('reports seconds from an explicit rate, never a guessed one', () => {
    const a = new PcmAccumulator(96000)
    a.push(new Float32Array(48000))
    expect(a.seconds(48000)).toBe(1)
    expect(a.seconds(16000)).toBe(3) // same samples, different claim — rate matters (species 22)
  })
})

describe('planDenoisedHalf — never stop an engine the test did not start', () => {
  it('starts (and may later stop) the engine when nothing else is using it', () => {
    expect(planDenoisedHalf(status({ engineRunning: false }), 'Real Mic')).toEqual({
      run: true,
      startEngine: true
    })
  })

  it('captures WITHOUT start/stop rights when the engine is already running', () => {
    // A live call owns it. startEngine:false is also the "may stop it
    // afterwards" bit — stopping here would cut the call's denoiser
    // mid-sentence, the one failure in this feature with real stakes.
    expect(planDenoisedHalf(status({ engineRunning: true }), 'Real Mic')).toEqual({
      run: true,
      startEngine: false
    })
  })

  it('refuses when no engine binary exists', () => {
    expect(planDenoisedHalf(status({ engineAvailable: false }), 'Real Mic')).toEqual({
      run: false,
      reason: 'engine-unavailable'
    })
    expect(planDenoisedHalf(null, 'Real Mic')).toEqual({
      run: false,
      reason: 'engine-unavailable'
    })
  })

  it('refuses an ineligible mic (virtual/excluded → resolved to null) rather than auto-picking', () => {
    expect(planDenoisedHalf(status(), null)).toEqual({ run: false, reason: 'mic-not-eligible' })
  })
})

describe('denoisedTakeUsable — absence of audio is the diagnostic, not a blip', () => {
  it('rejects under half a second of collected audio', () => {
    const a = new PcmAccumulator(48000 * MIC_TEST_SECONDS)
    a.push(new Float32Array(48000 * 0.4))
    expect(denoisedTakeUsable(a, 48000)).toBe(false)
  })

  it('accepts half a second or more', () => {
    const a = new PcmAccumulator(48000 * MIC_TEST_SECONDS)
    a.push(new Float32Array(48000 * 0.5))
    expect(denoisedTakeUsable(a, 48000)).toBe(true)
  })
})
