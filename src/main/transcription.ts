import {
  app,
  ipcMain,
  BrowserWindow,
  MessageChannelMain,
  powerMonitor,
  systemPreferences,
  shell
} from 'electron'
import { appendFileSync } from 'fs'
import { join } from 'path'
import WebSocket from 'ws'
import { keyRejectedHint } from './ai-keys'
import { SessionTimeline, SleepDetector, formatGapMarker } from './session-health/timeline'
import { LagTracker } from './session-health/lag'
import { AudioQueue, frameRms, frameSeconds } from './session-health/queue'
import { channelRms } from './session-health/channel-test'
import { LivenessWatchdog, silenceFrame } from './session-health/liveness'
import { DriftMeter } from './session-health/drift'
import { HEALTH_TUNING, type GapReason, type HealthSnapshot } from './session-health/types'
import { BuyerSilenceWatcher } from './windows-capture/buyer-silence'
import { CrossTalkGate } from './session-health/crosstalk-gate'
import {
  beginCall,
  currentTranscript,
  endCall,
  liveCallInfo,
  recordGap,
  recordResult,
  setTranscriptListener
} from './live/live-transcript'
import { recordInterim } from './live/live-interim'
import type { AttachSnapshot } from './live/transcript-patch'

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
// Ping Deepgram every 5s so a PAUSED session (no audio being forwarded) isn't
// closed by the server's idle timeout.
//
// This is NOT a silence cutoff, despite being the only 5-second constant in the
// audio path. M21 Phase D investigated the standing "the app cancels a session
// after ~5s of silence" report and found NO such code exists anywhere: no VAD
// gate, no RMS/amplitude threshold, no inactivity timer, nothing that stops
// capture on quiet. The worklet forwards silence as ordinary PCM, and this
// KeepAlive can only ever EXTEND a session's life. A long pause in a call does
// not drop the session.
//
// The likeliest cause of the reported symptom is that nothing visibly changes
// during silence — Deepgram sends no results, so the transcript stops growing
// and the UI merely looks dead. The one genuine automatic teardown with
// comparable timing is the reconnect cascade below (see MAX_RECONNECTS): three
// failures at 500/1000/2000ms backoff inside the STABLE_AFTER_MS window ends a
// session roughly 4-6s after the first drop, which is easy to misread as a
// silence timeout. It surfaces as "Lost connection to the transcription
// service", not as a silent stop.
const KEEPALIVE_MS = 5000
const MAX_RECONNECTS = 3
/** How often the queue is pushed toward the socket. */
const DRAIN_MS = 25

interface StartOptions {
  sampleRate: number
  /** When true, stream 2 interleaved channels (0=rep, 1=buyer) via Deepgram
   *  multichannel. Defaults to false (mono + diarize) for mic-only calls. */
  multichannel?: boolean
  /** When set, the start only proceeds if the CURRENT session has this id �
   *  so a stale in-flight restart (from an already-stopped call) can never
   *  tear down a newer call's session. Omitted for a brand-new call. */
  expectedSessionId?: number
  /** Identifies the CAPTURE PIPELINE (one renderer-side Recorder) that will
   *  feed this session. Audio from any OTHER producer in the same window is
   *  refused.
   *
   *  The window alone was never sufficient authority. A Recorder that outlives
   *  its call — an abandoned AudioContext whose worklet is still posting PCM
   *  into sendAudio — lives in the same window and was therefore just as
   *  authorised as the live one. Two producers each pushing at 1x realtime,
   *  against Deepgram's ~1.25x ingest cap, is a ~0.75s-per-second lag ratchet
   *  that nothing recovers from and only a process restart clears. That is the
   *  "first call perfect, every call after it unusable" bug.
   *
   *  Optional: when absent no producer check applies, so existing callers and
   *  tests that never mint an id keep working exactly as before. */
  producerId?: number
}

