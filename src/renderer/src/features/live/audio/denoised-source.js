/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain-JS audio worklet; TS return types don't apply */
// M27 Tier 1 — AudioWorklet SOURCE node carrying denoised microphone audio.
//
// STAGED AHEAD OF THE recorder.ts WIRING AND NOT YET IMPORTED BY ANYTHING.
// Adding this file cannot affect the live-call path: an AudioWorklet module
// only exists once `audioWorklet.addModule()` loads it, and nothing calls that
// for this URL yet. See docs/M27-tier1-recorder-handoff.md.
//
// WHAT IT IS. Every other worklet in this app is a SINK — audio flows in from
// the graph and out to the main thread. This one is the opposite: audio
// arrives from OUTSIDE the graph (the main process, over a named pipe, via
// postMessage) and this node injects it INTO the graph as if it were a device.
// `process()` therefore ignores `inputs` entirely and only writes `outputs`.
//
// WHY THE RING LIVES HERE AND ALSO IN tier1-source.ts. The logic is duplicated
// on purpose, and the duplication is small and deliberate: an AudioWorklet
// runs in a separate global scope that cannot `import` from the app bundle, so
// this file must be self-contained. Tier1Ring in tier1-source.ts is the
// TESTED copy — it carries the same drop-oldest and counter semantics and is
// exercised directly by unit tests. If you change the behaviour of one, change
// both. (The alternative — no ring here, buffering on the main thread — was
// rejected: it would put a message hop between the buffer and the audio clock,
// which is the exact jitter the buffer exists to absorb.)
//
// FAILS TO SILENCE, NEVER TO NOISE. If nothing has been pushed, this emits
// zeros. It must never emit stale audio: repeating the last frame to cover an
// underrun produces a buzzing artifact that sounds like a broken microphone,
// and on a sales call that is worse than a brief gap.

const RING_CAPACITY = 48000 // 1s at 48kHz — bounds worst-case added latency

// The rate kern_bridge ALWAYS sends at (CANONICAL_RATE in kern_bridge.cpp).
// `sampleRate` is an AudioWorkletGlobalScope global holding the rate THIS
// graph runs at — recorder.ts sets it to 16000 for transcription.
//
// THE MISMATCH BETWEEN THESE TWO SHIPPED BROKEN, TWICE. Without conversion
// the ring filled 3x faster than it drained: two thirds of every second was
// discarded as overflow and the remainder played at a third speed, so
// Deepgram received unintelligible audio and the rep's own side of the call
// never transcribed at all. Mirrors Tier1Resampler in tier1-source.ts, which
// is the TESTED copy (a worklet cannot import from the app bundle) — change
// the behaviour of one and you must change both.
const SOURCE_RATE = 48000

class DenoisedSourceProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(RING_CAPACITY)
    this.readPos = 0
    this.writePos = 0
    this.filled = 0
    // Resampler state. phase starts at 1, not 0: the virtual buffer is
    // [last, ...input], so input[j] sits at virtual index j+1 and starting
    // at 0 would open the stream on a value never present in the signal and
    // leave every later read off by one input sample.
    this.phase = 1
    this.last = 0
    // Counted, not swallowed: a silent drop is indistinguishable from working.
    this.overflowSamples = 0
    this.underrunSamples = 0
    // Set false by a {type:'stop'} message so a node left in the graph during
    // teardown emits silence rather than draining whatever it still holds.
    this.active = true

    this.port.onmessage = (event) => {
      const msg = event.data
      if (!msg) return
      if (msg.type === 'stop') {
        this.active = false
        this.readPos = 0
        this.writePos = 0
        this.filled = 0
        // Resampler state too — a restarted stream inheriting a stale phase
        // and last-sample would open on a discontinuity from the old call.
        this.phase = 1
        this.last = 0
        return
      }
      if (msg.type === 'stats') {
        this.port.postMessage({
          type: 'stats',
          overflowSamples: this.overflowSamples,
          underrunSamples: this.underrunSamples,
          filled: this.filled
        })
        return
      }
      // Otherwise: a frame. Accepts a Float32Array or a transferred
      // ArrayBuffer (what the main process sends) without copying twice.
      const frame =
        msg instanceof Float32Array
          ? msg
          : msg.buffer instanceof ArrayBuffer && msg.type === 'pcm'
            ? new Float32Array(msg.buffer)
            : null
      if (frame) this.push(frame)
    }
  }

  /** 48kHz in, this graph's rate out. Identical algorithm to Tier1Resampler
   *  in tier1-source.ts, which carries the tests. */
  resample(input) {
    if (!sampleRate || sampleRate === SOURCE_RATE) return input
    if (input.length === 0) return input
    const step = SOURCE_RATE / sampleRate
    // Virtual buffer [last, ...input]: index 0 is the carried sample, so
    // index k >= 1 is input[k - 1]. This is what makes the seam between
    // frames interpolate instead of restarting — without it there would be a
    // discontinuity every 480 samples, i.e. 100 clicks a second.
    const at = (i) => (i <= 0 ? this.last : input[i - 1])
    const out = []
    let pos = this.phase
    while (pos + 1 <= input.length) {
      const i = Math.floor(pos)
      const frac = pos - i
      out.push(at(i) * (1 - frac) + at(i + 1) * frac)
      pos += step
    }
    this.phase = pos - input.length
    this.last = input[input.length - 1]
    return Float32Array.from(out)
  }

  push(rawFrame) {
    if (!this.active) return
    const frame = this.resample(rawFrame)
    if (frame.length === 0) return
    const cap = this.buf.length
    // A frame bigger than the whole ring can only be satisfied by its TAIL —
    // keeping the head would play audio we are about to overwrite.
    if (frame.length >= cap) {
      this.buf.set(frame.subarray(frame.length - cap))
      this.readPos = 0
      this.writePos = 0
      this.filled = cap
      this.overflowSamples += frame.length - cap
      return
    }
    for (let i = 0; i < frame.length; i++) {
      this.buf[this.writePos] = frame[i]
      this.writePos = (this.writePos + 1) % cap
    }
    this.filled += frame.length
    if (this.filled > cap) {
      // Advance the reader past what was just overwritten so it never serves
      // a mix of fresh and stale audio.
      const lost = this.filled - cap
      this.readPos = (this.readPos + lost) % cap
      this.overflowSamples += lost
      this.filled = cap
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0]
    if (!out || out.length === 0) return true
    const channel = out[0]
    const cap = this.buf.length
    const n = this.active ? Math.min(channel.length, this.filled) : 0

    for (let i = 0; i < n; i++) {
      channel[i] = this.buf[this.readPos]
      this.readPos = (this.readPos + 1) % cap
    }
    if (n < channel.length) {
      channel.fill(0, n) // silence, never a repeated frame
      this.underrunSamples += channel.length - n
    }
    this.filled -= n

    // Mirror to any additional channels so a stereo-configured destination
    // does not receive a silent right channel.
    for (let c = 1; c < out.length; c++) out[c].set(channel)

    // ALWAYS true. Returning false permanently kills the node, and a source
    // that is momentarily empty (the pipe reconnecting) is not a dead source.
    return true
  }
}

registerProcessor('denoised-source', DenoisedSourceProcessor)
