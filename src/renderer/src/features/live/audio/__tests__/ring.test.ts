import { describe, expect, it } from 'vitest'
import {
  RingReader,
  RingWriter,
  framesForSeconds,
  ringByteLength,
  sharedMemoryAvailable,
  type RingLayout
} from '../ring'

function makeRing(layout: RingLayout): { writer: RingWriter; reader: RingReader } {
  const buffer = new ArrayBuffer(ringByteLength(layout))
  return { writer: new RingWriter(buffer, layout), reader: new RingReader(buffer, layout) }
}

/** Frame `n` as a distinguishable stereo pair, so order is checkable. */
const frame = (n: number): number[] => [n, -n]

describe('ring layout', () => {
  it('sizes the buffer for control block + interleaved samples', () => {
    // 4 control ints + 100 frames x 2 channels x 2 bytes.
    expect(ringByteLength({ capacityFrames: 100, channels: 2 })).toBe(16 + 400)
  })

  it('rounds seconds up to whole frames', () => {
    expect(framesForSeconds(1, 48000)).toBe(48000)
    expect(framesForSeconds(0.5, 48000)).toBe(24000)
    // Never zero — a zero-capacity ring divides by zero on every write.
    expect(framesForSeconds(0, 48000)).toBe(1)
  })
})

describe('RingWriter / RingReader', () => {
  it('round-trips frames in order', () => {
    const layout = { capacityFrames: 8, channels: 2 }
    const { writer, reader } = makeRing(layout)
    for (let i = 1; i <= 4; i++) writer.writeFrame(frame(i))

    const out = reader.read(10)
    expect(out.frames).toBe(4)
    expect(out.dropped).toBe(0)
    expect(Array.from(out.samples)).toEqual([1, -1, 2, -2, 3, -3, 4, -4])
  })

  it('reads nothing from an empty ring', () => {
    const { reader } = makeRing({ capacityFrames: 8, channels: 2 })
    const out = reader.read(10)
    expect(out).toEqual({ samples: new Int16Array(0), frames: 0, dropped: 0 })
  })

  it('distinguishes full from empty', () => {
    // The classic wrapped-pointer bug: a full ring reads as empty and the whole
    // call is silently discarded. Monotonic counters make this arithmetic.
    const layout = { capacityFrames: 4, channels: 1 }
    const { writer, reader } = makeRing(layout)
    expect(reader.available()).toBe(0)
    for (let i = 1; i <= 4; i++) writer.writeFrame([i])
    expect(reader.available()).toBe(4)
    expect(reader.read(4).frames).toBe(4)
    expect(reader.available()).toBe(0)
  })

  it('wraps around the end of the buffer without corrupting frames', () => {
    const layout = { capacityFrames: 4, channels: 2 }
    const { writer, reader } = makeRing(layout)
    // Fill, drain, then write across the wrap point.
    for (let i = 1; i <= 3; i++) writer.writeFrame(frame(i))
    expect(reader.read(3).frames).toBe(3)
    for (let i = 4; i <= 7; i++) writer.writeFrame(frame(i))

    const out = reader.read(10)
    expect(out.frames).toBe(4)
    expect(out.dropped).toBe(0)
    expect(Array.from(out.samples)).toEqual([4, -4, 5, -5, 6, -6, 7, -7])
  })

  it('drops the OLDEST frames on overrun and reports how many', () => {
    // Drop-from-the-head, same rule as the send queue: dropping the newest
    // leaves you permanently behind, transcribing stale audio forever.
    const layout = { capacityFrames: 4, channels: 1 }
    const { writer, reader } = makeRing(layout)
    for (let i = 1; i <= 6; i++) writer.writeFrame([i])

    const out = reader.read(10)
    expect(out.dropped).toBe(2)
    expect(out.frames).toBe(4)
    expect(Array.from(out.samples)).toEqual([3, 4, 5, 6])
  })

  it('never returns a frame spliced from two different moments', () => {
    // Reading slots the writer has already lapped would hand back the tail of
    // one moment glued to the head of another — mid-word, undetectably.
    const layout = { capacityFrames: 4, channels: 2 }
    const { writer, reader } = makeRing(layout)
    for (let i = 1; i <= 10; i++) writer.writeFrame(frame(i))

    const out = reader.read(10)
    expect(out.frames).toBe(4)
    const seen = Array.from(out.samples)
    // Every pair must be a genuine (n, -n), and strictly consecutive.
    for (let f = 0; f < out.frames; f++) {
      expect(seen[f * 2 + 1]).toBe(-seen[f * 2])
      if (f > 0) expect(seen[f * 2]).toBe(seen[(f - 1) * 2] + 1)
    }
  })

  it('caps available() at what the ring can actually hold', () => {
    const layout = { capacityFrames: 4, channels: 1 }
    const { writer, reader } = makeRing(layout)
    for (let i = 0; i < 100; i++) writer.writeFrame([i])
    expect(writer.written).toBe(100)
    expect(reader.available()).toBe(4)
  })

  it('counts overrun frames for the health report', () => {
    const layout = { capacityFrames: 4, channels: 1 }
    const { writer, reader } = makeRing(layout)
    for (let i = 0; i < 4; i++) writer.writeFrame([i])
    expect(reader.overrunFrames).toBe(0)
    for (let i = 0; i < 3; i++) writer.writeFrame([i])
    expect(reader.overrunFrames).toBe(3)
  })

  it('reports drops even when the read itself returns nothing', () => {
    // read(0) still has to surface the loss; a silent zero-frame read would
    // hide a gap that really happened.
    const layout = { capacityFrames: 4, channels: 1 }
    const { writer, reader } = makeRing(layout)
    for (let i = 0; i < 6; i++) writer.writeFrame([i])
    const out = reader.read(0)
    expect(out.frames).toBe(0)
    expect(out.dropped).toBe(2)
    // And the skip is committed, so the next read starts at the live edge.
    expect(reader.read(10).frames).toBe(4)
    expect(reader.read(10).dropped).toBe(0)
  })

  it('honours maxFrames so a drain can bound its own work', () => {
    const layout = { capacityFrames: 16, channels: 1 }
    const { writer, reader } = makeRing(layout)
    for (let i = 1; i <= 10; i++) writer.writeFrame([i])
    expect(Array.from(reader.read(3).samples)).toEqual([1, 2, 3])
    expect(Array.from(reader.read(3).samples)).toEqual([4, 5, 6])
    expect(reader.available()).toBe(4)
  })

  it('pads a short frame rather than reading past it', () => {
    // The worklet writes whatever the graph gave it; a mono buffer arriving on
    // a stereo ring must become silence on the missing channel, not garbage.
    const layout = { capacityFrames: 4, channels: 2 }
    const { writer, reader } = makeRing(layout)
    writer.writeFrame([7])
    expect(Array.from(reader.read(1).samples)).toEqual([7, 0])
  })

  it('survives interleaved write/read at the wrap boundary', () => {
    // Producer and consumer stepping over each other one frame at a time is
    // where an off-by-one in the modulo shows up.
    const layout = { capacityFrames: 5, channels: 1 }
    const { writer, reader } = makeRing(layout)
    const got: number[] = []
    for (let i = 1; i <= 50; i++) {
      writer.writeFrame([i])
      const out = reader.read(1)
      if (out.frames > 0) got.push(out.samples[0])
    }
    expect(got).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
  })
})

describe('sharedMemoryAvailable', () => {
  it('answers without throwing, whatever the environment allows', () => {
    // The value differs between Node, a cross-origin-isolated renderer, and a
    // plain one. What must hold everywhere is that asking is safe — the whole
    // point is to avoid the boot-time throw that has already shipped once.
    expect(() => sharedMemoryAvailable()).not.toThrow()
    expect(typeof sharedMemoryAvailable()).toBe('boolean')
  })
})
