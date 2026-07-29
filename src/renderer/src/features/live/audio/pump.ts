// Sets up the §1.4 fast path: worklet → SharedArrayBuffer → worker → main.
//
// Everything here is written around one rule: if ANY part of the chain is
// unavailable or slow to come up, we do not limp — we return null and the
// recorder uses the original postMessage path unchanged. A partial fast path
// would be worse than no fast path, because the failure mode is silence on a
// live sales call, and this project has already shipped one boot-time crash
// from code that assumed a capability instead of checking for it.
//
// The handshake is what makes that honest. The worklet is not told about the
// ring until the worker has confirmed it is draining. Until then audio flows
// the old way, so there is no window in which frames are written somewhere
// nobody is reading.

import PumpWorker from './audio-pump.worker?worker'
import { RING_CONTROL, framesForSeconds, ringByteLength, sharedMemoryAvailable } from './ring'
import type { PumpEvent } from './audio-pump.worker'

/** Enough to cover worker scheduling jitter with room to spare. The worker is
 *  not blocked by main-thread stalls, so this never needs to be large — and a
 *  large ring would only mean more stale audio to catch up on after a gap. */
const RING_SECONDS = 2
/** Drain cadence. The ring absorbs jitter, so this trades a few ms of latency
 *  for not waking the worker 375 times a second. */
const DRAIN_MS = 20
/** How long to wait for main's port and the worker's `ready`. Past this the
 *  fast path is simply declared unavailable. */
const HANDSHAKE_MS = 1500

export interface AudioPump {
  /** Layout to hand the worklet in its `ring` message. */
  ringMessage: {
    type: 'ring'
    buffer: SharedArrayBuffer
    capacityFrames: number
    channels: number
    control: typeof RING_CONTROL
  }
  /** Mirror of the worklet's stereo flag. Safe to call at any time: the ring
   *  is always 2-channel, so the two sides can only ever disagree about a few
   *  frames, never about how to interpret a byte. */
  setStereo: (stereo: boolean) => void
  /** Pause forwarding. The worker keeps draining and discards, so resuming
   *  starts at the live edge instead of replaying the pause. */
  setPaused: (paused: boolean) => void
  /** Frames lost to ring overrun this session — surfaced so a drop shows up as
   *  a gap rather than as words that quietly never existed. */
  droppedFrames: () => number
  stop: () => void
}

/**
 * Whether the §1.4 SharedArrayBuffer/worker fast path may be used.
 *
 * Hard-off: on Electron a MessagePortMain port transferred into a Web Worker is
 * severed from the main process, so the worker's drained audio never arrives —
 * see the long note in startAudioPump. Kept as a function (not a `const false`)
 * so the rest of the module stays reachable/typechecked and re-enabling later is
 * a one-line change once the port can reach main from a worker.
 */
function fastPathEnabled(): boolean {
  return false
}

/** The port main sends us, re-posted into this world by the preload. */
function awaitPort(timeoutMs: number): Promise<MessagePort | null> {
  return new Promise((resolve) => {
    let resolved = false
    let listening = true
    const stopListening = (): void => {
      if (!listening) return
      listening = false
      window.removeEventListener('message', onMessage)
    }
    const onMessage = (event: MessageEvent): void => {
      // Same-window only, and only our tag. Nothing else can hand us a pipe to
      // the process that owns the Deepgram socket.
      if (event.source !== window) return
      if ((event.data as { type?: string } | null)?.type !== 'callrise:audio-port') return
      const port = event.ports[0] ?? null
      if (resolved) {
        // The handshake already timed out and the caller moved on to the
        // fallback path — this port arrived too late to use. Close it rather
        // than leaving it open: main's paired end only cleans up on the NEXT
        // request or the window closing, so an unclosed late port would sit
        // alive for nothing until either of those happens.
        try {
          port?.close()
        } catch {
          /* already gone */
        }
        stopListening()
        return
      }
      resolved = true
      stopListening()
      clearTimeout(giveUpTimer)
      resolve(port)
    }
    const giveUpTimer = setTimeout(() => {
      if (resolved) return
      resolved = true
      resolve(null)
      // Keep listening a little longer in case the grant is just about to
      // land — closing a late arrival beats leaking it forever — then give up
      // for good so this listener doesn't outlive the call.
      setTimeout(stopListening, timeoutMs)
    }, timeoutMs)
    window.addEventListener('message', onMessage)
    window.api.transcription.requestAudioPort()
  })
}

/**
 * Try to bring up the fast path.
 *
 * Returns null — never throws, never half-succeeds — when shared memory is
 * unavailable, the port does not arrive, or the worker fails to start.
 */
