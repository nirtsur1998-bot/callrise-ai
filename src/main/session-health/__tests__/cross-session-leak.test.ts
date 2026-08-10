// Cross-session state leak — the "second call in the same process is broken"
// report, turned into a measurement.
//
// The field report (three separate Windows machines, reproducible):
//   1. Kill the app process, relaunch.
//   2. FIRST live call after relaunch: 150-350ms lag, everything transcribes.
//   3. WITHOUT restarting: SECOND call climbs to 10,000-100,000ms of lag, and
//      SOMETIMES NOTHING TRANSCRIBES AT ALL.
//   4. Kill + relaunch fixes it — for exactly one call.
//
// That shape ("process restart cures it, session restart does not") means state
// SURVIVING A SESSION BOUNDARY inside one process. M22's fix was a different
// bug entirely (a hard cap on lag-tracker resets WITHIN one session).
//
// Every other test in this directory runs exactly ONE session per test file
// invocation — beforeEach/afterEach hand each `it` a fresh mock server and
// dispose the session — so a second-session regression is structurally
// invisible to the whole existing suite. This file is the missing axis: two
// (and three) consecutive sessions in ONE process, streaming identical audio,
// stopped through the real `transcription:stop` IPC handler, with session N
// measured against session 1.
//
// What is measured, per session:
//   - lag (instantaneous + the smoothed median the watchdog acts on)
//   - transcript events actually emitted  <- the "nothing transcribes" mode
//   - submitted vs acknowledged seconds   <- throughput / where audio went
//   - sockets opened, time to 'listening', resets, shed, gaps
//   - loop overhead (wall time vs nominal) <- main-thread starvation probe
//   - Node 'Timeout' handle count          <- timer-leak probe
//
// Reading the result: if session 2 measures the same as session 1, the leak is
// NOT in the layer this harness covers (main-process transcription pipeline +
// socket + queue/lag/liveness) — which rules that layer out and points at the
// renderer / getUserMedia / AudioWorklet / Electron side. That negative is a
// finding, not a failure, and the numbers printed below are the evidence.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockDeepgram } from './mock-deepgram'
import { HEALTH_TUNING } from '../types'

const RATE = 16000
const FRAME_MS = 100
const FRAME_BYTES = (FRAME_MS / 1000) * RATE * 2

// --- Electron stand-in (same shape the rest of this directory uses) ----------
const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: never[]) => unknown>()
  const listeners = new Map<string, (...args: never[]) => void>()
  const sent: Array<{ channel: string; payload: Record<string, unknown> }> = []
  const window = {
    isDestroyed: () => false,
    webContents: {
      id: 1,
      send: (channel: string, payload: Record<string, unknown>) => {
        sent.push({ channel, payload })
      }
    }
  }
  return {
    handlers,
    listeners,
    sent,
    electron: {
      ipcMain: {
        handle: (c: string, fn: (...args: never[]) => unknown) => handlers.set(c, fn),
        on: (c: string, fn: (...args: never[]) => void) => listeners.set(c, fn)
      },
      BrowserWindow: { fromWebContents: () => window },
      systemPreferences: {
        getMediaAccessStatus: () => 'granted',
        askForMediaAccess: async () => true
      },
      shell: { openExternal: async () => undefined },
      powerMonitor: { on: () => undefined },
      MessageChannelMain: class {
        port1 = { on: () => undefined, start: () => undefined, close: () => undefined }
        port2 = {}
      }
    }
  }
})

vi.mock('electron', () => mocks.electron)
vi.mock('../../ai-keys', () => ({ keyRejectedHint: () => '' }))

const { registerTranscription, disposeTranscription, transcriptionHealth } =
  await import('../../transcription')

// --- Audio ------------------------------------------------------------------

/** A steady tone, not DC — frames that behave like speech to the RMS gate. */
function pcm(channels: 1 | 2): ArrayBuffer {
  const frames = (FRAME_MS / 1000) * RATE
  const buffer = new ArrayBuffer(frames * 2 * channels)
  const view = new Int16Array(buffer)
  for (let i = 0; i < frames; i++) {
    view[i * channels] = Math.round(Math.sin(i / 8) * 0.4 * 32767)
    if (channels === 2) view[i * channels + 1] = Math.round(Math.sin(i / 5) * 0.4 * 32767)
  }
  return buffer
}

