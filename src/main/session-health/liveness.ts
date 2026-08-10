// Liveness watchdog (§1.6).
//
// The premise: `socket.readyState === WebSocket.OPEN` is not a liveness check.
// TCP has no idea the machine slept, the Wi-Fi dropped without sending a FIN,
// or the capture device stopped producing. Every one of those presents as a
// perfectly healthy socket. So liveness has to be established at the
// APPLICATION level, from things we can actually observe:
//
//   - are audio callbacks still arriving at all?            (dead capture)
//   - is the audio they carry pure digital silence?         (suspicious)
//   - has the server said anything back recently?           (dead socket)
//
// The middle one is deliberately NOT fatal. A quiet meeting and a broken
// capture look identical from inside the process; tearing down a working
// session because nobody spoke for 12 seconds would be far worse than the bug.
// So it is logged and surfaced, never acted on.

import { HEALTH_TUNING } from './types'

export type LivenessState =
  /** Everything observable is behaving. */
  | 'ok'
  /** Audio is flowing but it is all digital silence — log and surface only. */
  | 'silent'
  /** No audio callbacks at all: the capture device is gone. Reacquire. */
  | 'capture-dead'
  /** Audio is flowing but the server has gone quiet: the socket is dead. */
  | 'socket-dead'

export interface LivenessVerdict {
  state: LivenessState
  /** How long the defining condition has held, in ms. */
  forMs: number
}

export class LivenessWatchdog {
  private lastAudioMs = -Infinity
  private lastNonSilentAudioMs = -Infinity
  private lastServerMessageMs = -Infinity
  /** Tracked apart from `lastAudioMs` so a synthetic fill keeps the socket
   *  alive WITHOUT masking genuinely dead capture. */
  private lastSilenceFillMs = -Infinity
  private startedMs = -Infinity
  private sending = false

  /** Session start (or restart). Both clocks begin from here. */
  start(atMs: number): void {
    this.startedMs = atMs
    this.lastAudioMs = atMs
    this.lastNonSilentAudioMs = atMs
    this.lastServerMessageMs = atMs
    this.lastSilenceFillMs = -Infinity
    this.sending = false
  }

  /** An audio frame arrived from the capture pipeline. */
  onAudio(atMs: number, rms: number): void {
    this.lastAudioMs = atMs
    if (rms >= HEALTH_TUNING.silenceRms) this.lastNonSilentAudioMs = atMs
  }

  /** A frame was actually handed to the socket. */
  onSubmitted(atMs: number): void {
    this.sending = true
    // Not a server message — only that we are actively streaming, which is the
    // precondition for treating server silence as a fault.
    void atMs
  }

  /** Any message at all from Deepgram (Results, Metadata, UtteranceEnd, …). */
  onServerMessage(atMs: number): void {
    this.lastServerMessageMs = atMs
    this.sending = true
  }

  /** A new socket is live; the server-silence clock restarts with it. */
  onConnectionOpen(atMs: number): void {
    this.lastServerMessageMs = atMs
    this.startedMs = atMs
  }

  /** Streaming paused (mic muted, session stopping) — server silence is fine. */
  setSending(sending: boolean): void {
    this.sending = sending
  }

  evaluate(atMs: number): LivenessVerdict {
    if (this.startedMs === -Infinity) return { state: 'ok', forMs: 0 }

    const sinceAudio = atMs - this.lastAudioMs
    if (sinceAudio >= HEALTH_TUNING.noAudioMs) {
      return { state: 'capture-dead', forMs: sinceAudio }
    }

    // Only meaningful while we are genuinely streaming: if we deliberately
    // stopped sending, the server owes us nothing.
    const sinceServer = atMs - this.lastServerMessageMs
    if (this.sending && sinceServer >= HEALTH_TUNING.noServerMessageMs) {
      return { state: 'socket-dead', forMs: sinceServer }
    }

    const sinceVoice = atMs - this.lastNonSilentAudioMs
    if (sinceVoice >= HEALTH_TUNING.silentAudioMs) {
      return { state: 'silent', forMs: sinceVoice }
    }

    return { state: 'ok', forMs: 0 }
  }

  /** Whether a silence-fill frame is due, to keep the stream inside
   *  Deepgram's ~10s no-audio deadline while the mic is muted.
   *
   *  Deepgram closes with 1011 / NET-0001 when no audio arrives shortly after
   *  a socket opens. KeepAlive messages do not satisfy that deadline — only
   *  real audio does — so a paused call must still send (silent) PCM. A
   *  zero-length frame is NOT a substitute; it is treated as a stream end. */
  needsSilenceFill(atMs: number): boolean {
    if (this.startedMs === -Infinity) return false
    const lastSent = Math.max(this.lastAudioMs, this.lastSilenceFillMs)
    return atMs - lastSent >= HEALTH_TUNING.silenceFillMs
  }

  /** A silence frame was sent — throttles the next one without touching the
   *  real-audio clock that `capture-dead` depends on. */
  noteSilenceFill(atMs: number): void {
    this.lastSilenceFillMs = atMs
  }
}

/**
 * A frame of digital silence, sized to `ms` of linear16 at the given layout.
 * Always at least one full sample frame — a zero-length send would be read as
 * end-of-stream rather than as silence.
 */
export function silenceFrame(ms: number, channels: number, sampleRate: number): ArrayBuffer {
  const frames = Math.max(1, Math.round((ms / 1000) * sampleRate))
  return new ArrayBuffer(frames * channels * 2)
}
