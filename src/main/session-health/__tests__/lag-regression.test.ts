// Phase 2 — the 90-second lag bug: reproduced, then proven fixed.
//
// These drive the REAL pipeline in transcription.ts against a local mock that
// enforces Deepgram's 1.25x ingest cap (see mock-deepgram.ts). The cap is the
// point: without it every test here would pass while proving nothing, because
// an instantly-acknowledging server makes backlog free.
//
// A note on how the outages are staged. A real 30-second drop produces a queue
// holding 30 SECONDS OF AUDIO. The queue is bounded in audio-seconds, so
// pushing those 30 seconds in quickly produces a byte-for-byte identical queue
// state to waiting 30 wall-clock seconds — same shed, same trim, same gap —
// while keeping the suite fast. Wall time is only ever used where the
// dynamics genuinely depend on it: recovery, which is rate-limited by the
// ingest cap and therefore measured in real seconds.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { MockDeepgram, INGEST_RATE } from './mock-deepgram'
import { HEALTH_TUNING } from '../types'

const RATE = 16000
const CHANNELS = 1
const FRAME_MS = 100
const FRAME_BYTES = (FRAME_MS / 1000) * RATE * 2

// --- Electron stand-in ------------------------------------------------------
// transcription.ts talks to Electron only through ipcMain and one BrowserWindow,
// so a few functions are enough to run the real module unmodified.
const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: never[]) => unknown>()
  const listeners = new Map<string, (...args: never[]) => void>()
  const sent: Array<{ channel: string; payload: Record<string, unknown> }> = []
  const window = {
    isDestroyed: () => false,
    webContents: {
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
      shell: { openExternal: async () => undefined }
    }
  }
})

vi.mock('electron', () => mocks.electron)
vi.mock('../../ai-keys', () => ({ keyRejectedHint: () => '' }))

const { registerTranscription, disposeTranscription, transcriptionHealth } =
  await import('../../transcription')

// --- Helpers ----------------------------------------------------------------

function pcm(amplitude: number, byteLength = FRAME_BYTES): ArrayBuffer {
  const buffer = new ArrayBuffer(byteLength)
  const view = new Int16Array(buffer)
  for (let i = 0; i < view.length; i++) {
    // A steady tone, not a constant: constant DC would read as one sample value
    // but still count as energy, and we want frames that behave like speech.
    view[i] = Math.round(Math.sin(i / 8) * amplitude * 32767)
  }
  return buffer
}

const VOICED = pcm(0.4)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 20_000,
  label = 'condition'
): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (predicate()) return
    await sleep(25)
  }
  throw new Error(`timed out waiting for ${label}`)
}

function startSession(): Promise<{ ok: boolean; sessionId?: number }> {
  const handler = mocks.handlers.get('transcription:start')
  if (!handler) throw new Error('transcription:start not registered')
  return Promise.resolve(
    (handler as unknown as (e: unknown, o: unknown) => { ok: boolean; sessionId?: number })(
      { sender: {} },
      { sampleRate: RATE }
    )
  )
}

function stopSession(): Promise<unknown> {
  const handler = mocks.handlers.get('transcription:stop')
  return Promise.resolve((handler as unknown as (e: unknown) => unknown)({ sender: {} }))
}

/** One audio frame into the real IPC path. */
function pushFrame(bytes: ArrayBuffer = VOICED): void {
  const listener = mocks.listeners.get('transcription:audio')
  if (!listener) throw new Error('transcription:audio not registered')
  ;(listener as unknown as (e: unknown, c: ArrayBuffer) => void)({ sender: {} }, bytes)
}

/** N seconds of audio, delivered as fast as the loop allows. */
function burstSeconds(seconds: number): void {
  const frames = Math.round((seconds * 1000) / FRAME_MS)
  for (let i = 0; i < frames; i++) pushFrame()
}

/** Stream at 1.0x realtime for `ms`, the rate a live mic actually produces. */
async function streamRealtime(ms: number): Promise<void> {
  const frames = Math.round(ms / FRAME_MS)
  for (let i = 0; i < frames; i++) {
    pushFrame()
    await sleep(FRAME_MS)
  }
}