export async function startAudioPump(
  sampleRate: number,
  stereo: boolean,
  onDropped: (frames: number) => void,
  /** Called at most once, if the worker dies or reports an error AFTER the
   *  handshake succeeded. The caller is expected to revert the worklet to the
   *  postMessage fallback (send it 'ring-detach') — this module cannot do
   *  that itself, since it never holds a reference to the worklet. */
  onFailure?: () => void
): Promise<AudioPump | null> {
  // DISABLED (investigated 2026-07-29): this fast path cannot deliver audio on
  // Electron. The port main hands over is a MessagePortMain pair; the moment it
  // is transferred INTO this Web Worker (see `worker.postMessage({...}, [port])`
  // below), Electron severs its link to the main process. The worker then drains
  // the ring and posts every frame, but none of them arrive at main's port
  // handler — verified end to end: the ring's READ_INDEX advances to the full
  // frame count while main's `submittedSec` stays 0, Deepgram receives nothing,
  // and the 10s no-audio watchdog tears the session down as "No microphone
  // found." Critically the handshake still SUCCEEDS (the worker's `ready` travels
  // the worker<->window channel, not the main port), so bringing this path up
  // switches the worklet to ring mode and SILENCES the postMessage fallback —
  // turning a broken optimization into a total audio blackout with no
  // transcription. Until a worker can reach the main process directly, force the
  // proven postMessage path (worklet -> onChunk -> transcription.sendAudio) by
  // declaring the fast path unavailable, exactly as the recorder already handles.
  if (!fastPathEnabled()) return null
  if (!sharedMemoryAvailable()) return null

  const layout = {
    capacityFrames: framesForSeconds(RING_SECONDS, sampleRate),
    // Fixed at 2 so a mid-call mono↔stereo switch never reinterprets bytes
    // already in the ring. In mono the worker emits channel 0 only.
    channels: 2
  }

  let buffer: SharedArrayBuffer
  let worker: Worker
  try {
    buffer = new SharedArrayBuffer(ringByteLength(layout))
    worker = new PumpWorker()
  } catch {
    return null
  }

  const port = await awaitPort(HANDSHAKE_MS)
  if (!port) {
    worker.terminate()
    return null
  }

  let dropped = 0
  const ready = await new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), HANDSHAKE_MS)
    worker.onmessage = (event: MessageEvent<PumpEvent>): void => {
      const data = event.data
      if (data.type === 'ready') finish(true)
      else if (data.type === 'error') finish(false)
      else if (data.type === 'dropped') {
        dropped += data.frames
        onDropped(data.frames)
      }
    }
    worker.onerror = (): void => finish(false)
    worker.postMessage({ type: 'init', buffer, layout, drainMs: DRAIN_MS, stereo }, [port])
  })

  if (!ready) {
    worker.terminate()
    try {
      port.close()
    } catch {
      /* already gone */
    }
    return null
  }

  let stopped = false

  // The handshake's own onmessage/onerror close over `settled`, which is
  // already true by now — so from here on those handlers would silently
  // no-op on a real failure. Replace them with handlers that stay meaningful
  // for the rest of the pump's life: 'dropped' keeps being counted, and a
  // post-handshake error or worker crash calls `onFailure` exactly once so
  // the caller can fall back instead of an audio path that has gone dark with
  // no signal that it did.
  let failed = false
  const fail = (): void => {
    if (failed || stopped) return
    failed = true
    onFailure?.()
  }
  worker.onmessage = (event: MessageEvent<PumpEvent>): void => {
    const data = event.data
    if (data.type === 'dropped') {
      dropped += data.frames
      onDropped(data.frames)
    } else if (data.type === 'error') {
      fail()
    }
  }
  worker.onerror = (): void => fail()

  return {
    ringMessage: {
      type: 'ring',
      buffer,
      capacityFrames: layout.capacityFrames,
      channels: layout.channels,
      control: RING_CONTROL
    },
    setStereo: (value: boolean): void => {
      if (!stopped) worker.postMessage({ type: 'stereo', stereo: value })
    },
    setPaused: (value: boolean): void => {
      if (!stopped) worker.postMessage({ type: 'paused', paused: value })
    },
    droppedFrames: (): number => dropped,
    stop: (): void => {
      if (stopped) return
      stopped = true
      // Ask for a final drain first — the last second of a call is the part
      // with the next steps in it — then terminate rather than trusting the
      // worker to have exited on its own.
      worker.postMessage({ type: 'stop' })
      setTimeout(() => worker.terminate(), DRAIN_MS * 4)
    }
  }
}
