// `?url` makes Vite emit the worklet as a standalone asset (not bundled),
// which is required for audioWorklet.addModule().
import pcmProcessorUrl from './pcm-processor.js?url'
import denoisedSourceUrl from './denoised-source.js?url'
import {
  getMicConstraints,
  TRANSCRIPTION_SAMPLE_RATE,
  isCallRiseMic,
  isThirdPartyVirtualMic
} from '@renderer/features/audio/devices'
import { startAudioPump, type AudioPump } from './pump'
import { shouldUseDenoisedSource } from './tier1-source'
import type { Tier1Status } from './tier1-types'

/**
 * The name Tier 1's engine must be told to capture. Returns the real device
 * label unchanged, or `null` — never `''` — when it isn't safe to use.
 *
 * WHY NULL AND NOT EMPTY STRING. An empty argument does not mean "no
 * preference" to kern_bridge; it falls through to the engine's OWN
 * auto-pick. `isCallRiseMic` is this app's self-capture guard, which already
 * keeps our own virtual device out of `getUserMedia` in the ordinary case —
 * but this is checked again here, on the label getUserMedia actually
 * granted, because trusting that upstream guard and passing '' on the rare
 * path where it doesn't apply would hand kern_bridge's auto-pick the exact
 * job this function exists to keep away from it. A user with only virtual
 * devices available must get "Tier 1 skipped for this call", never "Tier 1
 * auto-picked something" — so the caller treats `null` as "do not start
 * Tier 1 at all," not as "start it with no argument."
 *
 * ALSO excludes THIRD-PARTY virtual/denoising mics (F-08 — see
 * isThirdPartyVirtualMic's own doc). kern_bridge.cpp's own comment states,
 * as fact, that "the renderer applies the same rule when it chooses a name
 * to hand us" before this function's Krisp exclusion existed, that claim
 * was false: only isCallRiseMic was checked, so a machine whose resolved
 * input device is a competitor's virtual mic (e.g. Krisp, set as the
 * Windows default by its own installer) would have Tier 1 tell kern_bridge
 * to capture and denoise that mic's ALREADY-denoised output as real
 * hardware — the exact double-processing bug F-08 exists to prevent,
 * reachable through the one path kern_bridge's own auto-pick guard
 * explicitly does not cover (an explicitly-passed name, which it treats as
 * a legitimate deliberate choice and honours without question).
 */
