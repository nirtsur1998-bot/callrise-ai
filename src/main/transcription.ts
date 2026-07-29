import {
  ipcMain,
  BrowserWindow,
  MessageChannelMain,
  powerMonitor,
  systemPreferences,
  shell
} from 'electron'
import WebSocket from 'ws'
import { keyRejectedHint } from './ai-keys'
import { SessionTimeline, SleepDetector, formatGapMarker } from './session-health/timeline'
import { LagTracker } from './session-health/lag'
import { AudioQueue, frameRms, frameSeconds } from './session-health/queue'
import { LivenessWatchdog, silenceFrame } from './session-health/liveness'
import { DriftMeter } from './session-health/drift'
import { HEALTH_TUNING, type GapReason, type HealthSnapshot } from './session-health/types'
import { BuyerSilenceWatcher } from './windows-capture/buyer-silence'
import { CrossTalkGate } from './session-health/crosstalk-gate'

const DEEPGRAM_LISTEN_URL = 'wss://api.deepgram.com/v1/listen'

/** Where the streaming socket connects. Overridable so a self-hosted Deepgram
 *  deployment (which lives on a different host) works without a code change —
 *  and so the regression suite can point the real pipeline at a local mock
 *  that enforces Deepgram's 1.25x ingest cap. Read per connection, never
 *  cached, so it can't go stale across a restart. */
function listenUrlBase(): string {
  return process.env.DEEPGRAM_LISTEN_URL?.trim() || DEEPGRAM_LISTEN_URL
}
const MAX_CHUNK_BYTES = 1 << 16 // 64 KB safety cap on a single audio frame
const CONNECT_TIMEOUT_MS = 8000 // give up if we never reach 'open'
const STABLE_AFTER_MS = 4000 // connection considered healthy after this long
const STOP_FLUSH_MS = 1500 // wait this long for final words on stop
const KEEPALIVE_MS = 5000
const MAX_RECONNECTS = 3
/** How often the queue is pushed toward the socket. */
const DRAIN_MS = 25

interface StartOptions {
  sampleRate: number
  /** When true, stream 2 interleaved channels (0=rep, 1=buyer) via Deepgram
   *  multichannel. Defaults to false (mono + diarize) for mic-only calls. */
  multichannel?: boolean
  /** When set, the start only proceeds if the CURRENT session has this id —
   *  so a stale in-flight restart (from an already-stopped call) can never
   *  tear down a newer call's session. Omitted for a brand-new call. */
  expectedSessionId?: number
}

// Everything about one live session lives here, so restarts/reconnects can't
// cross-contaminate (stale timers, stale counters, stale sockets).
interface Session {
  /** Monotonically increasing id — lets restarts prove they target the
   *  session they think they do (see StartOptions.expectedSessionId). */
  id: number
  window: BrowserWindow
  apiKey: string
  sampleRate: number
  /** 1 for mono (mic only) or 2 for multichannel (rep + buyer). */
  channels: number
  /** True when streaming 2 channels with per-channel labels (no diarize). */
  multichannel: boolean
  ws: WebSocket | null
  keepAlive: ReturnType<typeof setInterval> | null
  connectTimer: ReturnType<typeof setTimeout> | null
  stableTimer: ReturnType<typeof setTimeout> | null
  drainTimer: ReturnType<typeof setInterval> | null
  healthTimer: ReturnType<typeof setInterval> | null

