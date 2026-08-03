import { describe, expect, it } from 'vitest'
import { channelRms, interleave, runChannelSelfTest, tone } from '../channel-test'

const RATE = 16000

describe('tone', () => {
  it('produces the requested duration of audio', () => {
    expect(tone(440, 500, RATE).length).toBe(8000)
  })

  it('carries real energy', () => {
    const rms = channelRms(tone(440, 100, RATE).buffer, 1)[0]
    expect(rms).toBeGreaterThan(0.2)
  })

  it('handles a zero-length request without throwing', () => {
    expect(tone(440, 0, RATE).length).toBe(0)
  })
})

describe('channelRms', () => {
  it('reads a mono buffer as one channel', () => {
    expect(channelRms(tone(440, 100, RATE).buffer, 1)).toHaveLength(1)
  })

  it('separates the two channels of an interleaved buffer', () => {
    const loud = tone(440, 100, RATE)
    const silent = new Int16Array(loud.length)
    const rms = channelRms(interleave([loud, silent]), 2)
    expect(rms[0]).toBeGreaterThan(0.2)
    expect(rms[1]).toBe(0)
  })

  it('is zero for digital silence', () => {
    expect(channelRms(new Int16Array(1000).buffer, 2)).toEqual([0, 0])
  })

  it('returns nothing for a nonsense channel count', () => {
    expect(channelRms(new ArrayBuffer(100), 0)).toEqual([])
  })

  it('survives an empty buffer', () => {
    expect(channelRms(new ArrayBuffer(0), 2)).toEqual([0, 0])
  })
})

describe('interleave', () => {
  it('lays out frames as [ch0, ch1, ch0, ch1, …]', () => {
    const a = Int16Array.from([1, 3, 5])
    const b = Int16Array.from([2, 4, 6])
    expect(Array.from(new Int16Array(interleave([a, b])))).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('truncates to the shorter channel rather than reading past it', () => {
    const a = Int16Array.from([1, 2, 3])
    const b = Int16Array.from([9])
    expect(Array.from(new Int16Array(interleave([a, b])))).toEqual([1, 9])
  })

  it('handles no channels', () => {
    expect(interleave([]).byteLength).toBe(0)
  })
})

describe('runChannelSelfTest — acceptance criterion 6', () => {
  it('passes when each channel carries its own tone', () => {
    const result = runChannelSelfTest(RATE, 2)
    expect(result.pass).toBe(true)
    expect(result.rms[0]).toBeGreaterThan(0.2)
    expect(result.rms[1]).toBeGreaterThan(0.2)
  })

  it('passes for mono too', () => {
    expect(runChannelSelfTest(RATE, 1).pass).toBe(true)
  })

  // The bug this exists for: swap the two sources and nothing errors — the
  // transcript just attributes every one of the rep's words to the prospect.
  it('FAILS when the interleaver swaps the channels', () => {
    const swapped = runChannelSelfTest(RATE, 2, ([ch0, ch1]) => interleave([ch1, ch0]))
    expect(swapped.pass).toBe(false)
    expect(swapped.detail).toContain('leaked into')
  })

  it('FAILS when a channel is dropped entirely', () => {
    const dropped = runChannelSelfTest(RATE, 2, ([ch0]) =>
      interleave([ch0, new Int16Array(ch0.length)])
    )
    expect(dropped.pass).toBe(false)
    expect(dropped.detail).toContain('no signal')
  })

  // Mixing both sources into both channels is the mono-downmix bug: it sounds
  // fine and destroys attribution completely.
  it('FAILS when both sources are mixed into both channels', () => {
    const mixed = runChannelSelfTest(RATE, 2, ([ch0, ch1]) => {
      const sum = Int16Array.from(ch0, (v, i) => Math.round((v + ch1[i]) / 2))
      return interleave([sum, sum])
    })
    expect(mixed.pass).toBe(false)
  })

  it('reports nothing to test rather than passing vacuously', () => {
    const none = runChannelSelfTest(RATE, 0)
    expect(none.pass).toBe(false)
    expect(none.detail).toContain('no channels')
  })

  it('always explains itself', () => {
    expect(runChannelSelfTest(RATE, 2).detail.length).toBeGreaterThan(10)
  })
})
