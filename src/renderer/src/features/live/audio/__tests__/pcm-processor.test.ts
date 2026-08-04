// Cross-checks the audio worklet against RingWriter/RingReader.
//
// The worklet is loaded as a standalone asset (`?url`), so it cannot import
// ring.ts — it carries its own copy of the ~10-line write algorithm. A second
// copy of anything is a place for the two to drift apart, and drift here is
// invisible: the audio does not error, it just comes out interleaved wrong, or
// one frame off, or with the buyer's words attributed to the rep.
//
// So the real worklet class is driven here, into a real ring, and read back
// with the real reader. If the two implementations ever disagree, this fails.

import { beforeAll, describe, expect, it } from 'vitest'
import { RING_CONTROL, RingReader, ringByteLength, type RingLayout } from '../ring'

interface WorkletPort {
  onmessage: ((event: { data: unknown }) => void) | null
  postMessage: (data: unknown) => void
}

interface ProcessorLike {
  port: WorkletPort
  process: (inputs: Float32Array[][]) => boolean
}

let PCMProcessor: new () => ProcessorLike
const posted: unknown[] = []

beforeAll(async () => {
  const registered: Record<string, new () => ProcessorLike> = {}
  const g = globalThis as Record<string, unknown>
  g.AudioWorkletProcessor = class {
    port: WorkletPort = {
      onmessage: null,
      postMessage: (data: unknown) => posted.push(data)
    }
  }
  g.registerProcessor = (name: string, ctor: new () => ProcessorLike): void => {
    registered[name] = ctor
  }
  // Built at runtime so TypeScript does not try to resolve the plain-JS
  // worklet through the renderer's module graph.
  const href = new URL('../pcm-processor.js', import.meta.url).href
  await import(/* @vite-ignore */ href)
  PCMProcessor = registered['pcm-processor']
})

const LAYOUT: RingLayout = { capacityFrames: 1024, channels: 2 }

function attachRing(p: ProcessorLike): RingReader {
  const buffer = new ArrayBuffer(ringByteLength(LAYOUT))
  p.port.onmessage?.({
    data: {
      type: 'ring',
      buffer,
      capacityFrames: LAYOUT.capacityFrames,
      channels: LAYOUT.channels,
      control: RING_CONTROL
    }
  })
  return new RingReader(buffer, LAYOUT)
}

/** A render quantum whose samples are recognisable after PCM conversion. */
function quantum(values: number[]): Float32Array {
  return Float32Array.from(values)
}

/** The worklet's conversion, including the truncation an Int16Array store
 *  performs — rounding here instead would make this test disagree with the
 *  code by one LSB and prove nothing. */
const toPcm = (v: number): number => Math.trunc(v < 0 ? v * 0x8000 : v * 0x7fff)

describe('pcm-processor', () => {
  it('registers itself under the name the recorder asks for', () => {
    expect(PCMProcessor).toBeTypeOf('function')
  })

  it('writes mic samples the RingReader can read back', () => {
    const p = new PCMProcessor()
    const reader = attachRing(p)
    const mic = quantum([0.5, -0.5, 0.25])
    p.process([[mic]])

    const out = reader.read(10)
    expect(out.frames).toBe(3)
    // Channel 0 is the mic; channel 1 is silence until stereo is switched on.
    expect(Array.from(out.samples)).toEqual([toPcm(0.5), 0, toPcm(-0.5), 0, toPcm(0.25), 0])
  })

  it('interleaves [you, buyer] once stereo is on', () => {
    const p = new PCMProcessor()
    const reader = attachRing(p)
    p.port.onmessage?.({ data: { type: 'mode', stereo: true } })
    p.process([[quantum([0.5, 0.25]), quantum([-0.5, -0.25])]])

    const out = reader.read(10)
    expect(Array.from(out.samples)).toEqual([toPcm(0.5), toPcm(-0.5), toPcm(0.25), toPcm(-0.25)])
  })

  it('treats a missing buyer channel as silence rather than reading garbage', () => {
    const p = new PCMProcessor()
    const reader = attachRing(p)
    p.port.onmessage?.({ data: { type: 'mode', stereo: true } })
    p.process([[quantum([0.5])]]) // loopback attached in the graph but not yet producing
    expect(Array.from(reader.read(10).samples)).toEqual([toPcm(0.5), 0])
  })

  it('clamps out-of-range samples instead of wrapping them', () => {
    // A float above 1.0 that wrapped would turn a loud moment into a loud
    // moment of the OPPOSITE sign — an audible click Deepgram hears as noise.
    const p = new PCMProcessor()
    const reader = attachRing(p)
    p.process([[quantum([2, -2])]])
    const out = reader.read(10)
    expect(out.samples[0]).toBe(0x7fff)
    expect(out.samples[2]).toBe(-0x8000)
  })

  it('wraps around the ring in step with the reader', () => {
    // The worklet's copy of the modulo indexing has to agree with the reader's
    // across the wrap point, which is exactly where an off-by-one hides.
    const p = new PCMProcessor()
    const reader = attachRing(p)
    const total = LAYOUT.capacityFrames + 200
    // Float32 first, so the expectation is built from the same values the
    // worklet actually sees rather than their float64 originals.
    const source = Float32Array.from({ length: total }, (_, i) => ((i % 1000) / 1000) * 0.9)
    const got: number[] = []
    for (let i = 0; i < total; i += 128) {
      p.process([[source.subarray(i, Math.min(i + 128, total))]])
      const out = reader.read(1024)
      for (let f = 0; f < out.frames; f++) got.push(out.samples[f * 2])
    }
    expect(got.length).toBe(total)
    expect(got).toEqual(Array.from(source, (v) => toPcm(v)))
  })

  it('falls back to postMessage when no ring is attached', () => {
    // The path that carries every machine without shared memory. It must stay
    // byte-for-byte the original behaviour: 2048 mono samples per message.
    const p = new PCMProcessor()
    posted.length = 0
    for (let i = 0; i < 2048; i += 128) p.process([[quantum(new Array(128).fill(0.5))]])
    expect(posted.length).toBe(1)
    expect((posted[0] as ArrayBuffer).byteLength).toBe(4096)
  })

  it('stops using the ring when detached', () => {
    const p = new PCMProcessor()
    const reader = attachRing(p)
    p.process([[quantum([0.5])]])
    expect(reader.read(10).frames).toBe(1)
    p.port.onmessage?.({ data: { type: 'ring-detach' } })
    p.process([[quantum([0.5])]])
    expect(reader.read(10).frames).toBe(0)
  })
})