  // --- Session health (M18 §1) ----------------------------------------------
  timeline: SessionTimeline
  lag: LagTracker
  queue: AudioQueue
  liveness: LivenessWatchdog
  drift: DriftMeter
  sleep: SleepDetector
  /** Zero-native-code mitigation for the Windows endpoint bug (§7, different
   *  angle) — flags "mic live, buyer bit-silent" while the real per-process
   *  addon is blocked. Only meaningful when `multichannel` is true. */
  buyerSilence: BuyerSilenceWatcher
  /** M19 Task 2 Part A — the loudspeaker/echo problem: real per-channel
   *  energy history, checked against Deepgram's claimed channel per Results
   *  message. Only meaningful when `multichannel` is true. */
  crossTalk: CrossTalkGate
  /** The session-timeline capture time (session.timeline.elapsedMs() scale)
   *  that corresponds to Deepgram's start=0 on the CURRENT connection —
   *  Deepgram's start/duration are relative to ITS OWN per-connection audio
   *  clock (like lag.ts's ackBaseSec rebasing), so crossTalk (which is fed
   *  on the session's continuous timeline) needs this offset to translate
   *  one into the other. NOT simply "when the socket opened": a reconnect
   *  can replay up to replayCapSec of already-queued backlog first, so
   *  start=0 actually corresponds to that backlog's own capture time — see
   *  the assignment site in connect()'s 'open' handler. */
  connectionOpenedAtMs: number
  /** Shed audio waiting to be reported as ONE gap marker, rather than one
   *  marker per 40ms frame. Flushed the moment audio flows again. */
  pendingShedMs: number
  pendingShedReason: GapReason
  /** True once a socket has opened, so we can tell a reconnect from a start. */
  connectedOnce: boolean

  reconnectAttempts: number
  stopping: boolean
}

let session: Session | null = null
let nextSessionId = 1

/**
 * Which route the last audio frame actually took (§1.4).
 *
 * Recorded rather than assumed. The fast path degrades silently by design —
 * no shared memory, no port, no worker and the recorder quietly uses the old
 * route — which is right for the user and useless for debugging unless the
 * machine can be asked afterwards which one it ended up on.
 */
let audioPath: 'none' | 'renderer' | 'direct' = 'none'

function emit(s: Session, channel: string, payload: unknown): void {
  if (!s.window.isDestroyed()) {
    s.window.webContents.send(channel, payload)
  }
}

function buildUrl(s: Session): string {
  const params = new URLSearchParams({
    model: 'nova-3',
    language: 'en-US',
    encoding: 'linear16',
    sample_rate: String(s.sampleRate),
    channels: String(s.channels),
    interim_results: 'true', // word-by-word partial results
    smart_format: 'true',
    punctuate: 'true',
    utterance_end_ms: '1000',
    vad_events: 'true'
  })
  // Multichannel labels speakers by channel (0=rep, 1=buyer); for mic-only we
  // fall back to diarization to guess speakers within the single channel.
  if (s.multichannel) params.set('multichannel', 'true')
  else params.set('diarize', 'true')
  return `${listenUrlBase()}?${params.toString()}`
}

/** Bytes we let the socket hold before we stop feeding it — one second of
 *  audio. Beyond this the socket is not keeping up, and every further byte
 *  handed over would land in ws's own UNBOUNDED internal queue, which is
 *  exactly the buffer that turns a stalled uplink into permanent lag. */
function highWaterBytes(s: Session): number {
  return s.sampleRate * s.channels * 2
}

function clearTimers(s: Session): void {
  if (s.keepAlive) {
    clearInterval(s.keepAlive)
    s.keepAlive = null
  }
  if (s.connectTimer) {
    clearTimeout(s.connectTimer)
    s.connectTimer = null
  }
  if (s.stableTimer) {
    clearTimeout(s.stableTimer)
    s.stableTimer = null
  }
  if (s.drainTimer) {
    clearInterval(s.drainTimer)
    s.drainTimer = null
  }
  if (s.healthTimer) {
    clearInterval(s.healthTimer)
    s.healthTimer = null
  }
}

function teardown(s: Session): void {
  clearTimers(s)
  if (s.ws) {
    try {
      s.ws.removeAllListeners()
      s.ws.terminate()
    } catch {
      /* ignore */
    }
    s.ws = null
  }
}

function failSession(s: Session, message: string): void {
  if (session !== s) return
  teardown(s)
  emit(s, 'transcription:error', { message })
  emit(s, 'transcription:state', { state: 'error' })
  session = null
}

// --- Gaps -------------------------------------------------------------------

/** Record audio that will never be transcribed, and tell the renderer so it
 *  can show `[gap: Ns]` instead of silently splicing two distant moments. */