const MONO = pcm(1)
const STEREO = pcm(2)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (predicate()) return
    await sleep(20)
  }
  throw new Error(`timed out waiting for ${label}`)
}

// --- The real IPC surface ---------------------------------------------------

function startSession(multichannel: boolean): { ok: boolean; sessionId?: number } {
  const handler = mocks.handlers.get('transcription:start')
  if (!handler) throw new Error('transcription:start not registered')
  return (handler as unknown as (e: unknown, o: unknown) => { ok: boolean; sessionId?: number })(
    { sender: { id: 1 } },
    { sampleRate: RATE, multichannel }
  )
}

/** The stop path the app actually uses — Finalize + CloseStream + flush wait. */
function stopSession(): unknown {
  const handler = mocks.handlers.get('transcription:stop')
  if (!handler) throw new Error('transcription:stop not registered')
  return (handler as unknown as (e: unknown) => unknown)({ sender: { id: 1 } })
}

function pushFrame(bytes: ArrayBuffer): void {
  const listener = mocks.listeners.get('transcription:audio')
  if (!listener) throw new Error('transcription:audio not registered')
  ;(listener as unknown as (e: unknown, c: ArrayBuffer) => void)({ sender: { id: 1 } }, bytes)
}

// --- Probes -----------------------------------------------------------------

function stateEvents(): string[] {
  return mocks.sent
    .filter((e) => e.channel === 'transcription:state')
    .map((e) => String((e.payload as { state?: unknown }).state))
}

function countChannel(channel: string): number {
  return mocks.sent.filter((e) => e.channel === channel).length
}

/** Live sockets the mock is still holding. Reaches past `private` on purpose:
 *  "did session 1's socket actually go away" is the single most direct test of
 *  a cross-session leak, and there is no public accessor for it. */
function liveConnections(): number {
  const internals = server as unknown as { connections?: unknown[] }
  return internals.connections?.length ?? -1
}

/** Node's own live-handle census — a timer left running by a stopped session
 *  shows up here and nowhere else. */
function timerHandles(): number {
  const info = (process as unknown as { getActiveResourcesInfo?: () => string[] })
    .getActiveResourcesInfo
  if (typeof info !== 'function') return -1
  return info.call(process).filter((r) => r === 'Timeout').length
}

const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

interface SessionReport {
  label: string
  sessionId: number | undefined
  /** ms from the start IPC returning to the socket reporting 'listening'. */
  connectMs: number
  socketsOpened: number
  /** Seconds of audio handed to the IPC listener by this test. */
  pushedSec: number
  /** Wall ms the streaming loop actually took, vs. the nominal request. */
  wallMs: number
  nominalMs: number
  lagFirstAvg: number
  lagLastAvg: number
  lagMax: number
  lagFinal: number
  medianLagFinal: number
  submittedSec: number
  acknowledgedSec: number
  queuedSec: number
  shedSec: number
  resets: number
  tier: string
  transcripts: number
  gaps: number
  /** Seconds of audio the mock server actually received on its live socket. */
  serverReceivedSec: number
  timersAtEnd: number
  liveSocketsAtEnd: number
}

/**
 * Start a session, stream `streamMs` of audio, and measure.
 *
 * `rate` is the producer's speed as a multiple of realtime — 1.0 is a live mic.
 * Anything above 1.0 models a renderer whose PCM output overruns wall time
 * (a sample-rate or channel-count disagreement between the worklet and the
 * socket does exactly this), which is the only input shape that can produce
 * the reported tens-of-seconds lag. See the positive-control test.
 *
 * Does NOT stop — the caller chooses the stop discipline, because "how the
 * previous call ended" is exactly the variable under test.
 */