// Everything about one live session lives here, so restarts/reconnects can't
// cross-contaminate (stale timers, stale counters, stale sockets).
interface Session {
  /** Monotonically increasing id � lets restarts prove they target the
   *  session they think they do (see StartOptions.expectedSessionId). */
  id: number
  window: BrowserWindow
  apiKey: string
  sampleRate: number
  /** 1 for mono (mic only) or 2 for multichannel (rep + buyer). */
  channels: number
  /** True when streaming 2 channels with per-channel labels (no diarize). */
  multichannel: boolean
  /** Identifies the SPEAKER-LABEL NAMESPACE these results belong to.
   *
   *  Deepgram restarts diarization from scratch on every new connection, so
   *  "speaker 0" after a reconnect is whoever happens to talk first there — not
   *  the same person as before. The mono(diarize)↔multichannel(channel) swap
   *  changes the meaning of the numbers too. Nothing downstream can tell those
   *  apart from a genuine speaker change, so every result carries the epoch it
   *  was labelled under and consumers refuse to merge or attribute across one. */
  speakerEpoch: number
  /** The one capture pipeline allowed to feed this session (see
   *  StartOptions.producerId). null = no producer check (legacy callers). */
  producerId: number | null
  /** Frames refused because they came from a DIFFERENT producer than
   *  `producerId` above — see HealthSnapshot.rejectedProducerFrames. */
  rejectedProducerFrames: number
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
  /** The last state emitted to the renderer.
   *
   *  M26 4.3 — recorded because a renderer that mounts mid-call has to be told
   *  what state the call is IN, and every emit site previously computed this
   *  value and immediately forgot it. Without it `transcription:attach` could
   *  say a call exists but not that it is currently reconnecting. */
  lastState: TranscriptionState

  reconnectAttempts: number
  stopping: boolean
  /** M22 — set once this session has told the renderer to drop buyer
   *  capture because it kept needing lag corrections faster than they could
   *  recover (see healthTick's 'reset' branch). Guards against re-emitting
   *  the fallback event on every subsequent tick while the renderer's own
   *  `transcription:start({multichannel:false})` restart is still in flight. */
  multichannelFallbackSignaled: boolean
  /** M26 4.4 — repeat-fault tracking for reportFault(). A count and a window
   *  start, not a bare boolean: today an uncaught throw in healthTick is
   *  silently swallowed by the process-wide uncaughtException handler and
   *  the NEXT tick proceeds normally (verified empirically — the fourth tick
   *  after three straight throws succeeds). Ending the session on the first
   *  transient fault, now that main owns the transcript, would be stricter
   *  than today's behaviour for no real benefit; ending it only once faults
   *  are clearly RECURRING is the actual regression-worthy case. */
  faultCount: number
  firstFaultAt: number | null
}

let session: Session | null = null
/** The window that most recently owned a live session. Kept so a transcript
 *  patch produced in the gap where `session` is null still reaches the renderer
 *  that is displaying that call. */
let lastLiveWindow: BrowserWindow | null = null
let nextSessionId = 1
// Monotonic across the whole app run, so an epoch value is never reused and a
// late/stale result can't be mistaken for the current namespace.
let nextSpeakerEpoch = 1

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
  logSessionSummary(s)
  teardown(s)
  // M26 4.4 — main gaining its OWN end-of-call trigger. Never a real saveCall
  // (main has no "the rep confirmed this call is done" signal, and no
  // consent decision it's entitled to make on the rep's behalf) — just close
  // the journal unsaved, exactly the outcome the founder's own conservative-
  // recovery bar from 4.2 describes: the rep is asked next launch, not
  // guessed for.
  endLiveCallUnsaved()
  emit(s, 'transcription:error', { message })
  emitState(s, 'error')
  session = null
}

/** Close the journal for whatever call is in progress, WITHOUT saving it —
 *  main's only lever when it decides on its own that a call is over
 *  (failSession, a crashed renderer). See live-transcript.ts's endCall for
 *  why this is deliberately never followed by a real saveCall. */