function markGap(s: Session, durationMs: number, reason: GapReason): void {
  const gap = s.timeline.markGap(durationMs, reason)
  if (!gap) return
  emit(s, 'transcription:gap', {
    durationMs: gap.durationMs,
    reason: gap.reason,
    marker: formatGapMarker(gap.durationMs)
  })
}

function queueShed(s: Session, seconds: number, reason: GapReason): void {
  if (seconds <= 0) return
  s.pendingShedMs += seconds * 1000
  s.pendingShedReason = reason
}

function flushPendingShed(s: Session): void {
  if (s.pendingShedMs <= 0) return
  const ms = s.pendingShedMs
  const reason = s.pendingShedReason
  s.pendingShedMs = 0
  markGap(s, ms, reason)
}

// --- The send path ----------------------------------------------------------

/**
 * Move queued audio into the socket while the socket can take it.
 *
 * The `bufferedAmount` check is the whole point. Previously every frame went
 * straight to `ws.send()`, which never blocks and never refuses — it just
 * queues internally, without bound. On a half-open TCP socket (a Wi-Fi drop
 * with no FIN, where `readyState` stays OPEN for the entire retransmit window)
 * minutes of audio would pile up invisibly and then flood Deepgram on
 * recovery, where a 1.25x ingest cap turns it into lag that never recovers.
 */
function drain(s: Session): void {
  const ws = s.ws
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  const limit = highWaterBytes(s)
  let sentAny = false
  while (s.queue.length > 0 && ws.bufferedAmount < limit) {
    const frame = s.queue.peek()
    if (!frame) break
    try {
      ws.send(frame.bytes)
    } catch {
      break // leave it queued; the close/health path decides what happens next
    }
    s.queue.shift()
    s.lag.onAudioSubmitted(frame.seconds)
    sentAny = true
  }
  if (sentAny) {
    s.liveness.onSubmitted(s.timeline.elapsedMs())
    // Audio is flowing again, so this is the right moment in the transcript to
    // report whatever was dropped to get here.
    flushPendingShed(s)
  }
}

/**
 * Deliberately discard the backlog and resume at the live edge, then rebuild
 * the socket. This is the escape hatch for a pipeline that is behind and
 * cannot catch up: at a 1.25x ingest cap a realtime producer claws back only
 * 0.25x per second, so 90 seconds of backlog needs six flawless minutes to
 * clear. Throwing it away costs the words we already missed and nothing else.
 */
function resetToLiveEdge(s: Session, reason: GapReason): void {
  const dropped = s.queue.clear()
  queueShed(s, dropped.droppedSec, reason)
  flushPendingShed(s)
  s.lag.resumeAtLiveEdge()
  s.drift.resync()

  if (s.ws) {
    try {
      s.ws.removeAllListeners()
      s.ws.terminate()
    } catch {
      /* ignore */
    }
    s.ws = null
  }
  // Socket-scoped timers only: the drain and health ticks belong to the
  // SESSION and must keep running across the rebuild.
  if (s.keepAlive) {
    clearInterval(s.keepAlive)
    s.keepAlive = null
  }
  if (s.connectTimer) {
    clearTimeout(s.connectTimer)
    s.connectTimer = null
  }
  if (s.stableTimer) {
    clearTimeout(s.stableTimer)
    s.stableTimer = null
  }
  emit(s, 'transcription:state', { state: 'reconnecting', attempt: s.reconnectAttempts })
  connect(s)
}

function snapshot(s: Session): HealthSnapshot {
  const at = s.timeline.elapsedMs()
  const verdict = s.lag.evaluate(at)
  return {
    submittedSec: Math.round(s.lag.submittedSeconds * 100) / 100,
    acknowledgedSec: Math.round(s.lag.acknowledgedSeconds * 100) / 100,
    lagSec: Math.round(s.lag.instantLagSec * 100) / 100,
    medianLagSec: Math.round(verdict.medianLagSec * 100) / 100,
    tier: verdict.action,
    queuedSec: Math.round(s.queue.queuedSeconds * 100) / 100,
    shedSec: Math.round(s.queue.shedSeconds * 100) / 100,
    resets: s.lag.resetCount,
    gaps: s.timeline.gapMarkers()
  }
}