async function runSession(
  label: string,
  streamMs: number,
  multichannel: boolean,
  rate = 1
): Promise<SessionReport> {
  mocks.sent.length = 0
  const socketsBefore = server.connectionCount
  const t0 = performance.now()
  const started = startSession(multichannel)
  await waitFor(() => stateEvents().includes('listening'), 15_000, `${label}: 'listening'`)
  const connectMs = performance.now() - t0
  await waitFor(() => transcriptionHealth() !== null, 5_000, `${label}: health snapshot`)

  const frame = multichannel ? STEREO : MONO
  const ticks = Math.round(streamMs / FRAME_MS)
  const perTick = Math.max(1, Math.round(rate))
  const lag: number[] = []
  let pushedSec = 0
  const streamStart = performance.now()
  for (let i = 0; i < ticks; i++) {
    for (let f = 0; f < perTick; f++) {
      pushFrame(frame)
      pushedSec += FRAME_MS / 1000
    }
    await sleep(FRAME_MS)
    const h = transcriptionHealth()
    if (h) lag.push(h.lagSec)
  }
  const wallMs = performance.now() - streamStart

  const health = transcriptionHealth()
  if (!health) throw new Error(`${label}: session vanished mid-stream`)

  return {
    label,
    sessionId: started.sessionId,
    connectMs: Math.round(connectMs),
    socketsOpened: server.connectionCount - socketsBefore,
    pushedSec: Math.round(pushedSec * 100) / 100,
    wallMs: Math.round(wallMs),
    nominalMs: streamMs,
    lagFirstAvg: Math.round(avg(lag.slice(0, 5)) * 1000) / 1000,
    lagLastAvg: Math.round(avg(lag.slice(-5)) * 1000) / 1000,
    lagMax: Math.round(Math.max(0, ...lag) * 1000) / 1000,
    lagFinal: lag.at(-1) ?? -1,
    medianLagFinal: health.medianLagSec,
    submittedSec: health.submittedSec,
    acknowledgedSec: health.acknowledgedSec,
    queuedSec: health.queuedSec,
    shedSec: health.shedSec,
    resets: health.resets,
    tier: health.tier,
    transcripts: countChannel('transcription:transcript'),
    gaps: countChannel('transcription:gap'),
    serverReceivedSec: Math.round(server.receivedSec * 100) / 100,
    timersAtEnd: timerHandles(),
    liveSocketsAtEnd: liveConnections()
  }
}

/** Stop through the real handler and wait for the session to actually retire
 *  (`ws.on('close')` is what nulls it, up to STOP_FLUSH_MS later). */
async function stopAndSettle(timeoutMs = 8000): Promise<number> {
  const t0 = performance.now()
  await Promise.resolve(stopSession())
  await waitFor(() => transcriptionHealth() === null, timeoutMs, 'session to retire after stop')
  return Math.round(performance.now() - t0)
}

function table(reports: SessionReport[]): void {
  const rows = reports.map((r) => ({
    session: r.label,
    id: r.sessionId,
    connectMs: r.connectMs,
    sockets: r.socketsOpened,
    'lag first5 (s)': r.lagFirstAvg,
    'lag last5 (s)': r.lagLastAvg,
    'lag max (s)': r.lagMax,
    'median lag (s)': r.medianLagFinal,
    'pushed (s)': r.pushedSec,
    'submitted (s)': r.submittedSec,
    'acked (s)': r.acknowledgedSec,
    'server rx (s)': r.serverReceivedSec,
    transcripts: r.transcripts,
    queued: r.queuedSec,
    shed: r.shedSec,
    resets: r.resets,
    gaps: r.gaps,
    tier: r.tier,
    'loop wall/nominal': `${r.wallMs}/${r.nominalMs}`,
    timers: r.timersAtEnd,
    'live sockets': r.liveSocketsAtEnd
  }))
  console.table(rows)
}

let server: MockDeepgram

beforeEach(async () => {
  server = await MockDeepgram.start()
  process.env.DEEPGRAM_API_KEY = 'test-key'
  process.env.DEEPGRAM_LISTEN_URL = server.url
  mocks.sent.length = 0
  registerTranscription() // idempotent; the handler map persists across tests
})

afterEach(async () => {
  disposeTranscription()
  await server.stop()
  delete process.env.DEEPGRAM_LISTEN_URL
})

// ---------------------------------------------------------------------------