function endLiveCallUnsaved(): void {
  endCall({ saved: false })
}

// --- Session robustness (M26 4.4) -------------------------------------------
//
// Four hot paths had zero try/catch: the 1Hz health tick, audio ingest, the
// socket message handler (only its JSON.parse was ever guarded), and drain —
// the last one closed slightly later than the other three, on the reasoning
// that a documented gap in a mechanism whose whole purpose is not having gaps
// is just a gap with a note attached. Before 4.1 this was survivable — main
// held no transcript, so a throw here cost nothing durable. Once main OWNS
// the transcript, the same throw is a total-loss event: the process-wide
// uncaughtException handler only logs (and suppresses Electron's own crash
// dialog), a throwing setInterval keeps firing every tick regardless, and the
// session slot is never cleared, so it sits there wedged, doing nothing,
// forever.
export const FAULT_WINDOW_MS = 5000
export const FAULT_THRESHOLD = 3

/**
 * Pure counting logic, exported so it can be tested directly rather than only
 * through a live Deepgram connection (there is no clean way to force one of
 * healthTick/ingestAudio/the message handler to throw from outside this
 * module without one).
 *
 * Mutates `state` in place and returns whether the threshold was just
 * crossed. RECURRING within a short window, not on the first fault — today an
 * uncaught throw in healthTick is already silently swallowed by the
 * process-wide uncaughtException handler and the NEXT tick proceeds normally
 * (verified empirically). Ending the session on the first transient fault,
 * now that main owns the transcript, would be stricter than today's
 * (accidental) tolerance for no real benefit.
 */
export function faultThresholdCrossed(
  state: { faultCount: number; firstFaultAt: number | null },
  now: number
): boolean {
  if (state.firstFaultAt === null || now - state.firstFaultAt > FAULT_WINDOW_MS) {
    state.firstFaultAt = now
    state.faultCount = 1
  } else {
    state.faultCount++
  }
  return state.faultCount >= FAULT_THRESHOLD
}

function reportFault(s: Session, site: string, err: unknown): void {
  console.error(`[transcription:${site}] session=${s.id}`, err)
  if (faultThresholdCrossed(s, Date.now())) {
    failSession(s, 'A recurring internal error interrupted this call. Please start a new one.')
  }
}

// --- State ------------------------------------------------------------------

export type TranscriptionState = 'connecting' | 'listening' | 'reconnecting' | 'error' | 'idle'

/** Emit a state change AND remember it, so `transcription:attach` can answer
 *  "what is this call doing right now" for a renderer that just mounted. Every
 *  state emit goes through here — a raw emit would leave lastState lying. */
function emitState(s: Session, state: TranscriptionState, extra?: Record<string, unknown>): void {
  s.lastState = state
  emit(s, 'transcription:state', { state, ...extra })
}

/**
 * The session backing a call that is genuinely still in progress, or null.
 *
 * `session !== null` is NOT the same thing, and the difference is exactly the
 * case attach exists for: the stop path sets `stopping` and emits state 'idle'
 * but deliberately keeps the socket alive for STOP_FLUSH_MS so the last words
 * still arrive. A renderer attaching in that window must be told there is no
 * call — otherwise it shows an in-call screen for a call that has ended.
 */
function liveSession(): Session | null {
  return session && !session.stopping ? session : null
}

// --- Gaps -------------------------------------------------------------------

/** Record audio that will never be transcribed, and tell the renderer so it
 *  can show `[gap: Ns]` instead of silently splicing two distant moments. */