/** One second of health: sleep, lag, liveness — in that order of authority. */
function healthTick(s: Session): void {
  if (session !== s) return
  const at = s.timeline.elapsedMs()

  // A suspend invalidates every other reading, so it is judged first. Twenty
  // minutes asleep is twenty minutes of buffer; at a 1.25x ingest cap that
  // would be eighty minutes of lag if it were ever replayed.
  const sleptMs = s.sleep.tick()
  if (sleptMs > 0) {
    const dropped = s.queue.clear()
    queueShed(s, dropped.droppedSec + sleptMs / 1000, 'sleep')
    s.liveness.start(at)
    resetToLiveEdge(s, 'sleep')
    return
  }

  s.lag.sample(at)
  const verdict = s.lag.evaluate(at)
  if (verdict.action === 'reset') {
    s.lag.noteReset(at)
    console.warn(
      `[transcription] lag reset: median=${verdict.medianLagSec.toFixed(1)}s rising=${verdict.rising}`
    )
    resetToLiveEdge(s, 'reconnect')
    return
  }
  if (verdict.action === 'shed') {
    const dropped = s.queue.trimToReplayCap()
    queueShed(s, dropped.droppedSec, 'shed')
  }

  const live = s.liveness.evaluate(at)
  if (live.state === 'socket-dead') {
    // readyState says OPEN, but nothing has come back for ten seconds while we
    // were actively streaming. The socket is gone; TCP just hasn't noticed.
    console.warn(
      `[transcription] server silent for ${Math.round(live.forMs)}ms — rebuilding socket`
    )
    resetToLiveEdge(s, 'reconnect')
    return
  }
  if (live.state === 'capture-dead') {
    emit(s, 'transcription:captureLost', { forMs: Math.round(live.forMs) })
  }

  // Deepgram closes with 1011/NET-0001 if no audio arrives within ~10s of a
  // socket opening, and KeepAlive does not satisfy that deadline — only audio
  // does. A muted or paused call must therefore keep sending real silence.
  if (s.ws?.readyState === WebSocket.OPEN && s.liveness.needsSilenceFill(at)) {
    const frameMs = HEALTH_TUNING.silenceFillFrameMs
    try {
      s.ws.send(silenceFrame(frameMs, s.channels, s.sampleRate))
      s.liveness.noteSilenceFill(at)
      // Recorded so it can be subtracted back out of the server's audio clock.
      // It is not real audio: counting it as submitted would manufacture lag
      // from a muted mic, and ignoring it entirely would hand the pipeline
      // free acknowledgement credit that hides real lag after a long pause.
      s.lag.onSilenceSubmitted(frameMs / 1000)
    } catch {
      /* the health path will notice a genuinely broken socket */
    }
  }

  emit(s, 'transcription:health', { ...snapshot(s), liveness: live.state })
}

