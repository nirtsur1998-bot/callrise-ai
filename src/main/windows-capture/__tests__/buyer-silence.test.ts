import { describe, expect, it } from 'vitest'
import { BUYER_SILENCE_TUNING, BuyerSilenceWatcher, type SilenceVerdict } from '../buyer-silence'

/** Interleaved [mic, buyer] PCM, one frame. */
function frame(micRms: number, buyerRms: number): ArrayBufferLike {
  const samples = 100
  const out = new Int16Array(samples * 2)
  const micAmp = Math.round(micRms * 32767)
  const buyerAmp = Math.round(buyerRms * 32767)
  for (let i = 0; i < samples; i++) {
    // Alternate sign so the RMS is genuinely non-zero rather than a DC offset.
    out[i * 2] = i % 2 === 0 ? micAmp : -micAmp
    out[i * 2 + 1] = i % 2 === 0 ? buyerAmp : -buyerAmp
  }
  return out.buffer
}

const SILENT = 0
const SPEECH = 0.3 // comfortably above the silence floor

describe('BuyerSilenceWatcher', () => {
  it('does not warn while the buyer channel has any audio', () => {
    const w = new BuyerSilenceWatcher()
    let atMs = 0
    for (let i = 0; i < 200; i++) {
      atMs += 1000
      const v = w.observe({ atMs, bytes: frame(SPEECH, SPEECH) })
      expect(v.shouldWarn).toBe(false)
    }
  })

  it('does not warn on ordinary dead air (both sides silent)', () => {
    const w = new BuyerSilenceWatcher()
    let atMs = 0
    for (let i = 0; i < 200; i++) {
      atMs += 1000
      const v = w.observe({ atMs, bytes: frame(SILENT, SILENT) })
      expect(v.shouldWarn).toBe(false)
    }
  })

  it('warns once the mic is live, the buyer is silent, and it has held long enough', () => {
    const w = new BuyerSilenceWatcher()
    let atMs = 0
    let warned = false
    // Alternate mic speech/silence like a real call, buyer always silent.
    for (let i = 0; i < 200; i++) {
      atMs += 1000
      const micLevel = i % 3 === 0 ? SPEECH : SILENT
      const v = w.observe({ atMs, bytes: frame(micLevel, SILENT) })
      if (v.shouldWarn) {
        warned = true
        break
      }
    }
    expect(warned).toBe(true)
  })

  it('does not warn before the sustained window has elapsed', () => {
    const w = new BuyerSilenceWatcher()
    const results: SilenceVerdict[] = []
    let atMs = 0
    const steps = Math.floor(BUYER_SILENCE_TUNING.sustainedMs / 1000) - 2
    for (let i = 0; i < steps; i++) {
      atMs += 1000
      results.push(w.observe({ atMs, bytes: frame(SPEECH, SILENT) }))
    }
    expect(results.every((r) => !r.shouldWarn)).toBe(true)
  })

  it('resets the window the instant real buyer audio appears', () => {
    const w = new BuyerSilenceWatcher()
    let atMs = 0
    // Almost to the threshold...
    const almost = Math.floor(BUYER_SILENCE_TUNING.sustainedMs / 1000) - 1
    for (let i = 0; i < almost; i++) {
      atMs += 1000
      w.observe({ atMs, bytes: frame(SPEECH, SILENT) })
    }
    // ...then the buyer actually says something.
    atMs += 1000
    expect(w.observe({ atMs, bytes: frame(SPEECH, SPEECH) }).shouldWarn).toBe(false)
    // Silence resumes — the clock must have restarted, not continued.
    for (let i = 0; i < almost; i++) {
      atMs += 1000
      expect(w.observe({ atMs, bytes: frame(SPEECH, SILENT) }).shouldWarn).toBe(false)
    }
  })

  it('fires only once per call even if the condition persists', () => {
    const w = new BuyerSilenceWatcher()
    let atMs = 0
    let warnings = 0
    for (let i = 0; i < 400; i++) {
      atMs += 1000
      const micLevel = i % 2 === 0 ? SPEECH : SILENT
      if (w.observe({ atMs, bytes: frame(micLevel, SILENT) }).shouldWarn) warnings++
    }
    expect(warnings).toBe(1)
  })

  it('fires again after reset() for the next call', () => {
    const w = new BuyerSilenceWatcher()
    let atMs = 0
    const fireOnce = (): boolean => {
      let fired = false
      for (let i = 0; i < 200; i++) {
        atMs += 1000
        const micLevel = i % 2 === 0 ? SPEECH : SILENT
        if (w.observe({ atMs, bytes: frame(micLevel, SILENT) }).shouldWarn) fired = true
      }
      return fired
    }
    expect(fireOnce()).toBe(true)
    w.reset()
    expect(fireOnce()).toBe(true)
  })

  it('does not treat a quiet prospect as the bug when the mic barely speaks', () => {
    // Ratio guard: only ~1 in 20 frames of mic speech, well under the floor.
    const w = new BuyerSilenceWatcher()
    let atMs = 0
    let warned = false
    for (let i = 0; i < 300; i++) {
      atMs += 1000
      const micLevel = i % 20 === 0 ? SPEECH : SILENT
      if (w.observe({ atMs, bytes: frame(micLevel, SILENT) }).shouldWarn) warned = true
    }
    expect(warned).toBe(false)
  })
})
