// Session health: the tuning constants and shared types for the lag / drift /
// liveness model. Kept in one place (like detection/types.ts) so the thresholds
// are readable as a group rather than scattered as magic numbers.
//
// The model exists because every serious bug in the transcription pipeline
// presents as healthy: socket OPEN, stream active, callbacks firing — and
// nothing works. These numbers are what turn "healthy" into a measurement.

/** What the lag watchdog wants done about the current reading. */
export type LagAction = 'none' | 'warn' | 'shed' | 'reset'

/** Why a stretch of audio is missing from the transcript. */
export type GapReason =
  /** Backlog discarded so the stream could resume at the live edge. */
  | 'reconnect'
  /** Queue overflowed and old audio was shed. */
  | 'shed'
  /** The machine slept; everything buffered was thrown away. */
  | 'sleep'

export interface TimelineGap {
  /** Monotonic ms since session start, at the moment the gap was recorded. */
  atMs: number
  /** How much audio was lost. */
  durationMs: number
  reason: GapReason
}

export const HEALTH_TUNING = {
  // --- Two-cursor lag (§1.2) ------------------------------------------------
  /** How often a lag sample is taken. */
  lagSampleMs: 1000,
  /** Samples in the rolling median. Never act on an instantaneous value —
   *  a single late interim result is not a sick pipeline. */
  lagMedianWindow: 5,
  /** Median lag below this is healthy. */
  warnLagSec: 2,
  /** At/above this, start shedding the queue. */
  shedLagSec: 5,
  /** At/above this, tear the socket down and resume at the live edge. */
  resetLagSec: 15,

  // The ratchet guard: lag that only ever climbs never self-heals, because
  // Deepgram ingests at 1.25x realtime and a realtime producer can only claw
  // back 0.25x. Catching the SLOPE catches it before the value is user-visible.
  /** Window over which a monotonic rise is judged. */
  risingWindowMs: 30_000,
  /** Buckets the rising window is split into (each must be >= the last). */
  risingBuckets: 6,
  /** Tolerance so sample noise doesn't break the "non-decreasing" test. */
  risingToleranceSec: 0.1,
  /** Net rise across the window that counts as a genuine ratchet. */
  risingMinRiseSec: 1.5,

  // Resets are themselves disruptive, so they're paced by `resetBackoffMs`
  // (below), not hard-capped — a hard cap used to exist here and turned into
  // the M22 lag-never-recovers bug the moment a connection had a SUSTAINED
  // deficit: once the cap was hit, nothing bounded lag again for the rest of
  // `resetWindowMs`. `resetsInWindow`/`maxResetsPerWindow` still describe the
  // same 10-minute window, repurposed as the signal for "this deficit is
  // sustained, not a one-off" — see healthTick's multichannel fallback.
  /** Resets within this trailing window count as the SAME sustained episode
   *  for `resetsInWindow` — reaching `maxResetsPerWindow` here is what tells
   *  the caller to stop reset-and-hoping and address the actual cause. */
  maxResetsPerWindow: 3,
  resetWindowMs: 10 * 60_000,
  /** Backoff before the Nth reset since the tracker was created (or since
   *  the last long calm stretch let it settle — see lag.ts). The array's
   *  LAST entry becomes the steady-state minimum gap once a session has
   *  reset more times than the array has entries: this is what keeps a
   *  reset-and-hope loop from becoming a reconnect storm, and — critically —
   *  it never refuses outright, so lag is always eventually bounded again. */
  resetBackoffMs: [0, 2_000, 8_000],

  // --- Shed policy (§1.3) ---------------------------------------------------
  /** Queue bound in SECONDS OF AUDIO, not bytes — bytes are a proxy that
   *  changes meaning the moment the channel count or sample rate does. */
  queueCapSec: 10,
  /** Never replay more than this much backlog after a disconnect. Deepgram's
   *  own guidance is to buffer while disconnected; unbounded, that guidance is
   *  what manufactures the lag ratchet. */
  replayCapSec: 3,
  /** Normalized RMS (0..1) below which a frame counts as silence and is
   *  evicted first — this often clears a whole backlog with no lost words. */
  silenceRms: 0.01,

  // --- Liveness (§1.6) ------------------------------------------------------
  /** No audio callback for this long = capture is dead, reacquire. */
  noAudioMs: 10_000,
  /** Callbacks arriving but carrying pure digital silence for this long is
   *  suspicious rather than fatal — log and surface, don't tear down. */
  silentAudioMs: 10_000,
  /** No message at all from Deepgram while actively sending = dead socket.
   *  readyState === OPEN is not a liveness check; TCP cannot tell that the
   *  machine slept or that the path black-holed. */
  noServerMessageMs: 10_000,
  /** Deepgram closes with 1011/NET-0001 if no audio arrives within ~10s of
   *  socket open. KeepAlive alone does not satisfy that initial deadline, so
   *  we send real (silent) PCM while the mic is muted. Comfortably inside it. */
  silenceFillMs: 3_000,
  /** How much silence each fill actually carries. The requirement is that
   *  audio ARRIVES, not that the gap is filled — so this is a token frame, not
   *  `silenceFillMs` worth of PCM (which at 48kHz stereo would be half a
   *  megabyte every three seconds, achieving nothing). */
  silenceFillFrameMs: 20
} as const

/** A single 1Hz lag reading. */
export interface LagSample {
  /** Monotonic ms since session start. */
  atMs: number
  /** submitted − acknowledged, in seconds of audio. */
  lagSec: number
}

/** Everything the diagnose report wants to know about one session's health. */
export interface HealthSnapshot {
  /** Seconds of audio handed to the socket, cumulative across reconnects. */
  submittedSec: number
  /** Seconds Deepgram has acknowledged, on the same cumulative scale. */
  acknowledgedSec: number
  /** Instantaneous submitted − acknowledged. */
  lagSec: number
  /** Median of the last `lagMedianWindow` samples — what the watchdog acts on. */
  medianLagSec: number
  tier: LagAction
  /** Seconds currently waiting in the send queue. */
  queuedSec: number
  /** Seconds of audio deliberately dropped this session. */
  shedSec: number
  resets: number
  gaps: readonly TimelineGap[]
}