function connect(s: Session): void {
  const ws = new WebSocket(buildUrl(s), {
    headers: { Authorization: `Token ${s.apiKey}` }
  })
  s.ws = ws

  // Watchdog: if we never reach 'open', don't hang in "connecting" forever.
  s.connectTimer = setTimeout(() => {
    if (session === s && ws.readyState !== WebSocket.OPEN) {
      failSession(
        s,
        'Could not reach the transcription service. Check your internet and try again.'
      )
    }
  }, CONNECT_TIMEOUT_MS)

  ws.on('open', () => {
    if (session !== s) {
      ws.close()
      return
    }
    if (s.connectTimer) {
      clearTimeout(s.connectTimer)
      s.connectTimer = null
    }
    const at = s.timeline.elapsedMs()

    // Anything buffered while we were disconnected is judged HERE, in one
    // place, before a single byte goes out. Deepgram's own guidance is to
    // buffer during an outage; followed without a cap that guidance is what
    // manufactures the ratchet, so we keep a short tail and drop the rest.
    if (s.connectedOnce) {
      const dropped = s.queue.trimToReplayCap()
      queueShed(s, dropped.droppedSec, 'reconnect')
    }
    s.connectedOnce = true

    // Deepgram restarts its audio clock per connection; the tracker rebases
    // onto the cumulative scale so lag stays continuous across the reconnect.
    s.lag.onConnectionOpen()
    s.liveness.onConnectionOpen(at)
    // Same rebasing crossTalk needs — see the field's own doc comment. NOT
    // just "now": trimToReplayCap() above can leave up to replayCapSec of
    // already-captured backlog still queued, and THAT is what Deepgram will
    // process as start=0 on this connection, not whatever's captured next.
    // Using "now" here would misdate every crossTalk window on this
    // connection by exactly the replayed backlog's duration. The oldest
    // surviving frame's own capture time is the correct anchor; only fall
    // back to "now" when the queue is genuinely empty (nothing to replay).
    s.connectionOpenedAtMs = s.queue.peek()?.atMs ?? at

    emit(s, 'transcription:state', { state: 'listening' })
    // Only forgive the retry budget once the connection has proven stable.
    s.stableTimer = setTimeout(() => {
      s.reconnectAttempts = 0
    }, STABLE_AFTER_MS)
    s.keepAlive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'KeepAlive' }))
      }
    }, KEEPALIVE_MS)
    drain(s)
  })

  ws.on('message', (raw: WebSocket.RawData) => {
    if (session !== s) return
    s.liveness.onServerMessage(s.timeline.elapsedMs())
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(raw.toString()) as Record<string, unknown>
    } catch {
      return
    }
    if (msg.type === 'Results') {
      const alt = (
        msg.channel as
          | {
              alternatives?: Array<{
                transcript?: string
                words?: Array<{ speaker?: number; word?: string; punctuated_word?: string }>
              }>
            }
          | undefined
      )?.alternatives?.[0]
      const transcript = alt?.transcript ?? ''
      // In multichannel mode the speaker IS the channel: channel_index[0] is 0
      // (rep) or 1 (buyer). Otherwise fall back to per-word diarization.
      const channelIndex = Array.isArray(msg.channel_index)
        ? (msg.channel_index as unknown[])
        : null
      const channel =
        channelIndex && typeof channelIndex[0] === 'number' ? (channelIndex[0] as number) : null
      // The channel is stamped alongside the speaker because `speaker` alone
      // is ambiguous: in mono it is a diarized guess, in multichannel it is
      // the channel index. Without this, "speaker 0" means two different
      // people either side of a mid-call switch to buyer capture, and the
      // saved transcript cannot say which. Identity is the PAIR.
      const words = (alt?.words ?? []).map((w) => ({
        speaker:
          s.multichannel && (channel === 0 || channel === 1)
            ? channel
            : typeof w.speaker === 'number'
              ? w.speaker
              : 0,
        ...(s.multichannel && (channel === 0 || channel === 1) ? { channel } : {}),
        text: w.punctuated_word ?? w.word ?? ''
      }))
      const start = typeof msg.start === 'number' ? msg.start : 0
      const duration = typeof msg.duration === 'number' ? msg.duration : 0
      // The acknowledgement cursor: how much of what we sent Deepgram has now
      // accounted for. Connection-relative, rebased onto the session scale.
      s.lag.onAcknowledged(start + duration)

      // M19 Task 2 Part A — the loudspeaker/echo problem. Deepgram's start/
      // duration are relative to THIS connection's own audio clock; rebase
      // onto the session's continuous timeline (the same scale crossTalk was
      // fed on) using the offset captured at connection-open, same principle
      // as lag.ts's ackBaseSec rebasing just above.
      if (s.multichannel && (channel === 0 || channel === 1) && (msg.is_final === true)) {
        const windowStartMs = s.connectionOpenedAtMs + start * 1000
        const windowEndMs = s.connectionOpenedAtMs + (start + duration) * 1000
        if (s.crossTalk.disagreesWithClaim(channel, windowStartMs, windowEndMs)) {
          emit(s, 'transcription:crossTalkWarning', {})
        }
      }

      emit(s, 'transcription:transcript', {
        transcript,
        words,
        isFinal: msg.is_final === true,
        speechFinal: msg.speech_final === true,
        lagMs: Math.round(s.lag.instantLagSec * 1000)
      })
    } else if (msg.type === 'UtteranceEnd') {
      emit(s, 'transcription:utteranceEnd', {})
    }
  })

  ws.on('unexpected-response', (_req, res) => {
    const message =
      res.statusCode === 401
        ? `Your Deepgram API key was rejected. ${keyRejectedHint('DEEPGRAM_API_KEY')}`
        : `Couldn't connect to Deepgram (HTTP ${res.statusCode ?? 'unknown'}).`
    try {
      res.destroy()
    } catch {
      /* ignore */
    }
    failSession(s, message)
  })

  ws.on('error', (err: Error) => {
    // 'close' (or the watchdog) decides the user-facing outcome; just log here.
    console.error('[transcription] socket error:', err.message)
  })

  ws.on('close', () => {
    if (session !== s) return
    if (s.keepAlive) {
      clearInterval(s.keepAlive)
      s.keepAlive = null
    }
    if (s.stableTimer) {
      clearTimeout(s.stableTimer)
      s.stableTimer = null
    }
    if (s.stopping) {
      // Graceful stop finished flushing — the final words have been sent.
      clearTimers(s)
      session = null
      emit(s, 'transcription:closed', {})
      return
    }
    // Unexpected drop — reconnect with exponential backoff. Audio keeps
    // arriving meanwhile and accumulates in the bounded queue, which sheds
    // rather than growing; the reconnect then keeps only a short tail.
    if (s.reconnectAttempts < MAX_RECONNECTS) {
      s.reconnectAttempts += 1
      emit(s, 'transcription:state', { state: 'reconnecting', attempt: s.reconnectAttempts })
      const delay = 500 * 2 ** (s.reconnectAttempts - 1)
      setTimeout(() => {
        if (session === s && !s.stopping) connect(s)
      }, delay)
    } else {
      failSession(
        s,
        'Lost connection to the transcription service. Check your internet and try again.'
      )
    }
  })
}

