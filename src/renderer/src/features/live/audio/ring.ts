// Lock-free SPSC ring buffer over a SharedArrayBuffer (§1.4).
//
// The problem it solves: today the worklet posts each PCM chunk to the
// renderer's MAIN thread, which forwards it over IPC. That makes transcription
// latency a function of UI responsiveness — a 5-second render storm queues five
// seconds of audio behind it, which then floods Deepgram at a 1.25x ingest cap
// and takes twenty seconds to clear. The audio thread is real-time; the main
// thread is not; and nothing should couple them.
//
// With a ring, the worklet writes into shared memory and never waits for
// anyone. A worker drains it on its own thread. The main thread can stall for
// as long as it likes and the audio still leaves the machine on time.
//
// SINGLE producer, SINGLE consumer — that constraint is what makes it safe
// without locks, and it holds here by construction: one worklet writes, one
// worker reads.
//
// The two indices are monotonically increasing frame counters, not wrapped
// pointers. That is deliberate. Wrapped pointers make "empty" and "full"
// indistinguishable without a spare slot or a flag, and the classic bug is a
// full ring that reads as empty and silently discards everything. Monotonic
// counters make the distinction arithmetic: available = write − read, always.

/** Control-block slots, in Int32 units. */
const WRITE_INDEX = 0
const READ_INDEX = 1
const OVERRUN_FRAMES = 2
const CONTROL_INTS = 4 // padded to keep the data aligned and leave room

/**
 * The wire contract, sent to the audio worklet.
 *
 * The worklet is loaded as a standalone asset (`?url`), so it cannot import
 * this module — it has to be told the layout. Passing it rather than letting
 * the worklet hard-code the same numbers keeps one source of truth; the
 * worklet's copy of the *write algorithm* is cross-checked against `RingWriter`
 * in pcm-processor.test.ts, which drives the real worklet class into a real
 * ring and reads it back.
 */
export const RING_CONTROL = {
  writeIndex: WRITE_INDEX,
  readIndex: READ_INDEX,
  overrunFrames: OVERRUN_FRAMES,
  controlInts: CONTROL_INTS
} as const

export interface RingLayout {
  /** Sample-frames the ring can hold. */
  capacityFrames: number
  channels: number
}

/** Bytes needed for a ring of this shape. */
export function ringByteLength({ capacityFrames, channels }: RingLayout): number {
  return CONTROL_INTS * 4 + capacityFrames * channels * 2
}

/** Frames that hold `seconds` of audio at this rate, rounded up. */
export function framesForSeconds(seconds: number, sampleRate: number): number {
  return Math.max(1, Math.ceil(seconds * sampleRate))
}

function views(
  buffer: SharedArrayBuffer | ArrayBuffer,
  layout: RingLayout
): { control: Int32Array; data: Int16Array } {
  return {
    control: new Int32Array(buffer, 0, CONTROL_INTS),
    data: new Int16Array(buffer, CONTROL_INTS * 4, layout.capacityFrames * layout.channels)
  }
}

/**
 * The producer side. Lives on the audio thread, so everything here is
 * allocation-free and never blocks: a real-time callback that waits is a
 * real-time callback that has already failed.
 */
export class RingWriter {
  private readonly control: Int32Array
  private readonly data: Int16Array
  private readonly capacityFrames: number
  private readonly channels: number

  constructor(buffer: SharedArrayBuffer | ArrayBuffer, layout: RingLayout) {
    const v = views(buffer, layout)
    this.control = v.control
    this.data = v.data
    this.capacityFrames = layout.capacityFrames
    this.channels = layout.channels
  }