function gapEvents(): Array<{ durationMs: number; reason: string; marker: string }> {
  return mocks.sent
    .filter((e) => e.channel === 'transcription:gap')
    .map((e) => e.payload as unknown as { durationMs: number; reason: string; marker: string })
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

describe('the ratchet mechanism (why buffering a disconnect is the bug)', () => {
  // Reproduces the bug's ENGINE, deliberately bypassing our pipeline: a raw
  // socket that replays a 30-second backlog the way Deepgram's own "buffer
  // while disconnected" guidance implies. The ingest cap does the rest.
  it('never recovers a replayed 30s backlog, because catch-up is only 0.25x', async () => {
    const socket = new WebSocket(`${server.url}?sample_rate=${RATE}&channels=${CHANNELS}`)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })

    let sentSec = 0
    let ackedSec = 0
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { start?: number; duration?: number }
      if (typeof msg.start === 'number' && typeof msg.duration === 'number') {
        ackedSec = Math.max(ackedSec, msg.start + msg.duration)
      }
    })

    // The replay: 30 seconds of backlog handed over at once.
    const backlogSec = 30
    for (let i = 0; i < (backlogSec * 1000) / FRAME_MS; i++) {
      socket.send(Buffer.from(VOICED))
      sentSec += FRAME_MS / 1000
    }

    // Then live audio continues at 1.0x, exactly as it would on a real call.
    const observeMs = 5_000
    const startedAt = performance.now()
    await streamRealtimeTo(socket, observeMs, () => {
      sentSec += FRAME_MS / 1000
    })
    const elapsedSec = (performance.now() - startedAt) / 1000

    const lag = sentSec - ackedSec
    // Catch-up is bounded by (ingestRate − 1) x elapsed. Anything faster would
    // mean the mock is not enforcing the cap, and the suite proves nothing.
    const maxRecovery = (INGEST_RATE - 1) * elapsedSec
    expect(lag).toBeGreaterThan(backlogSec - maxRecovery - 2)
    // Still catastrophically behind after five seconds of perfect conditions.
    expect(lag).toBeGreaterThan(20)
    socket.terminate()
  }, 30_000)
})

async function streamRealtimeTo(socket: WebSocket, ms: number, onSent: () => void): Promise<void> {
  const frames = Math.round(ms / FRAME_MS)
  for (let i = 0; i < frames; i++) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(Buffer.from(VOICED))
      onSent()
    }
    await sleep(FRAME_MS)
  }
}

describe('the pipeline under a 30-second drop', () => {
  it('sheds the backlog, marks the gap, and returns to the live edge', async () => {
    await startSession()
    await waitFor(() => transcriptionHealth() !== null, 10_000, 'session health')
    await streamRealtime(1_000)

    // Two clean 30-second outages, as the spec's repro calls for.
    for (let round = 0; round < 2; round++) {
      const connectionsBefore = server.connectionCount
      server.drop()
      await sleep(60) // let 'close' land before the backlog arrives
      burstSeconds(30)

      // Nothing may ever hold more than the cap, no matter how long the outage.
      expect(transcriptionHealth()!.queuedSec).toBeLessThanOrEqual(
        HEALTH_TUNING.queueCapSec + 0.001
      )
      await waitFor(
        () => server.connectionCount > connectionsBefore,
        10_000,
        `reconnect ${round + 1}`
      )
    }

    // Audio resumes. Recovery is rate-limited by the ingest cap (catch-up is
    // only 0.25x per second), so this genuinely has to run in real time. The
    // criterion is "under 2s within 10s of reconnect", so measure WHEN it
    // crosses rather than sampling once and hoping.
    const reconnectedAt = performance.now()
    let recoveredAtMs: number | null = null
    for (let second = 0; second < 12; second++) {
      await streamRealtime(1_000)
      if (recoveredAtMs === null && transcriptionHealth()!.lagSec < HEALTH_TUNING.warnLagSec) {
        recoveredAtMs = performance.now() - reconnectedAt
      }
    }

    expect(recoveredAtMs).not.toBeNull()
    expect(recoveredAtMs!).toBeLessThan(10_000)

    const health = transcriptionHealth()!
    expect(health.lagSec).toBeLessThan(1)
    expect(health.queuedSec).toBeLessThan(1)
    // The smoothed value the watchdog acts on settles too — it trails by its
    // 5-sample window, which is the point of it.
    expect(health.medianLagSec).toBeLessThan(HEALTH_TUNING.warnLagSec)

    // The dropped audio is reported, not silently swallowed.
    const gaps = gapEvents()
    expect(gaps.length).toBeGreaterThan(0)
    const totalGapSec = gaps.reduce((sum, g) => sum + g.durationMs, 0) / 1000
    expect(totalGapSec).toBeGreaterThan(40) // ~27s per outage, twice
    expect(gaps.every((g) => /^\[gap: \d+s\]$/.test(g.marker))).toBe(true)

    await stopSession()
  }, 60_000)

  it('replays only a short tail, never the whole outage', async () => {
    await startSession()
    await waitFor(() => transcriptionHealth() !== null, 10_000, 'session health')
    await streamRealtime(500)

    const before = server.totalReceivedSec
    server.drop()
    await sleep(60)
    burstSeconds(30)
    await waitFor(() => server.connectionCount > 1, 10_000, 'reconnect')
    await sleep(500) // let the drain push whatever survived

    const replayedSec = server.receivedSec
    expect(replayedSec).toBeLessThanOrEqual(HEALTH_TUNING.replayCapSec + 1)
    // ...and the 30s backlog definitively did NOT arrive.
    expect(server.totalReceivedSec - before).toBeLessThan(10)

    await stopSession()
  }, 45_000)
})