/**
 * IPC hands us either an ArrayBuffer or a Node Buffer. Node Buffers from IPC
 * can be views into a shared pool, and because frames are now QUEUED rather
 * than sent immediately, holding such a view would let later traffic overwrite
 * audio we haven't sent yet. So this always produces an independent copy.
 */
/**
 * One audio frame into the session, wherever it came from.
 *
 * Shared by the classic IPC path and the direct worker port (§1.4) so the two
 * can never drift apart — the health accounting below is the thing that
 * detects the lag ratchet, and a second copy of it that quietly skipped the
 * drift resync would leave one of the two paths unmonitored.
 */
function ingestAudio(s: Session, chunk: unknown): void {
  const bytes = toBytes(chunk)
  if (!bytes || bytes.byteLength <= 0 || bytes.byteLength > MAX_CHUNK_BYTES) return

  const at = s.timeline.elapsedMs()
  const rms = frameRms(bytes)
  s.liveness.onAudio(at, rms)

  if (s.multichannel) {
    const verdict = s.buyerSilence.observe({ atMs: at, bytes })
    if (verdict.shouldWarn) emit(s, 'transcription:buyerSilent', { reason: verdict.reason })
    s.crossTalk.observe({ atMs: at, bytes })
  }

  // A discontinuity is a device event or a suspend, not accumulated drift.
  // Resync rather than letting it be absorbed into the clock estimate.
  if (s.drift.onFrame(at, bytes.byteLength)) s.drift.resync()

  const shed = s.queue.push({
    bytes,
    seconds: frameSeconds(bytes.byteLength, s.channels, s.sampleRate),
    rms,
    atMs: at
  })
  queueShed(s, shed.droppedSec, 'shed')
  drain(s)
}

/**
 * Hands each window a private MessagePort straight to this process, so the
 * audio worker can stream without ever touching the renderer's main thread.
 *
 * The port is the security boundary as well as the fast path: it is created
 * here, for one webContents, and audio arriving on it is only accepted while
 * that same window owns the live session. A port from a window that has since
 * been replaced carries no authority at all.
 */
