import { describe, expect, it } from 'vitest'
import { AudioQueue, frameRms, frameSeconds, isSilent, type AudioFrame } from '../queue'
import { HEALTH_TUNING } from '../types'

const RATE = 16000
const CHANNELS = 1
/** 100ms of mono 16-bit PCM. */
const FRAME_BYTES = 0.1 * RATE * 2

function pcm(amplitude: number, byteLength = FRAME_BYTES): ArrayBuffer {
  const buffer = new ArrayBuffer(byteLength)
  const view = new Int16Array(buffer)
  for (let i = 0; i < view.length; i++) view[i] = Math.round(amplitude * 32767)
  return buffer
}

function frame(amplitude: number, atMs = 0): AudioFrame {
  const bytes = pcm(amplitude)
  return { bytes, seconds: frameSeconds(bytes.byteLength, CHANNELS, RATE), rms: frameRms(bytes), atMs }
}

const voiced = (): AudioFrame => frame(0.5)
const silent = (): AudioFrame => frame(0)

describe('frameRms', () => {
  it('is 0 for digital silence and ~1 for full scale', () => {
    expect(frameRms(pcm(0))).toBe(0)
    expect(frameRms(pcm(1))).toBeCloseTo(1, 2)
  })

  it('classifies a very quiet frame as silence', () => {
    expect(isSilent(frameRms(pcm(0.001)))).toBe(true)
    expect(isSilent(frameRms(pcm(0.5)))).toBe(false)
  })

  it('tolerates a frame with an odd byte length', () => {
    expect(() => frameRms(new ArrayBuffer(5))).not.toThrow()
  })

  it('is 0 for an empty frame rather than NaN', () => {
    expect(frameRms(new ArrayBuffer(0))).toBe(0)
  })
})

describe('frameSeconds', () => {
  it('halves when the channel count doubles', () => {
    expect(frameSeconds(FRAME_BYTES, 1, RATE)).toBeCloseTo(0.1)
    expect(frameSeconds(FRAME_BYTES, 2, RATE)).toBeCloseTo(0.05)
  })

  it('returns 0 rather than Infinity for a nonsense layout', () => {
    expect(frameSeconds(FRAME_BYTES, 0, RATE)).toBe(0)
    expect(frameSeconds(FRAME_BYTES, 1, 0)).toBe(0)
  })
})

describe('AudioQueue bound', () => {
  it('is bounded in seconds, not bytes', () => {
    const q = new AudioQueue(1)
    for (let i = 0; i < 30; i++) q.push(voiced())
    expect(q.queuedSeconds).toBeLessThanOrEqual(1 + 1e-9)
  })

  it('drops the OLDEST frame, never the newest', () => {
    const q = new AudioQueue(0.25) // holds 2 frames + change
    const first = voiced()
    q.push(first)
    q.push(voiced())
    q.push(voiced())
    const head = q.peek()
    expect(head).not.toBeNull()
    expect(head?.bytes).not.toBe(first.bytes)
  })

  it('evicts silence before speech', () => {
    const q = new AudioQueue(0.35)
    q.push(silent())
    const keep = voiced()
    q.push(keep)
    q.push(voiced())
    q.push(voiced()) // overflow: the silent frame is the one that goes
    expect(q.peek()?.bytes).toBe(keep.bytes)
  })

  it('reports what a shed actually cost', () => {
    const q = new AudioQueue(0.2)
    q.push(silent())
    q.push(voiced())
    const shed = q.push(voiced())
    expect(shed.droppedSec).toBeCloseTo(0.1)
    expect(shed.silentFrames).toBe(1)
    expect(shed.voicedFrames).toBe(0)
  })

  it('falls back to head-drop once there is no silence left', () => {
    const q = new AudioQueue(0.2)
    q.push(voiced())
    q.push(voiced())
    const shed = q.push(voiced())
    expect(shed.voicedFrames).toBe(1)
    expect(shed.silentFrames).toBe(0)
  })

  it('accumulates total shed seconds across the session', () => {
    const q = new AudioQueue(0.2)
    for (let i = 0; i < 10; i++) q.push(voiced())
    expect(q.shedSeconds).toBeCloseTo(0.8, 5)
  })
})

