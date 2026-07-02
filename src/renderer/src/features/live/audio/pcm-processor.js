// AudioWorklet processor: converts microphone audio (Float32) into 16-bit PCM
// (linear16) and posts ~2048-sample chunks back to the main thread for
// streaming to Deepgram. Runs on the dedicated audio thread.
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Int16Array(2048)
    this.offset = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (input && input[0]) {
      const channel = input[0]
      for (let i = 0; i < channel.length; i++) {
        let sample = channel[i]
        if (sample > 1) sample = 1
        else if (sample < -1) sample = -1
        this.buffer[this.offset++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
        if (this.offset === this.buffer.length) {
          // Copy the filled buffer and hand it off.
          this.port.postMessage(this.buffer.buffer.slice(0))
          this.offset = 0
        }
      }
    }
    return true
  }
}

registerProcessor('pcm-processor', PCMProcessor)