function registerAudioPort(): void {
  const ports = new Map<number, Electron.MessagePortMain>()

  ipcMain.on('audio-port:request', (event) => {
    const wcId = event.sender.id
    // Re-requesting replaces the old port rather than stacking a second one;
    // a call that restarts must not leave a live pipe from the previous take.
    ports.get(wcId)?.close()
    ports.delete(wcId)

    const { port1, port2 } = new MessageChannelMain()
    ports.set(wcId, port1)

    port1.on('message', (msg) => {
      const s = session
      if (!s) return
      if (s.window.isDestroyed()) return
      if (s.window.webContents.id !== wcId) return
      audioPath = 'direct'
      ingestAudio(s, msg.data)
    })
    port1.on('close', () => {
      if (ports.get(wcId) === port1) ports.delete(wcId)
    })
    port1.start()

    event.sender.once('destroyed', () => {
      ports.get(wcId)?.close()
      ports.delete(wcId)
    })
    event.sender.postMessage('audio-port:granted', null, [port2])
  })
}

function toBytes(chunk: unknown): ArrayBuffer | null {
  if (chunk instanceof ArrayBuffer) return chunk
  if (ArrayBuffer.isView(chunk)) {
    const view = chunk as ArrayBufferView
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
  }
  return null
}

export function disposeTranscription(): void {
  if (session) {
    teardown(session)
    session = null
  }
}

/** Current session health, for the `--diagnose` report. Null when idle. */
export function transcriptionHealth(): (HealthSnapshot & { driftPpm: number }) | null {
  if (!session) return null
  return { ...snapshot(session), driftPpm: session.drift.read().ppm }
}

/** Which route audio last took. See `audioPath`. */
export function transcriptionAudioPath(): 'none' | 'renderer' | 'direct' {
  return audioPath
}

let registered = false