describe('two consecutive sessions in one process (mono)', () => {
  it('session 2 measures the same as session 1 after a clean stop', async () => {
    const STREAM_MS = 20_000

    const timersAtStart = timerHandles()
    const s1 = await runSession('call 1', STREAM_MS, false)
    const stop1Ms = await stopAndSettle()
    const timersBetween = timerHandles()

    const s2 = await runSession('call 2', STREAM_MS, false)
    const stop2Ms = await stopAndSettle()
    const timersAfter = timerHandles()

    table([s1, s2])
    console.log(
      `[cross-session] stop->retire: call1=${stop1Ms}ms call2=${stop2Ms}ms | ` +
        `Timeout handles: start=${timersAtStart} between=${timersBetween} after=${timersAfter}`
    )

    // --- The reported symptom, stated as thresholds -------------------------
    // Field report: call 2 climbs to 10-100 SECONDS of lag. Anything remotely
    // near that fails here.
    expect(s2.lagLastAvg).toBeLessThan(HEALTH_TUNING.warnLagSec)
    expect(s2.lagMax).toBeLessThan(HEALTH_TUNING.shedLagSec)
    expect(s2.medianLagFinal).toBeLessThan(HEALTH_TUNING.warnLagSec)

    // "Sometimes nothing transcribes at all" — audio going somewhere that is
    // not the live socket. Two independent witnesses: results came back, and
    // the server on the other end actually received the bytes.
    expect(s2.transcripts).toBeGreaterThan(0)
    expect(s2.transcripts).toBeGreaterThan(s1.transcripts * 0.5)
    expect(s2.serverReceivedSec).toBeGreaterThan(s1.serverReceivedSec * 0.8)
    expect(s2.submittedSec).toBeGreaterThan(s2.pushedSec * 0.8)
    expect(s2.acknowledgedSec).toBeGreaterThan(s2.submittedSec * 0.8)

    // --- Session 2 vs session 1, directly -----------------------------------
    expect(s2.lagLastAvg).toBeLessThan(s1.lagLastAvg + 1)
    expect(s2.connectMs).toBeLessThan(s1.connectMs + 2_000)
    expect(s2.socketsOpened).toBe(s1.socketsOpened)
    expect(s2.resets).toBe(0)
    expect(s2.gaps).toBe(0)

    // --- Nothing survives the boundary --------------------------------------
    // A brand-new session's cursors start at zero; inheriting session 1's would
    // be the most direct form of this bug.
    expect(s2.submittedSec).toBeLessThan(s1.submittedSec * 1.5)
    expect(s2.sessionId).toBe((s1.sessionId ?? 0) + 1)
    // Session 1's socket is gone, not lingering and eating audio.
    expect(s1.liveSocketsAtEnd).toBe(1)
    expect(s2.liveSocketsAtEnd).toBe(1)
    // No timer accumulation across the boundary (drain @25ms + health @1s +
    // keepalive @5s per session would show up immediately).
    expect(timersAfter).toBeLessThanOrEqual(timersAtStart + 2)
    expect(timersBetween).toBeLessThanOrEqual(timersAtStart + 2)
  }, 180_000)
})

describe('two consecutive sessions in one process (multichannel)', () => {
  // Buyer capture is the configuration the field report was collected under,
  // and it is the one M22 already found a (different) sustained-deficit bug in.
  it('session 2 measures the same as session 1', async () => {
    const STREAM_MS = 15_000

    const s1 = await runSession('call 1 (mc)', STREAM_MS, true)
    await stopAndSettle()
    const s2 = await runSession('call 2 (mc)', STREAM_MS, true)
    await stopAndSettle()

    table([s1, s2])

    expect(s2.lagLastAvg).toBeLessThan(HEALTH_TUNING.warnLagSec)
    expect(s2.lagMax).toBeLessThan(HEALTH_TUNING.shedLagSec)
    expect(s2.transcripts).toBeGreaterThan(0)
    expect(s2.transcripts).toBeGreaterThan(s1.transcripts * 0.5)
    expect(s2.lagLastAvg).toBeLessThan(s1.lagLastAvg + 1)
    expect(s2.resets).toBe(0)
    // The M22 fallback must not fire on a healthy second call — if cross-session
    // state made the lag tracker think it was already in a sustained deficit,
    // this is where it would show.
    expect(countChannel('transcription:multichannelFallback')).toBe(0)
  }, 180_000)
})

describe('the impatient restart (stop, then start before the socket has closed)', () => {
  // The real user flow: end the call, immediately start the next one. The stop
  // handler leaves `session` alive for up to STOP_FLUSH_MS (1500ms) waiting for
  // Deepgram's final words, so session 2 lands ON TOP of a session that is
  // still holding an open socket, a queue, and a pending close callback.
  it('session 2 is not contaminated by the still-closing session 1', async () => {
    const STREAM_MS = 10_000

    const s1 = await runSession('call 1', STREAM_MS, false)
    await Promise.resolve(stopSession()) // no settle — start immediately
    const stillAlive = transcriptionHealth() !== null

    const s2 = await runSession('call 2 (immediate)', STREAM_MS, false)
    await stopAndSettle()

    table([s1, s2])
    console.log(`[cross-session] session still alive when call 2 started: ${stillAlive}`)

    expect(s2.lagLastAvg).toBeLessThan(HEALTH_TUNING.warnLagSec)
    expect(s2.transcripts).toBeGreaterThan(0)
    expect(s2.sessionId).toBe((s1.sessionId ?? 0) + 1)
    // Session 2 must own a fresh socket, and session 1's must be gone.
    expect(s2.liveSocketsAtEnd).toBe(1)
    // Fresh accounting: session 1's submitted seconds must not carry over.
    expect(s2.submittedSec).toBeLessThan(s1.submittedSec * 1.5)
  }, 120_000)
})