function markGap(s: Session, durationMs: number, reason: GapReason): void {
  const gap = s.timeline.markGap(durationMs, reason)
  if (!gap) return
  // Same marker text the renderer will render, into main's own copy (4.2), so
  // a recovered transcript shows the same honest hole rather than splicing two
  // distant moments together seamlessly.
  recordGap(formatGapMarker(gap.durationMs))
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
// M26 4.4b — the fourth entry point, closed alongside the other three rather
// than left as a documented gap. Wrapping drainBody itself (rather than each
// of its four call sites individually — ws.on('open'), the audio-ingest
// path, the drain timer, and transcription:stop's final flush) protects all
// of them uniformly with one guard, including the timer and ws.on('open')
// sites that had no guard of any kind before this.
function drain(s: Session): void {
  try {
    drainBody(s)
  } catch (err) {
    reportFault(s, 'drain', err)
  }
}

function drainBody(s: Session): void {
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
  emitState(s, 'reconnecting', { attempt: s.reconnectAttempts })
  connect(s)
}

/**
 * A one-line, human-readable summary appended on every call end, to a plain
 * text file in the app's own data folder (`session-health.log`, next to
 * `app-settings.json`). Not a general logging system — one line per session,
 * cheap and synchronous.
 *
 * WHY THIS EXISTS: diagnosing a live-call performance report normally means
 * "open DevTools and read the console", which does not work on a machine
 * that has never had it enabled (a real support case, 2026-08-06) and is not
 * something to ask a non-technical tester to do reliably anyway. This file
 * is something anyone can open in Notepad and paste into a message, with the
 * exact numbers ANY diagnosis of "still slow" needs first: was a rejected-
 * producer ever non-zero (an orphaned-recorder ghost, see StartOptions.
 * producerId), and did drift/lag ever leave the healthy range. Never throws —
 * a logging failure must never affect a live call.
 */
function logSessionSummary(s: Session): void {
  try {
    const snap = snapshot(s)
    const line =
      `${new Date().toISOString()} session=${s.id} producerId=${s.producerId ?? 'none'} ` +
      `multichannel=${s.multichannel} submittedSec=${snap.submittedSec} ` +
      `acknowledgedSec=${snap.acknowledgedSec} maxLagSec=${snap.lagSec} ` +
      `medianLagSec=${snap.medianLagSec} resets=${snap.resets} driftPpm=${snap.driftPpm} ` +
      `rejectedProducerFrames=${snap.rejectedProducerFrames}\n`
    appendFileSync(join(app.getPath('userData'), 'session-health.log'), line, 'utf8')
  } catch {
    /* logging must never break a real call */
  }
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
    gaps: s.timeline.gapMarkers(),
    driftPpm: s.drift.read().ppm,
    rejectedProducerFrames: s.rejectedProducerFrames
  }
}

/** One second of health: sleep, lag, liveness — in that order of authority. */
function healthTick(s: Session): void {
  if (session !== s) return
  try {
    healthTickBody(s)
  } catch (err) {
    reportFault(s, 'healthTick', err)
  }
}