describe('a long suspend cannot become a long replay', () => {
  // Twenty minutes of buffered audio at a 1.25x ingest cap would be eighty
  // minutes of lag. The guarantee is structural: the queue is bounded in
  // audio-seconds, so the buffer cannot exist to be replayed in the first
  // place — regardless of how the outage is detected.
  // (SleepDetector's own clock-divergence logic is unit-tested in timeline.test.ts.)
  it('discards a 20-minute backlog rather than replaying it', async () => {
    await startSession()
    await waitFor(() => transcriptionHealth() !== null, 10_000, 'session health')
    await streamRealtime(500)

    server.drop()
    await sleep(60)
    burstSeconds(20 * 60) // 1200 seconds

    expect(transcriptionHealth()!.queuedSec).toBeLessThanOrEqual(HEALTH_TUNING.queueCapSec + 0.001)

    await waitFor(() => server.connectionCount > 1, 10_000, 'reconnect')
    await sleep(600)

    expect(server.receivedSec).toBeLessThanOrEqual(HEALTH_TUNING.replayCapSec + 1)
    const shedSec = transcriptionHealth()!.shedSec
    expect(shedSec).toBeGreaterThan(1100) // nearly all twenty minutes, dropped

    await stopSession()
  }, 45_000)
})

describe('a half-open socket', () => {
  // The real 90-second bug, and the one place `bufferedAmount` is NOT the
  // defence. Measured on loopback: 1.92 MB (60 seconds of audio) disappeared
  // into a black-holed socket with `bufferedAmount` still reading 0 — the
  // kernel absorbed all of it — and it only began reporting past ~11 MB. So
  // backpressure is a real but LATE signal, and audio already handed to the
  // kernel is beyond the queue's reach entirely.
  //
  // What bounds this case is the liveness watchdog: no server message for 10s
  // while actively streaming means the socket is dead no matter what
  // `readyState` claims, and the session is rebuilt at the live edge.
  it('is detected and rebuilt even though readyState still says OPEN', async () => {
    await startSession()
    await waitFor(() => transcriptionHealth() !== null, 10_000, 'session health')
    await streamRealtime(500)

    const connectionsBefore = server.connectionCount
    server.blackhole()

    // Keep streaming, as a live mic would. Nothing gets through, and nothing
    // in the socket's own state says so.
    const streaming = streamRealtime(14_000)
    await waitFor(
      () => server.connectionCount > connectionsBefore,
      20_000,
      'the dead socket to be noticed and rebuilt'
    )
    // Detected by the application-level heartbeat, not by TCP.
    server.restore()
    await streaming

    await stopSession()
  }, 60_000)
})