describe('AudioQueue replay cap', () => {
  // The 90-second bug, in one test: Deepgram's own guidance is to buffer while
  // disconnected. Followed literally with a 30s outage that is a 30s backlog
  // arriving all at once, and ingest is capped at 1.25x realtime.
  it('keeps only a short tail after a long disconnect', () => {
    const q = new AudioQueue(60)
    for (let i = 0; i < 300; i++) q.push(voiced()) // 30s buffered
    expect(q.queuedSeconds).toBeCloseTo(30, 5)

    const shed = q.trimToReplayCap()
    expect(q.queuedSeconds).toBeLessThanOrEqual(HEALTH_TUNING.replayCapSec + 1e-9)
    expect(shed.droppedSec).toBeCloseTo(27, 5)
  })

  it('keeps the NEWEST audio, not the oldest', () => {
    const q = new AudioQueue(60)
    for (let i = 0; i < 100; i++) q.push(voiced())
    const last = voiced()
    q.push(last)
    q.trimToReplayCap(1)
    const remaining: ArrayBuffer[] = []
    for (let f = q.shift(); f; f = q.shift()) remaining.push(f.bytes)
    expect(remaining.at(-1)).toBe(last.bytes)
  })

  it('leaves a short backlog alone', () => {
    const q = new AudioQueue(60)
    for (let i = 0; i < 10; i++) q.push(voiced()) // 1s — under the cap
    const shed = q.trimToReplayCap()
    expect(shed.droppedSec).toBe(0)
    expect(q.queuedSeconds).toBeCloseTo(1, 5)
  })

  // transcription.ts's reconnect handler anchors connectionOpenedAtMs on
  // exactly this value (`s.queue.peek()?.atMs ?? at`, the fix for the
  // cross-talk-window-misdating bug) — distinct from the seconds/byte
  // accounting the tests above already cover, and previously asserted
  // nowhere. voiced()/silent() default every frame to atMs=0, so this test
  // gives frames real, increasing timestamps instead.
  it("after trimming, peek()'s atMs is the oldest SURVIVING frame's real capture time", () => {
    const q = new AudioQueue(60)
    const FRAME_MS = 100 // matches the 100ms frame() helper's own duration
    const FRAME_COUNT = 300 // 30s buffered
    for (let i = 0; i < FRAME_COUNT; i++) q.push(frame(0.5, i * FRAME_MS))
    const newestAtMs = (FRAME_COUNT - 1) * FRAME_MS

    q.trimToReplayCap() // keeps HEALTH_TUNING.replayCapSec (3s) of the newest

    const oldestSurviving = q.peek()
    expect(oldestSurviving).not.toBeNull()
    // Whatever survived must be within the replay cap of the newest pushed
    // frame — not some arbitrary earlier frame the eviction skipped past.
    expect(oldestSurviving?.atMs).toBeGreaterThan(newestAtMs - HEALTH_TUNING.replayCapSec * 1000)
    expect(oldestSurviving?.atMs).toBeLessThanOrEqual(newestAtMs)
  })

  it('peek() is null on an empty queue — the `?? at` fallback path connect() relies on', () => {
    const q = new AudioQueue(60)
    q.push(frame(0.5, 1000))
    q.shift()
    expect(q.peek()).toBeNull()
  })
})

describe('AudioQueue.clear', () => {
  it('reports the full cost of discarding a sleep backlog', () => {
    const q = new AudioQueue(10_000)
    for (let i = 0; i < 12_000; i++) q.push(voiced()) // 20 minutes
    expect(q.queuedSeconds).toBeCloseTo(1200, 3)
    const shed = q.clear()
    expect(shed.droppedSec).toBeCloseTo(1200, 3)
    expect(q.queuedSeconds).toBe(0)
    expect(q.length).toBe(0)
  })
})
