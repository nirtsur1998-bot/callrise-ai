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

/** The port main sends us, re-posted into this world by the preload. */
function awaitPort(timeoutMs: number): Promise<MessagePort | null> {
  return new Promise((resolve) => {
    let done = false
    const finish = (port: MessagePort | null): void => {
      if (done) return
      done = true
      window.removeEventListener('message', onMessage)
      clearTimeout(timer)
      resolve(port)
    }
    const onMessage = (event: MessageEvent): void => {
      // Same-window only, and only our tag. Nothing else can hand us a pipe to
      // the process that owns the Deepgram socket.
      if (event.source !== window) return
      if ((event.data as { type?: string } | null)?.type !== 'callrise:audio-port') return
      finish(event.ports[0] ?? null)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
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
  onDropped: (frames: number) => void
): Promise<AudioPump | null> {
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