export function registerTranscription(): void {
  if (registered) return
  registered = true

  // `powerMonitor` is documented to fire 'resume' twice on macOS and, on some
  // Linux desktop environments, not at all — so it can never be the sleep
  // DETECTOR (SleepDetector's clock-divergence check owns that, and is what
  // actually decides whether a suspend happened). What it is good for is
  // speed: without this, a resume is only noticed on the next 1s health tick.
  // Forcing an immediate tick here shrinks that to the width of the event
  // itself, and firing twice costs nothing — the second call sees `sleptMs`
  // already back near zero and no-ops.
  powerMonitor.on('resume', () => {
    if (session) healthTick(session)
  })

  ipcMain.handle('transcription:start', (event, options: StartOptions) => {
    const key = process.env.DEEPGRAM_API_KEY?.trim() ?? ''
    if (!key) {
      return { ok: false, error: 'no-key' as const }
    }
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) {
      return { ok: false }
    }

    // A restart that names an expected session must match the CURRENT one —
    // otherwise it's a stale request from an older call and must not clobber
    // the newer session. Return without disposing anything.
    const expected = options?.expectedSessionId
    if (typeof expected === 'number' && session?.id !== expected) {
      return { ok: false, error: 'stale' as const }
    }

    // Replace any previous session entirely.
    disposeTranscription()
    const multichannel = options?.multichannel === true
    const sampleRate = Number(options?.sampleRate) > 0 ? Number(options.sampleRate) : 16000
    const channels = multichannel ? 2 : 1
    const timeline = new SessionTimeline()
    const s: Session = {
      id: nextSessionId++,
      window,
      apiKey: key,
      sampleRate,
      channels,
      multichannel,
      ws: null,
      keepAlive: null,
      connectTimer: null,
      stableTimer: null,
      drainTimer: null,
      healthTimer: null,
      timeline,
      lag: new LagTracker(),
      queue: new AudioQueue(),
      liveness: new LivenessWatchdog(),
      drift: new DriftMeter(sampleRate, channels),
      sleep: new SleepDetector(),
      buyerSilence: new BuyerSilenceWatcher(),
      crossTalk: new CrossTalkGate(),
      connectionOpenedAtMs: 0,
      pendingShedMs: 0,
      pendingShedReason: 'shed',
      connectedOnce: false,
      reconnectAttempts: 0,
      stopping: false
    }
    session = s
    s.liveness.start(timeline.elapsedMs())
    s.drainTimer = setInterval(() => {
      if (session === s) drain(s)
    }, DRAIN_MS)
    s.healthTimer = setInterval(() => healthTick(s), HEALTH_TUNING.lagSampleMs)
    emit(s, 'transcription:state', { state: 'connecting' })
    connect(s)
    return { ok: true as const, sessionId: s.id }
  })

  ipcMain.on('transcription:audio', (event, chunk: ArrayBuffer) => {
    const s = session
    if (!s) return
    // Only the window that owns the session may stream audio.
    if (BrowserWindow.fromWebContents(event.sender) !== s.window) return
    audioPath = 'renderer'
    ingestAudio(s, chunk)
  })

  // The ring dropped audio because the worker fell behind. Same user-visible
  // meaning as a shed queue — a stretch that will never be transcribed — so it
  // gets the same marker rather than a new vocabulary word.
  ipcMain.on('transcription:audioDropped', (event, frames: unknown) => {
    const s = session
    if (!s) return
    if (BrowserWindow.fromWebContents(event.sender) !== s.window) return
    if (typeof frames !== 'number' || !Number.isFinite(frames) || frames <= 0) return
    queueShed(s, frames / s.sampleRate, 'shed')
  })

  registerAudioPort()

  ipcMain.handle('transcription:stop', () => {
    const s = session
    if (!s) return { ok: true as const }
    s.stopping = true
    s.liveness.setSending(false)
    if (s.keepAlive) {
      clearInterval(s.keepAlive)
      s.keepAlive = null
    }
    if (s.connectTimer) {
      clearTimeout(s.connectTimer)
      s.connectTimer = null
    }
    if (s.stableTimer) {
      clearTimeout(s.stableTimer)
      s.stableTimer = null
    }
    if (s.healthTimer) {
      clearInterval(s.healthTimer)
      s.healthTimer = null
    }
    const ws = s.ws
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Push whatever is still queued before finalizing, so a stop doesn't
      // silently discard the last second of the call.
      drain(s)
      if (s.drainTimer) {
        clearInterval(s.drainTimer)
        s.drainTimer = null
      }
      try {
        // Finalize flushes pending words; CloseStream closes after the server
        // sends the final Results. We keep the socket open briefly so those
        // last words actually reach the UI.
        ws.send(JSON.stringify({ type: 'Finalize' }))
        ws.send(JSON.stringify({ type: 'CloseStream' }))
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        if (session === s && s.ws && s.ws.readyState === WebSocket.OPEN) {
          try {
            s.ws.close()
          } catch {
            /* ignore */
          }
        }
      }, STOP_FLUSH_MS)
    } else {
      teardown(s)
      session = null
      emit(s, 'transcription:closed', {})
    }
    emit(s, 'transcription:state', { state: 'idle' })
    return { ok: true as const }
  })

  // --- Microphone permission helpers (macOS) --------------------------------
  ipcMain.handle('mic:ensureAccess', async () => {
    if (process.platform !== 'darwin') return { status: 'granted' as const }
    const status = systemPreferences.getMediaAccessStatus('microphone')
    if (status === 'granted') return { status: 'granted' as const }
    if (status === 'not-determined') {
      const granted = await systemPreferences.askForMediaAccess('microphone')
      return { status: granted ? ('granted' as const) : ('denied' as const) }
    }
    return { status }
  })

  ipcMain.handle('mic:openSettings', async () => {
    // Each OS has its own deep-link to the microphone privacy pane.
    const url =
      process.platform === 'darwin'
        ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
        : process.platform === 'win32'
          ? 'ms-settings:privacy-microphone'
          : null
    if (!url) return { ok: false as const, error: 'not applicable on this platform' }
    await shell.openExternal(url)
    return { ok: true as const }
  })
}
