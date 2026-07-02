// `?url` makes Vite emit the worklet as a standalone asset (not bundled),
// which is required for audioWorklet.addModule().
import pcmProcessorUrl from './pcm-processor.js?url'

export interface Recorder {
  /** Analyser node for drawing the live waveform. */
  analyser: AnalyserNode
  /** The audio context's actual sample rate (told to Deepgram). */
  sampleRate: number
  /** Pause/resume sending audio without releasing the mic. */
  setPaused: (paused: boolean) => void
  /** Stop capture and release the microphone. */
  stop: () => void
}

/**
 * Starts microphone capture and streams 16-bit PCM chunks via `onChunk`.
 * Throws (getUserMedia errors) if the mic can't be opened — the caller maps
 * those to friendly states.
 */
export async function startRecorder(
  onChunk: (chunk: ArrayBuffer) => void,
  onDeviceLost: () => void
): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  })

  const context = new AudioContext()
  await context.resume()
  await context.audioWorklet.addModule(pcmProcessorUrl)

  const source = context.createMediaStreamSource(stream)
  const worklet = new AudioWorkletNode(context, 'pcm-processor')
  const analyser = context.createAnalyser()
  analyser.fftSize = 1024
  analyser.smoothingTimeConstant = 0.6

  let paused = false
  worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>): void => {
    if (!paused) onChunk(event.data)
  }

  source.connect(worklet)
  source.connect(analyser)
  // Keep the worklet in the active graph; it outputs silence (no echo).
  worklet.connect(context.destination)

  const track = stream.getAudioTracks()[0]
  const handleEnded = (): void => onDeviceLost()
  track?.addEventListener('ended', handleEnded)

  let stopped = false
  return {
    analyser,
    sampleRate: context.sampleRate,
    setPaused: (value: boolean): void => {
      paused = value
    },
    stop: (): void => {
      if (stopped) return
      stopped = true
      track?.removeEventListener('ended', handleEnded)
      worklet.port.onmessage = null
      try {
        source.disconnect()
        worklet.disconnect()
        analyser.disconnect()
      } catch {
        /* ignore */
      }
      stream.getTracks().forEach((t) => t.stop())
      void context.close()
    }
  }
}