export function resolveTier1MicName(trackLabel: string): string | null {
  if (!trackLabel) return null
  if (isCallRiseMic(trackLabel)) return null
  if (isThirdPartyVirtualMic(trackLabel)) return null
  return trackLabel
}

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
  /**
   * True only while Tier 1's denoised audio is genuinely feeding this call —
   * never true merely because the engine is running or the pipe is
   * connected (see shouldUseDenoisedSource). False covers unavailable, off,
   * starting, AND passthrough alike, on purpose: from the caller's side
   * those are all "raw audio is what's actually being sent" and deserve the
   * same answer. Surfaced for the same `--diagnose` reason as
   * usingDirectPath.
   */
  isTier1Active: () => boolean
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

  // Constrained to Deepgram's own recommended ASR rate rather than left to
  // inherit whatever the OS negotiates for the default device (commonly
  // 44.1/48kHz on Windows) — see TRANSCRIPTION_SAMPLE_RATE's own doc comment
  // for why an unconstrained rate specifically bites once buyer capture
  // doubles the channel count on top of it. `sampleRate` is a best-effort
  // hint per spec, not guaranteed on every engine/OS combination, so this
  // falls back to the unconstrained default rather than failing capture
  // outright on whatever exotic setup doesn't honor it — a slower call is
  // recoverable, no microphone at all is not.
  let context: AudioContext
  try {
    context = new AudioContext({ sampleRate: TRANSCRIPTION_SAMPLE_RATE })
  } catch {
    context = new AudioContext()
  }
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
  // If the worker dies mid-call after the handshake succeeded, revert the
  // worklet to the postMessage fallback it never stopped supporting — the
  // ring attach only made it stop USING that path, it didn't remove it. Kept
  // as a named function (not inline) so it reads the same whether it fires
  // during setup or minutes into a live call.
  const fallBackToPostMessage = (): void => {
    worklet.port.postMessage({ type: 'ring-detach' })
    pump = null
  }
  try {
    pump = await startAudioPump(
      context.sampleRate,
      stereoMode,
      (frames) => onAudioDropped?.(frames),
      fallBackToPostMessage
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

  // --- Tier 1 (M27): driver-free noise cancellation for THIS call's audio ---
  //
  // Substitutes only the SOURCE feeding merger channel 0. `micSource` itself
  // is never disconnected here, never mind `micTrack`/`stream` — the targeted
  // 3-argument `disconnect(merger, 0, 0)` below removes exactly one edge and
  // leaves `micSource → analyser` (the waveform) intact the whole time, so the
  // real microphone capture never goes dark regardless of which source is
  // feeding transcription. See docs/M27-tier1-recorder-handoff.md for why this
  // shape — switching edges, not tracks — is what makes "raw mic never
  // disconnected" achievable at all, rather than an assertion of hope.
  let tier1Node: AudioWorkletNode | null = null
  let tier1Active = false // true iff tier1Node currently feeds merger ch0
  let unsubTier1Status: (() => void) | null = null
  let unsubTier1Pcm: (() => void) | null = null

  const tier1Api = typeof window !== 'undefined' ? window.api?.tier1 : undefined
  const tier1MicName = resolveTier1MicName(micTrack?.label ?? '')

  const useTier1Source = (): void => {
    if (!tier1Node || tier1Active) return
    try {
      micSource.disconnect(merger, 0, 0)
    } catch {
      /* already not connected — nothing to undo */
    }
    tier1Node.connect(merger, 0, 0)
    tier1Active = true
  }

  const useRawSource = (): void => {
    if (tier1Active && tier1Node) {
      try {
        tier1Node.disconnect(merger, 0, 0)
      } catch {
        /* already not connected — nothing to undo */
      }
    }
    // connect() to an already-connected (destination, output, input) is a
    // spec-defined no-op, so this is safe to call unconditionally — it makes
    // this function idempotent from any starting state, including the very
    // first call before Tier 1 has ever become eligible.
    micSource.connect(merger, 0, 0)
    tier1Active = false
  }

  if (tier1Api && tier1MicName) {
    try {
      await context.audioWorklet.addModule(denoisedSourceUrl)
      tier1Node = new AudioWorkletNode(context, 'denoised-source', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1]
      })
      // Keeps tier1Node processing continuously — draining its ring on
      // schedule, so it is never stale the moment it's switched in — WITHOUT
      // ever being audible on its own. A direct connection to `destination`
      // would let the user hear their own denoised voice back as an echo; a
      // zero-gain node is the standard Web Audio keep-alive, the same
      // mechanism the existing `worklet.connect(context.destination)` below
      // uses for the chunker (which stays silent by construction instead).
      const tier1Silencer = context.createGain()
      tier1Silencer.gain.value = 0
      tier1Node.connect(tier1Silencer)
      tier1Silencer.connect(context.destination)

      const node = tier1Node
      unsubTier1Pcm = tier1Api.onPcm((frame) => {
        node.port.postMessage({ type: 'pcm', buffer: frame }, [frame])
      })
      unsubTier1Status = tier1Api.onStatus((status: Tier1Status) => {
        if (shouldUseDenoisedSource(status)) useTier1Source()
        else useRawSource()
      })
      // Covers the gap between "engine started" and the first broadcast: if
      // it's already denoising by the time we ask, don't wait for the next
      // status push to catch up.
      tier1Api
        .getStatus()
        .then((status: Tier1Status) => {
          if (shouldUseDenoisedSource(status)) useTier1Source()
        })
        .catch(() => {
          /* stays on raw — the safe direction */
        })

      void tier1Api.start(tier1MicName)
    } catch {
      // The worklet module failed to load or the node failed to construct.
      // FAIL OPEN: nothing above this point has touched micSource/merger, so
      // raw audio keeps working exactly as it always has.
      tier1Node = null
    }
  }

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
    isTier1Active: (): boolean => tier1Active,
    stop: (): void => {
      if (stopped) return
      stopped = true
      // Cut the chunk path FIRST, before anything that can throw. This used to
      // sit after detachLoopback(), which stops loopback tracks outside a
      // try — a throw there aborted stop() with `stopped` already true and
      // `onmessage` still wired, leaving a recorder that no longer looks
      // live but keeps posting PCM into sendAudio forever, with no reference
      // left to stop it. Nulling a handler cannot throw, so it goes first.
      worklet.port.onmessage = null
      if (pump) {
        // Explicit rather than relying on merger.disconnect() to starve the
        // worklet's input into silence: without this the worklet's `ring`
        // reference outlives the buffer it points at for however long the
        // disconnect takes to actually stop delivering render quanta.
        worklet.port.postMessage({ type: 'ring-detach' })
        pump.stop()
        pump = null
      }
      // Same reasoning as the pump above, and same ordering concern as the
      // comment at the top of stop(): unsubscribe before anything that can
      // throw, so a live IPC callback can never outlive this call and keep
      // an AudioContext (and a spawned kern_bridge.exe) alive with nothing
      // left holding a reference to stop either one.
      unsubTier1Pcm?.()
      unsubTier1Pcm = null
      unsubTier1Status?.()
      unsubTier1Status = null
      if (tier1Api) void tier1Api.stop()
      detachLoopback()
      micTrack?.removeEventListener('ended', handleEnded)
      try {
        micSource.disconnect()
        merger.disconnect()
        worklet.disconnect()
        analyser.disconnect()
        tier1Node?.disconnect()
      } catch {
        /* ignore */
      }
      stream.getTracks().forEach((t) => t.stop())
      void context.close()
    }
  }
}