describe('three consecutive sessions (does it degrade progressively?)', () => {
  // A leak that adds a fixed cost per session shows as a TREND, which two
  // sessions cannot distinguish from noise.
  it('session 3 is no worse than session 1', async () => {
    const STREAM_MS = 10_000
    const reports: SessionReport[] = []
    for (let n = 1; n <= 3; n++) {
      reports.push(await runSession(`call ${n}`, STREAM_MS, false))
      await stopAndSettle()
    }
    table(reports)

    const [s1, s2, s3] = reports
    for (const r of reports) {
      expect(r.lagLastAvg).toBeLessThan(HEALTH_TUNING.warnLagSec)
      expect(r.transcripts).toBeGreaterThan(0)
      expect(r.resets).toBe(0)
    }
    expect(s3.lagLastAvg).toBeLessThan(s1.lagLastAvg + 1)
    expect(s3.transcripts).toBeGreaterThan(s1.transcripts * 0.5)
    // Handles must not grow one-per-session.
    expect(s3.timersAtEnd).toBeLessThanOrEqual(s1.timersAtEnd + 2)
    expect(s3.liveSocketsAtEnd).toBe(s1.liveSocketsAtEnd)
    void s2
  }, 180_000)
})

describe('positive control — the harness CAN see the reported symptom', () => {
  // Without this, "session 2 measured the same as session 1" is worthless: it
  // could equally mean the harness is blind to the failure. So: feed the SAME
  // pipeline the one input shape that produces the field report's numbers, and
  // show it lights up.
  //
  // A producer running at 3x realtime against a 1.25x ingest cap builds lag at
  // 1.75x per wall second. That is what a renderer/socket disagreement about
  // sample rate (16k worklet vs 48k context) or channel count (stereo PCM into
  // a mono socket) looks like from in here — and it is the ONLY shape that
  // reproduces "10,000-100,000ms", because the queue never overflows (the
  // socket accepts every byte on localhost) so shedding is a no-op and only the
  // reset safety net bounds it, producing the sawtooth users describe as
  // "sometimes it catches up, mostly it doesn't".
  it('a 3x-realtime producer ratchets lag into the tens of seconds', async () => {
    const s = await runSession('3x realtime', 20_000, false, 3)
    table([s])

    // The producer really did overrun wall time 3:1.
    expect(s.submittedSec).toBeGreaterThan((s.nominalMs / 1000) * 2.5)
    // The reported magnitude: seconds, not milliseconds. Every 1.0x session
    // above topped out at 0.1s — this is two orders of magnitude worse.
    expect(s.lagMax).toBeGreaterThan(10)
    expect(s.lagLastAvg).toBeGreaterThan(5)
    // And it is a RATCHET, not a spike: it ends far above where it started.
    expect(s.lagLastAvg).toBeGreaterThan(s.lagFirstAvg + 5)
    // The watchdog is pinned in a corrective tier for the whole back half...
    expect(s.medianLagFinal).toBeGreaterThanOrEqual(HEALTH_TUNING.shedLagSec)
    expect(['shed', 'reset']).toContain(s.tier)
    // ...and only the reset safety net bounds it at all (shedding cannot: the
    // queue is empty, because the socket accepts every byte). Note this is
    // ALSO why acknowledgedSec is not a useful witness here — a reset
    // deliberately declares the discarded backlog acknowledged.
    expect(s.resets).toBeGreaterThan(0)

    await stopAndSettle()
  }, 120_000)
})

// A guard on the harness itself: if this fails, the frame size is wrong and
// every seconds-based number above is scaled by the same factor.
describe('harness sanity', () => {
  it('a mono frame is exactly one FRAME_MS of linear16 at RATE', () => {
    expect(MONO.byteLength).toBe(FRAME_BYTES)
    expect(STEREO.byteLength).toBe(FRAME_BYTES * 2)
  })
})