function healthTickBody(s: Session): void {
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
    // M22 — a reset-worthy tick on a multichannel session that has ALREADY
    // needed `maxResetsPerWindow` resets in the trailing `resetWindowMs` is
    // not a one-off blip; it's the shape of a SUSTAINED deficit (Deepgram's
    // own multichannel processing cost is the leading suspect, confirmed as
    // real in M22's investigation). Reconnecting again just buys another few
    // seconds before the same tick fires again. Tell the renderer to drop
    // buyer capture and continue mic-only instead — it owns the loopback
    // teardown, this session doesn't. Signaled once per session so the
    // renderer's own restart (which replaces this session outright) isn't
    // raced by repeat signals on the next 1s tick.
    if (
      s.multichannel &&
      !s.multichannelFallbackSignaled &&
      s.lag.resetsInWindow(at) >= HEALTH_TUNING.maxResetsPerWindow
    ) {
      s.multichannelFallbackSignaled = true
      emit(s, 'transcription:multichannelFallback', {})
    }
    s.lag.noteReset(at)
    console.warn(
      `[transcription] lag reset: median=${verdict.medianLagSec.toFixed(1)}s rising=${verdict.rising}`
    )
    resetToLiveEdge(s, 'reconnect')
    return
  }
  if (verdict.action === 'shed') {
    // Ongoing high lag with no disconnect — trim the LOCAL queue back toward
    // the live edge the same way the queue always sheds on overflow: silence
    // first. `trimToReplayCap()` is deliberately NOT used here — it exists
    // for the post-disconnect backlog case (its own doc comment says so) and
    // chops blindly from the head regardless of whether the frame is silence
    // or real speech. Reusing it for ordinary ongoing lag discarded real,
    // never-yet-sent words on every tick lag stayed elevated, which is what
    // was producing garbled, discontinuous transcripts under exactly the
    // network conditions this tier exists to recover gracefully from.
    const dropped = s.queue.shedToward(HEALTH_TUNING.replayCapSec)
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
    // Deepgram restarts DIARIZATION per connection, so the speaker labels
    // that follow belong to a brand-new namespace. Bumping the epoch here
    // (not only on transcription:start) is what makes a mid-call reconnect
    // safe: without it, post-reconnect "speaker 0" merges straight into a
    // pre-reconnect run for a different person.
    s.speakerEpoch = nextSpeakerEpoch++

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

    emitState(s, 'listening')
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
    // A second, separate try/catch from JSON.parse's own above — a parse
    // failure (malformed JSON) and a processing failure (this session's own
    // code choking on a well-formed message) are different faults, and only
    // the second should count toward the repeat-fault threshold.
    try {
      if (msg.type === 'Results') {
        const alt = (
          msg.channel as
            | {
                alternatives?: Array<{
                  transcript?: string
                  words?: Array<{
                    speaker?: number
                    word?: string
                    punctuated_word?: string
                    confidence?: number
                  }>
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
        const rawWords = alt?.words ?? []
        const deterministic = s.multichannel && (channel === 0 || channel === 1)
        // In multichannel the speaker IS the channel, so attribution is
        // deterministic and always certain. Under diarization it's a guess, and
        // Deepgram sometimes omits `speaker` entirely — that used to fall through
        // to 0, making "no idea who said this" indistinguishable from "definitely
        // the rep". Track it instead of hiding it.
        let speakerCertain = true
        // The channel is ALSO stamped alongside the speaker (independent of the
        // certainty tracking above): `speaker` alone is ambiguous — in mono it
        // is a diarized guess, in multichannel it is the channel index. Without
        // it, "speaker 0" means two different people either side of a mid-call
        // switch to buyer capture, and the saved transcript cannot say which.
        // Identity is the (channel, speaker) PAIR.
        const words = rawWords.map((w) => {
          if (!deterministic && typeof w.speaker !== 'number') speakerCertain = false
          return {
            speaker: deterministic ? channel : typeof w.speaker === 'number' ? w.speaker : 0,
            ...(deterministic ? { channel } : {}),
            text: w.punctuated_word ?? w.word ?? ''
          }
        })
        // Lowest per-word confidence in this result — a single badly-heard word is
        // enough to make the whole turn's attribution suspect.
        const confidences = rawWords
          .map((w) => w.confidence)
          .filter((c): c is number => typeof c === 'number' && Number.isFinite(c))
        const minConfidence = confidences.length ? Math.min(...confidences) : null
        const start = typeof msg.start === 'number' ? msg.start : 0
        const duration = typeof msg.duration === 'number' ? msg.duration : 0
        // The acknowledgement cursor: how much of what we sent Deepgram has now
        // accounted for. Connection-relative, rebased onto the session scale.
        s.lag.onAcknowledged(start + duration)

        // M19 Task 2 Part A — the loudspeaker/echo problem. Deepgram's start/
        // duration are relative to THIS connection's own audio clock; rebase
        // onto the session's continuous timeline (the same scale crossTalk was
        // fed on) using the offset captured at connection-open, same principle
        // as lag.ts's ackBaseSec rebasing just above. Synthetic silence-fill
        // frames (healthTick's needsSilenceFill) advance Deepgram's clock
        // without ever reaching crossTalk.observe() (they bypass ingestAudio
        // entirely), so — exactly like lag.ts's own acknowledgedSeconds getter
        // — that injected duration must be subtracted back out here too, or
        // every crosstalk window drifts further ahead of real capture time
        // with each fill on this connection.
        const syntheticSec = s.lag.connectionSyntheticSeconds
        if (s.multichannel && (channel === 0 || channel === 1) && msg.is_final === true) {
          const windowStartMs = s.connectionOpenedAtMs + (start - syntheticSec) * 1000
          const windowEndMs = s.connectionOpenedAtMs + (start + duration - syntheticSec) * 1000
          if (s.crossTalk.disagreesWithClaim(channel, windowStartMs, windowEndMs)) {
            emit(s, 'transcription:crossTalkWarning', {})
          }
        }

        // M26 Phase 4.2 — main's own copy, journaled to disk as the call
        // happens. Deliberately BEFORE the emit, and deliberately not awaited or
        // error-checked: every entry point in live-transcript swallows its own
        // failures and returns void, so this cannot affect the renderer's copy
        // whatever the disk does. Ordering it first means a crash in the
        // instant between the two loses nothing.
        recordResult({
          transcript,
          words,
          isFinal: msg.is_final === true,
          speakerEpoch: s.speakerEpoch,
          speakerCertain,
          minConfidence,
          multichannel: s.multichannel
        })

        // M26 Phase 4.5.1 — a second, main-owned record of this SAME result,
        // finals and interims alike, for the cue engine's fast tier
        // (battlecard matching) once it moves into main in 4.5.4. A plain
        // buffer write, same posture as recordResult() just above: cannot
        // throw, cannot block, and — unlike recordResult() — kept even for
        // isFinal:false, because that's exactly what recordResult()
        // deliberately drops and what the cue engine's fast tier needs.
        recordInterim({
          transcript,
          words,
          isFinal: msg.is_final === true,
          speechFinal: msg.speech_final === true,
          speakerEpoch: s.speakerEpoch,
          speakerCertain,
          minConfidence,
          multichannel: s.multichannel
        })

        emit(s, 'transcription:transcript', {
          transcript,
          words,
          isFinal: msg.is_final === true,
          speechFinal: msg.speech_final === true,
          // The real (session-health) lag figure — a two-cursor measurement
          // proven against Deepgram's 1.25x ingest cap, not the simple
          // "seconds sent minus seconds acknowledged" estimate this superseded.
          lagMs: Math.round(s.lag.instantLagSec * 1000),
          speakerEpoch: s.speakerEpoch,
          speakerCertain,
          minConfidence,
          // Multichannel labels are the CHANNEL, so speaker 0 is the rep by
          // construction; diarization labels are a guess with no fixed meaning.
          // Consumers need to tell those apart to know what a label is worth.
          multichannel: s.multichannel
        })
      } else if (msg.type === 'UtteranceEnd') {
        emit(s, 'transcription:utteranceEnd', {})
      }
    } catch (err) {
      reportFault(s, 'wsMessage', err)
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
      emitState(s, 'reconnecting', { attempt: s.reconnectAttempts })
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
  try {
    ingestAudioBody(s, chunk)
  } catch (err) {
    reportFault(s, 'ingestAudio', err)
  }
}

function ingestAudioBody(s: Session, chunk: unknown): void {
  const bytes = toBytes(chunk)
  if (!bytes || bytes.byteLength <= 0 || bytes.byteLength > MAX_CHUNK_BYTES) return

  const at = s.timeline.elapsedMs()
  const rms = frameRms(bytes)
  s.liveness.onAudio(at, rms)

  if (s.multichannel) {
    // Computed once and shared — buyerSilence and crossTalk both need
    // per-channel RMS for this exact frame, and each recomputing it from the
    // raw bytes independently is pure redundant CPU on the main process's
    // single thread, on every multichannel frame for the whole call.
    const [micRms = 0, buyerRms = 0] = channelRms(bytes, 2)
    const verdict = s.buyerSilence.observeRms(at, micRms, buyerRms)
    if (verdict.shouldWarn) emit(s, 'transcription:buyerSilent', { reason: verdict.reason })
    s.crossTalk.observeRms(at, micRms, buyerRms)
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

/**
 * M26 4.4 — Electron's `render-process-gone`: the renderer crashed, was
 * OOM-killed, or its GPU process died. Main keeps running regardless, so this
 * is the only chance to end a session that would otherwise sit there forever
 * — the liveness watchdog injects synthetic silence to satisfy Deepgram's
 * no-audio deadline, which keeps the socket open, and billing, indefinitely,
 * feeding a page that no longer exists.
 *
 * Order matters: `disposeTranscription()` runs FIRST because it is the only
 * thing that strips the socket's own listeners (`removeAllListeners` before
 * `terminate`). Leaving them attached even briefly risks the pre-existing,
 * un-guarded `ws.on('close')` handler firing `emit()` against a webContents
 * whose renderer just died — `emit()` only checks `window.isDestroyed()`,
 * which stays false after a crash unless the window is also explicitly
 * closed, not `webContents.isDestroyed()`.
 *
 * Both calls are safe no-ops when there is nothing to tear down: a crash
 * with no live session, or with a call that already saved, does nothing.
 */
export function handleRenderProcessGone(): void {
  disposeTranscription()
  endLiveCallUnsaved()
}

/** Current session health, for the `--diagnose` report. Null when idle. */
export function transcriptionHealth(): HealthSnapshot | null {
  if (!session) return null
  return snapshot(session)
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

    // A restart that names an expected session must match the CURRENT one �
    // otherwise it's a stale request from an older call and must not clobber
    // the newer session. Return without disposing anything.
    const expected = options?.expectedSessionId
    if (typeof expected === 'number' && session?.id !== expected) {
      return { ok: false, error: 'stale' as const }
    }

    // M26 Phase 4.2 — a CALL is not a SESSION. A mono<->multichannel switch
    // disposes and recreates the session while the rep is still on the same
    // call, and the renderer carries one transcript across it. So the journal
    // must survive that, and only a genuinely new call starts a new one.
    // `expectedSessionId` naming the session we are about to replace is
    // exactly what distinguishes the two, and it is already required for the
    // restart to be honoured at all (see the staleness check above). Getting
    // this backwards would end every buyer-capture call with a spurious
    // "we found an interrupted call" prompt for a call that saved fine.
    const isRestart = typeof expected === 'number' && session?.id === expected
    beginCall({ restart: isRestart })

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
      // Provisional — 'open' assigns the real one. A mono↔multichannel restart
      // lands here, and channel-index labels mean something different from
      // diarization labels, so it must never inherit the old epoch.
      speakerEpoch: nextSpeakerEpoch++,
      producerId: typeof options?.producerId === 'number' ? options.producerId : null,
      rejectedProducerFrames: 0,
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
      lastState: 'connecting',
      reconnectAttempts: 0,
      stopping: false,
      multichannelFallbackSignaled: false,
      faultCount: 0,
      firstFaultAt: null
    }
    session = s
    lastLiveWindow = window
    s.liveness.start(timeline.elapsedMs())
    s.drainTimer = setInterval(() => {
      if (session === s) drain(s)
    }, DRAIN_MS)
    s.healthTimer = setInterval(() => healthTick(s), HEALTH_TUNING.lagSampleMs)
    emitState(s, 'connecting')
    connect(s)
    return { ok: true as const, sessionId: s.id }
  })

  ipcMain.on('transcription:audio', (event, chunk: ArrayBuffer, producerId?: unknown) => {
    const s = session
    if (!s) return
    // Only the window that owns the session may stream audio.
    if (BrowserWindow.fromWebContents(event.sender) !== s.window) return
    // ...and within that window, only the capture pipeline this session was
    // started for. Same authority model as expectedSessionId on start: the
    // window is not enough, because a stopped call's Recorder lives in the
    // same window and — if the renderer ever fails to stop it — keeps posting
    // PCM forever. Two producers at 1x realtime against a ~1.25x ingest cap
    // ratchets lag ~0.75s per second, permanently. Drop the impostor's audio.
    if (s.producerId !== null && producerId !== s.producerId) {
      s.rejectedProducerFrames++
      return
    }
    audioPath = 'renderer'
    ingestAudio(s, chunk)
  })

  // The ring dropped audio because the worker fell behind. Same user-visible
  // meaning as a shed queue — a stretch that will never be transcribed — so it
  // gets the same marker rather than a new vocabulary word.
  ipcMain.on('transcription:audioDropped', (event, frames: unknown, producerId?: unknown) => {
    const s = session
    if (!s) return
    if (BrowserWindow.fromWebContents(event.sender) !== s.window) return
    // Same producer check as the audio path above — an orphaned recorder's
    // drop reports would otherwise punch bogus gap markers into a call it has
    // nothing to do with.
    if (s.producerId !== null && producerId !== s.producerId) {
      s.rejectedProducerFrames++
      return
    }
    if (typeof frames !== 'number' || !Number.isFinite(frames) || frames <= 0) return
    queueShed(s, frames / s.sampleRate, 'shed')
  })

  registerAudioPort()

  // M26 4.3 — push transcript deltas to the window that owns the call.
  //
  // `lastLiveWindow` rather than `session.window` alone: a patch can legitimately
  // be produced while `session` is momentarily null (a rep identification landing
  // just after stop, for instance), and dropping it would leave the renderer's
  // mirror one behind with nothing to tell it so.
  setTranscriptListener((patch) => {
    const w = session?.window ?? lastLiveWindow
    if (!w || w.isDestroyed()) return
    try {
      w.webContents.send('transcription:segments', patch)
    } catch {
      /* the window went away mid-send; the renderer re-attaches on remount */
    }
  })

  /**
   * "Is there a call in progress, and what is it?"
   *
   * The renderer asks this on every mount, because it no longer keeps the
   * transcript itself and cannot know from its own state whether a call is
   * running. A null `session` here is the single affirmative answer that lets
   * the idle screen appear — never a timeout, never a default.
   *
   * `session` and `call` are reported separately because they end at different
   * moments: a mono<->multichannel switch replaces the session mid-call, and
   * the stop path keeps a session object alive for STOP_FLUSH_MS after the call
   * is logically over.
   */
  ipcMain.handle('transcription:attach', (): AttachSnapshot => {
    const s = liveSession()
    const info = liveCallInfo()
    return {
      session: s
        ? {
            id: s.id,
            multichannel: s.multichannel,
            producerId: s.producerId,
            state: s.lastState
          }
        : null,
      call: info ? { ...info, segments: currentTranscript() } : null
    }
  })

  // M26 4.4 — "the view went away", distinct from "the call ended". A pure
  // signal: it does not touch `session`, does not stop the socket, does not
  // close the journal. Nothing in main needs to react differently to a
  // detached view, because everything that used to depend on the renderer
  // being mounted (the transcript, the patch listener, the journal) already
  // moved to main in 4.1-4.3. This exists so the CONCEPT has a name on the
  // wire, matching what replaced the old renderer-side stop()-on-unmount
  // call — see LiveView.tsx's own unmount effect, the only caller.
  ipcMain.handle('transcription:detach', () => {
    return { ok: true as const }
  })

  ipcMain.handle('transcription:stop', () => {
    const s = session
    // M26 4.3 — `session: null` is the renderer's ONLY licence to show the idle
    // screen. Returned on every path here (including this one, where there was
    // never a session), because a bare `{ok:true}` carries no information and
    // the renderer used to go idle on it unconditionally.
    if (!s) return { ok: true as const, session: null }
    logSessionSummary(s)
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
    emitState(s, 'idle')
    return { ok: true as const, session: null }
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
