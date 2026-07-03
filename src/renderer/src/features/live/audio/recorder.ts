// `?url` makes Vite emit the worklet as a standalone asset (not bundled),
// which is required for audioWorklet.addModule().
import pcmProcessorUrl from './pcm-processor.js?url'

export interface Recorder {
  /** Analyser node for drawing the live waveform (mic only). */
  analyser: AnalyserNode
  /** The audio context's actual sample rate (told to Deepgram). */
  sampleRate: number
  /** Pause/resume sending audio without releasing the mic. */
  setPaused: (paused: boolean) => void
  /** Stop capture and release the microphone (and any loopback). */
  stop: () => void
  /**
   * Add the other party's audio (system loopback) as channel 1 → the worklet
   * switches to interleaved stereo output. `onEnded` fires if the loopback
   * source stops on its own (e.g. the OS revokes screen recording).
   */
  attachLoopback: (stream: MediaStream, onEnded?: () => void) => void
  /** Remove the loopback source → back to mono mic-only output. */
  detachLoopback: () => void
  /** Whether a loopback source is currently attached. */
  isLoopbackAttached: () => boolean
}

/**
 * Starts microphone capture and streams 16-bit PCM chunks via `onChunk`.
 * Throws (getUserMedia errors) if the mic can't be opened — the caller maps
 * those to friendly states.
 *
 * The mic feeds channel 0 of a ChannelMergerNode; an optional loopback source
 * feeds channel 1. Both share this one AudioContext, so the two channels stay
 * sample-aligned (no drift). Until `attachLoopback` is called, the worklet
 * emits mono — identical to mic-only behaviour.
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

  const micSource = context.createMediaStreamSource(stream)
  // Merge mic (ch0) + optional loopback (ch1) into one 2-channel stream.
  const merger = new ChannelMergerNode(context, { numberOfInputs: 2 })
  const worklet = new AudioWorkletNode(context, 'pcm-processor', {
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'discrete'
  })
  const analyser = context.createAnalyser()
  analyser.fftSize = 1024
  analyser.smoothingTimeConstant = 0.6

  let paused = false
  worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>): void => {
    if (!paused) onChunk(event.data)
  }

  micSource.connect(merger, 0, 0)
  micSource.connect(analyser) // waveform reflects the rep (mic) only
  merger.connect(worklet)
  // Keep the worklet in the active graph; it outputs silence (no echo).
  worklet.connect(context.destination)

  const micTrack = stream.getAudioTracks()[0]
  const handleEnded = (): void => onDeviceLost()
  micTrack?.addEventListener('ended', handleEnded)

  // --- Loopback (the other party), attached only after consent ---------------
  let loopStream: MediaStream | null = null
  let loopSource: MediaStreamAudioSourceNode | null = null
  let loopTrack: MediaStreamTrack | null = null
  let loopEndedHandler: (() => void) | null = null

  const detachLoopback = (): void => {
    if (loopTrack && loopEndedHandler) loopTrack.removeEventListener('ended', loopEndedHandler)
    loopEndedHandler = null
    loopTrack = null
    try {
      loopSource?.disconnect()
    } catch {
      /* ignore */
    }
    loopSource = null
    loopStream?.getTracks().forEach((t) => t.stop())
    loopStream = null
    worklet.port.postMessage({ type: 'mode', stereo: false })
  }

  const attachLoopback = (s: MediaStream, onEnded?: () => void): void => {
    detachLoopback() // never stack two loopback sources
    loopStream = s
    loopSource = context.createMediaStreamSource(s)
    // A merger input is mono, so a stereo loopback is downmixed to channel 1.
    loopSource.connect(merger, 0, 1)
    worklet.port.postMessage({ type: 'mode', stereo: true })
    loopTrack = s.getAudioTracks()[0] ?? null
    if (loopTrack && onEnded) {
      loopEndedHandler = (): void => onEnded()
      loopTrack.addEventListener('ended', loopEndedHandler)
    }
  }

  let stopped = false
  return {
    analyser,
    sampleRate: context.sampleRate,
    setPaused: (value: boolean): void => {
      paused = value
    },
    attachLoopback,
    detachLoopback,
    isLoopbackAttached: (): boolean => loopSource !== null,
    stop: (): void => {
      if (stopped) return
      stopped = true
      detachLoopback()
      micTrack?.removeEventListener('ended', handleEnded)
      worklet.port.onmessage = null
      try {
        micSource.disconnect()
        merger.disconnect()
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
