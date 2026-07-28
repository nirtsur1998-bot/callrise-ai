// The consumer half of §1.4: drains the audio ring on its own thread and hands
// the bytes straight to the main process.
//
// The path this replaces was worklet → renderer MAIN thread → IPC. That made
// transcription latency a function of UI responsiveness: a render storm, a big
// synchronous layout, a long GC pause — any of them queued audio behind the
// main thread, and because Deepgram accepts audio at only 1.25x realtime, a
// five-second stall does not cost five seconds. It costs twenty, and the lag
// never comes back on its own. That is the ratchet.
//
// Here, nothing on the main thread can delay anything. The worklet writes into
// shared memory; this worker reads it; the bytes leave over a MessagePort that
// main handed us directly. The renderer's main thread can stall for as long as
// it likes and the audio still leaves on time.

import { RingReader, type RingLayout } from './ring'

/** Bounded so one posted chunk always stays under main's 64 KB frame cap,
 *  even when a scheduling gap left a large backlog to clear. */
const MAX_FRAMES_PER_POST = 8192

export interface PumpInit {
  type: 'init'
  buffer: SharedArrayBuffer
  layout: RingLayout
  /** How often to drain, in ms. */
  drainMs: number
  /** False = emit channel 0 only (mic). The ring itself is always 2-channel,
   *  so this can be flipped mid-call without reinterpreting a single byte
   *  already written — the two sides cannot desync into garbage, only into a
   *  few ms of the wrong choice. */
  stereo: boolean
}

export type PumpMessage =
  | PumpInit
  | { type: 'stereo'; stereo: boolean }
  | { type: 'paused'; paused: boolean }
  | { type: 'stop' }

/** Sent back to the renderer. `ready` is the handshake the fallback waits on. */
export type PumpEvent =
  { type: 'ready' } | { type: 'dropped'; frames: number } | { type: 'error'; message: string }

let reader: RingReader | null = null
let port: MessagePort | null = null
let timer: ReturnType<typeof setInterval> | null = null
let stereo = true
let channels = 2
let paused = false

function post(event: PumpEvent): void {
  self.postMessage(event)
}

/** Interleaved stereo frames → the mono mic channel. Allocates one buffer per
 *  drain rather than per frame; this is the only copy in the path. */
function monoFromStereo(samples: Int16Array, frames: number): Int16Array {
  const out = new Int16Array(frames)
  for (let f = 0; f < frames; f++) out[f] = samples[f * channels]
  return out
}

function drain(): void {
  const r = reader
  const p = port
  if (!r || !p) return

  // Loop rather than draining once: after a scheduling gap the backlog can be
  // larger than one post is allowed to carry, and leaving the remainder for
  // the next tick would turn a one-off gap into a permanent lag floor.
  for (;;) {
    const { samples, frames, dropped } = r.read(MAX_FRAMES_PER_POST)
    // While paused the ring is still drained, just not forwarded. Letting it
    // fill instead would mean resuming into a backlog of audio from before the
    // pause — exactly the stale-audio lag this subsystem exists to prevent.
    if (paused) {
      if (frames < MAX_FRAMES_PER_POST) return
      continue
    }
    if (dropped > 0) post({ type: 'dropped', frames: dropped })
    if (frames <= 0) return
    const payload = stereo ? samples : monoFromStereo(samples, frames)
    // Transferred, not copied — the worker has no further use for it.
    p.postMessage(payload.buffer, [payload.buffer])
    if (frames < MAX_FRAMES_PER_POST) return
  }
}

function stop(): void {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
  reader = null
  try {
    port?.close()
  } catch {
    /* already gone */
  }
  port = null
}

self.onmessage = (event: MessageEvent<PumpMessage>): void => {
  const data = event.data
  if (!data) return

  if (data.type === 'init') {
    // The port arrives alongside the init message; main created it, so this is
    // a direct line to the process that owns the Deepgram socket.
    port = event.ports[0] ?? null
    if (!port) {
      post({ type: 'error', message: 'no port' })
      return
    }
    try {
      reader = new RingReader(data.buffer, data.layout)
    } catch (err) {
      post({ type: 'error', message: err instanceof Error ? err.message : 'bad ring' })
      return
    }
    channels = data.layout.channels
    stereo = data.stereo
    // A timer rather than Atomics.wait: the ring already absorbs jitter, so
    // the extra precision would buy a few ms against real added complexity in
    // the audio thread (every render quantum would have to notify).
    timer = setInterval(drain, data.drainMs)
    post({ type: 'ready' })
    return
  }

  if (data.type === 'stereo') {
    stereo = data.stereo
    return
  }

  if (data.type === 'paused') {
    paused = data.paused
    return
  }

  if (data.type === 'stop') {
    drain() // whatever is still in the ring belongs to the call
    stop()
  }
}
