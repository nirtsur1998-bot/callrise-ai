/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain-JS audio worklet; TS return types don't apply */
// AudioWorklet processor: converts audio (Float32) to 16-bit PCM (linear16) and
// posts chunks to the main thread for streaming to Deepgram. Runs on the audio
// thread.
//
// Two modes, switched by a {type:'mode', stereo} message:
//  - mono (default): emit channel 0 only — the mic. Byte-for-byte the original
//    behaviour, so mic-only calls are unaffected.
//  - stereo: interleave channel 0 (mic / you) and channel 1 (loopback / buyer)
//    as [you, buyer, you, buyer, ...] for Deepgram multichannel (channels=2).
// The input is a 2-channel ChannelMergerNode output; in mono mode channel 1 is
// simply ignored.
//
// Two DELIVERY paths, chosen by whether a ring was attached (§1.4):
//  - ring: write straight into a SharedArrayBuffer that a worker drains on its
//    own thread. The renderer's main thread is never involved, so a render
//    storm cannot delay audio leaving the machine — which is the whole
//    mechanism behind the 90-second lag ratchet.
//  - postMessage (default): the original path, kept intact as the fallback for
//    when shared memory is unavailable. Byte-for-byte unchanged, because the
//    fallback carrying the entire product has to be the code that already
//    worked rather than a hasty rewrite of it.
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.stereo = false
    this.buffer = new Int16Array(2048) // mono: 2048 samples
    this.offset = 0
    // Ring state (null until a {type:'ring'} message arrives).
    this.control = null
    this.ring = null
    this.capacityFrames = 0
    this.ringChannels = 0
    this.slots = { write: 0, read: 1, overrun: 2 }
    this.port.onmessage = (event) => {
      const data = event.data
      if (!data) return
      if (data.type === 'mode') {
        const stereo = data.stereo === true
        if (stereo !== this.stereo) {
          // Flush whatever's already buffered in the OLD layout before
          // switching, instead of silently dropping it. It's a complete,
          // self-consistent chunk (just shorter than a full buffer) in the
          // layout the main process still expects at this point in the
          // stream, so the existing postMessage path handles it exactly like
          // any other chunk — no special framing needed. Without this, up to
          // one buffer's worth (~128ms at 16kHz) of audio captured in the
          // instant before a mono<->stereo switch (i.e. buyer capture
          // turning on/off) was lost with no trace in the transcript's own
          // [gap: Ns] mechanism. Only relevant on the postMessage path — the
          // ring path (this.ring set) never advances this.offset in the
          // first place, since process() returns before reaching it.
          if (this.offset > 0 && !this.ring) {
            this.port.postMessage(this.buffer.buffer.slice(0, this.offset * 2))
          }
          this.stereo = stereo
          // New layout → fresh buffer + reset, so one chunk never mixes layouts.
          // Stereo buffer is even (a multiple of 2 × 128) so an L/R pair is never
          // split across two messages.
          this.buffer = new Int16Array(stereo ? 4096 : 2048)
          this.offset = 0
        }
      } else if (data.type === 'ring') {
        // The ring is fixed at 2 channels: it is only ever attached for a
        // session that may go stereo, and re-laying it out mid-call would
        // reinterpret every byte already in it. In mono mode channel 1 is
        // written as silence and the reader drops it.
        this.control = new Int32Array(data.buffer, 0, data.control.controlInts)
        this.ring = new Int16Array(
          data.buffer,
          data.control.controlInts * 4,
          data.capacityFrames * data.channels
        )
        this.capacityFrames = data.capacityFrames
        this.ringChannels = data.channels
        this.slots = {
          write: data.control.writeIndex,
          read: data.control.readIndex,
          overrun: data.control.overrunFrames
        }
      } else if (data.type === 'ring-detach') {
        this.control = null
        this.ring = null
      }
    }
  }

  /** One frame into the ring. Allocation-free and never blocks — a real-time
   *  callback that waits is a real-time callback that has already failed. */
  writeRing(mic, buyer) {
    const control = this.control
    const write = Atomics.load(control, this.slots.write)
    const offset = (write % this.capacityFrames) * this.ringChannels
    this.ring[offset] = mic
    if (this.ringChannels > 1) this.ring[offset + 1] = buyer
    Atomics.store(control, this.slots.write, write + 1)
    // The producer never moves the read index — that belongs to the consumer,
    // and touching it here is the exact race this design exists to avoid.
    if (write + 1 - Atomics.load(control, this.slots.read) > this.capacityFrames) {
      Atomics.add(control, this.slots.overrun, 1)
    }
  }

  static toPcm(sample) {
    if (sample > 1) sample = 1
    else if (sample < -1) sample = -1
    return sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }

  process(inputs) {
    const input = inputs[0]
    const mic = input && input[0]
    if (!mic) return true

    if (this.ring) {
      const buyer = this.stereo ? input[1] : null
      for (let i = 0; i < mic.length; i++) {
        this.writeRing(PCMProcessor.toPcm(mic[i]), buyer ? PCMProcessor.toPcm(buyer[i]) : 0)
      }
      return true
    }

    if (this.stereo) {
      const buyer = input[1] // channel 1 of the merger; undefined → treat as silent
      for (let i = 0; i < mic.length; i++) {
        this.buffer[this.offset++] = PCMProcessor.toPcm(mic[i])
        this.buffer[this.offset++] = PCMProcessor.toPcm(buyer ? buyer[i] : 0)
        if (this.offset === this.buffer.length) {
          this.port.postMessage(this.buffer.buffer.slice(0))
          this.offset = 0
        }
      }
    } else {
      for (let i = 0; i < mic.length; i++) {
        this.buffer[this.offset++] = PCMProcessor.toPcm(mic[i])
        if (this.offset === this.buffer.length) {
          this.port.postMessage(this.buffer.buffer.slice(0))
          this.offset = 0
        }
      }
    }
    return true
  }
}

registerProcessor('pcm-processor', PCMProcessor)
