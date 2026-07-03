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
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.stereo = false
    this.buffer = new Int16Array(2048) // mono: 2048 samples
    this.offset = 0
    this.port.onmessage = (event) => {
      const data = event.data
      if (data && data.type === 'mode') {
        const stereo = data.stereo === true
        if (stereo !== this.stereo) {
          this.stereo = stereo
          // New layout → fresh buffer + reset, so one chunk never mixes layouts.
          // Stereo buffer is even (a multiple of 2 × 128) so an L/R pair is never
          // split across two messages.
          this.buffer = new Int16Array(stereo ? 4096 : 2048)
          this.offset = 0
        }
      }
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