  /**
   * Write one frame (one sample per channel).
   *
   * Never fails and never blocks. If the consumer has fallen far enough behind
   * that the ring is full, the OLDEST audio is overwritten — the same
   * drop-from-the-head rule the send queue uses, and for the same reason:
   * dropping the newest keeps you permanently behind, transcribing stale audio
   * forever, while dropping the oldest costs the words already missed and puts
   * you back at the live edge.
   */
  writeFrame(samples: ArrayLike<number>): void {
    const write = Atomics.load(this.control, WRITE_INDEX)
    const offset = (write % this.capacityFrames) * this.channels
    for (let ch = 0; ch < this.channels; ch++) {
      this.data[offset + ch] = samples[ch] ?? 0
    }
    Atomics.store(this.control, WRITE_INDEX, write + 1)

    // The producer never moves the read index — that belongs to the consumer,
    // and touching it here is the race this design exists to avoid. Instead it
    // records that an overrun happened; the consumer notices it is more than a
    // ring behind and skips forward on its own.
    const read = Atomics.load(this.control, READ_INDEX)
    if (write + 1 - read > this.capacityFrames) {
      Atomics.add(this.control, OVERRUN_FRAMES, 1)
    }
  }

  /** Frames written since the ring was created. */
  get written(): number {
    return Atomics.load(this.control, WRITE_INDEX)
  }
}

export interface ReadResult {
  /** Interleaved samples, `frames * channels` long. Empty when nothing waited. */
  samples: Int16Array
  frames: number
  /** Frames lost to overrun before this read — audio that never left the ring. */
  dropped: number
}

/** The consumer side. Lives on a worker; the main thread is never involved. */
export class RingReader {
  private readonly control: Int32Array
  private readonly data: Int16Array
  private readonly capacityFrames: number
  private readonly channels: number

  constructor(buffer: SharedArrayBuffer | ArrayBuffer, layout: RingLayout) {
    const v = views(buffer, layout)
    this.control = v.control
    this.data = v.data
    this.capacityFrames = layout.capacityFrames
    this.channels = layout.channels
  }

  /** Frames waiting to be read, capped at what the ring can actually hold. */
  available(): number {
    const write = Atomics.load(this.control, WRITE_INDEX)
    const read = Atomics.load(this.control, READ_INDEX)
    return Math.min(write - read, this.capacityFrames)
  }

  /**
   * Read up to `maxFrames`.
   *
   * If the writer lapped us, the read index is skipped forward to the oldest
   * frame that still exists rather than reading whatever happens to be sitting
   * in those slots — which would be a mixture of two different moments in the
   * call, spliced mid-word.
   */
  read(maxFrames: number): ReadResult {
    const write = Atomics.load(this.control, WRITE_INDEX)
    let read = Atomics.load(this.control, READ_INDEX)

    let dropped = 0
    const behind = write - read
    if (behind > this.capacityFrames) {
      dropped = behind - this.capacityFrames
      read = write - this.capacityFrames
    }

    const frames = Math.min(maxFrames, write - read)
    if (frames <= 0) {
      if (dropped > 0) Atomics.store(this.control, READ_INDEX, read)
      return { samples: new Int16Array(0), frames: 0, dropped }
    }

    const out = new Int16Array(frames * this.channels)
    for (let f = 0; f < frames; f++) {
      const src = ((read + f) % this.capacityFrames) * this.channels
      const dst = f * this.channels
      for (let ch = 0; ch < this.channels; ch++) out[dst + ch] = this.data[src + ch]
    }
    Atomics.store(this.control, READ_INDEX, read + frames)
    return { samples: out, frames, dropped }
  }

  /** Total frames lost to overrun this session. */
  get overrunFrames(): number {
    return Atomics.load(this.control, OVERRUN_FRAMES)
  }
}

/**
 * Whether this renderer can actually use a SharedArrayBuffer.
 *
 * Chromium gates SAB behind cross-origin isolation, and Electron only relaxes
 * that when told to. Checked rather than assumed, because the cost of assuming
 * wrong is a renderer that throws on startup and an app that will not open —
 * a failure this project has already shipped once, from a native addon
 * required unconditionally at boot.
 */
export function sharedMemoryAvailable(): boolean {
  try {
    if (typeof SharedArrayBuffer === 'undefined') return false
    // Constructing one is the only honest test; the constructor exists in some
    // configurations where allocation still throws.
    new SharedArrayBuffer(8)
    return true
  } catch {
    return false
  }
}
