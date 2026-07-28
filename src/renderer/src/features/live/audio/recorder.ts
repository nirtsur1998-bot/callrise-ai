// `?url` makes Vite emit the worklet as a standalone asset (not bundled),
// which is required for audioWorklet.addModule().
import pcmProcessorUrl from './pcm-processor.js?url'
import { getMicConstraints } from '@renderer/features/audio/devices'
import { startAudioPump, type AudioPump } from './pump'

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
   * Add the other party's audio (system loopback) as channel 1 of the merger.
   * This only wires the audio graph — it does NOT change the output layout;
   * call `setStereo(true)` once the multichannel socket is ready. `onEnded`
   * fires if the loopback source stops on its own (e.g. the OS revokes it).
   */
  attachLoopback: (stream: MediaStream, onEnded?: () => void) => void
  /** Remove the loopback source (graph + tracks). Does not change the layout. */
  detachLoopback: () => void
  /**
   * Switch the emitted PCM layout: true = interleaved stereo [you, buyer],
   * false = mono (mic only). Kept separate from attach/detach so the layout
   * flips only AFTER the Deepgram socket has switched channel count to match.
   */
  setStereo: (stereo: boolean) => void
  /** Whether a loopback source is currently attached. */
  isLoopbackAttached: () => boolean
  /**
   * True when audio is bypassing the renderer's main thread entirely (§1.4).
   * False means the original postMessage path — still correct, just coupled to
   * UI responsiveness. Surfaced so `--diagnose` can say which path a machine
   * is actually on rather than which one it was supposed to be on.
   */
  usingDirectPath: () => boolean
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
  onDeviceLost: () => void,
  onAudioDropped?: (frames: number) => void
): Promise<Recorder> {
  // Honor the mic chosen in the Home "Audio sources" section (falls back to
  // the system default when none is set or the chosen device is gone).
  const stream = await navigator.mediaDevices.getUserMedia({ audio: getMicConstraints() })

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

  // The fast path (§1.4). Brought up AFTER the graph is running and switched on
  // only once the worker confirms it is draining, so there is never a moment
  // where the worklet writes into a ring nobody reads. If anything at all is
  // missing — no shared memory, no port, no worker — `pump` stays null and the
  // postMessage path above carries the call exactly as it always has.
  let pump: AudioPump | null = null
  let stereoMode = false
  try {
    pump = await startAudioPump(context.sampleRate, stereoMode, (frames) =>
      onAudioDropped?.(frames)
    )
  } catch {
    pump = null
  }
  if (pump) {
    worklet.port.postMessage(pump.ringMessage)
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

  const setStereo = (stereo: boolean): void => {
    stereoMode = stereo
    worklet.port.postMessage({ type: 'mode', stereo })
    // Told to both sides. They can disagree for a few frames while the messages
    // land; they cannot disagree about how to READ a byte, because the ring's
    // frame layout is fixed at 2 channels for the whole call.
    pump?.setStereo(stereo)
  }

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
  }

  const attachLoopback = (s: MediaStream, onEnded?: () => void): void => {
    detachLoopback() // never stack two loopback sources
    loopStream = s
    loopSource = context.createMediaStreamSource(s)
    // A merger input is mono, so a stereo loopback is downmixed to channel 1.
    // The worklet keeps emitting mono (ignoring ch1) until setStereo(true).
    loopSource.connect(merger, 0, 1)
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
      pump?.setPaused(value)
    },
    attachLoopback,
    detachLoopback,
    setStereo,
    isLoopbackAttached: (): boolean => loopSource !== null,
    usingDirectPath: (): boolean => pump !== null,
    stop: (): void => {
      if (stopped) return
      stopped = true
      pump?.stop()
      pump = null
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
