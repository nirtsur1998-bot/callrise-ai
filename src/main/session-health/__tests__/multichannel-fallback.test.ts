// M22 Phase 1b — when a multichannel session's connection has a SUSTAINED
// throughput deficit (not a one-off blip), healthTick's 'reset' branch
// signals the renderer to drop buyer capture instead of reconnecting forever
// in the same doomed configuration. See lag.ts's evaluate() doc comment and
// transcription.ts's healthTick for the full story.
//
// BUG-247 — this file used to stream its 75 seconds of audio in REAL time
// (81 s per test idle on the dev machine, 100 s at 3x CPU load against a
// 100 s budget), so it went red under load with no code change. Both
// products of time in the pipeline — the mock server's ingest budget and the
// session's monotonic timeline — read `performance.now()`, and every pacing
// timer is a plain setTimeout/setInterval, so the whole simulation now runs on
// vitest's fake clock and 75 nominal seconds cost a few real ones. The socket
// traffic between the client and the mock server is still REAL I/O; the fake
// clock only decides when timers fire, so each step of fake time is followed
// by a yield to the event loop (setImmediate, deliberately left un-faked) that
// lets frames and Results cross the socket. The clocks are faked as a SET —
// Date and performance together — because SleepDetector compares the two and
// would report a suspend if only one of them moved.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockDeepgram } from './mock-deepgram'
import { HEALTH_TUNING } from '../types'

const RATE = 16000
const FRAME_MS = 100
const NOMINAL_STREAM_MS = 75_000

/** Everything the pipeline reads time from. setImmediate/nextTick/
 *  queueMicrotask stay real: they are the I/O yield below. */
const FAKED_CLOCKS = [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'Date',
  'performance'
] as const

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: never[]) => unknown>()
  const listeners = new Map<string, (...args: never[]) => void>()
  const sent: Array<{ channel: string; payload: Record<string, unknown> }> = []
  const window = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: Record<string, unknown>) => sent.push({ channel, payload })
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
      systemPreferences: { getMediaAccessStatus: () => 'granted', askForMediaAccess: async () => true },
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

function frame(channels: 1 | 2): ArrayBuffer {
  const framesCount = (FRAME_MS / 1000) * RATE
  const buffer = new ArrayBuffer(framesCount * 2 * channels)
  const view = new Int16Array(buffer)
  for (let i = 0; i < framesCount; i++) {
    view[i * channels] = Math.round(Math.sin(i / 8) * 0.4 * 32767)
    if (channels === 2) view[i * channels + 1] = Math.round(Math.sin(i / 5) * 0.4 * 32767)
  }
  return buffer
}

/** One turn of the real event loop, so socket frames written under fake time
 *  are actually delivered and the other side's handlers run. */
const ioYield = (): Promise<void> => new Promise((r) => setImmediate(r))

/** Advance the fake clock by `ms` (firing every timer due in that span, in
 *  order, with microtasks flushed between them), then let the real socket
 *  I/O that those timers produced complete. Two yields: one for the write to
 *  reach the peer, one for the peer's reply to reach us. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await ioYield()
  await ioYield()
}

function startSession(multichannel: boolean): Promise<{ ok: boolean; sessionId?: number }> {
  const handler = mocks.handlers.get('transcription:start')
  if (!handler) throw new Error('transcription:start not registered')
  return Promise.resolve(
    (handler as unknown as (e: unknown, o: unknown) => { ok: boolean; sessionId?: number })(
      { sender: {} },
      { sampleRate: RATE, multichannel }
    )
  )
}

function stopSession(): Promise<unknown> {
  const handler = mocks.handlers.get('transcription:stop')
  return Promise.resolve((handler as unknown as (e: unknown) => unknown)({ sender: {} }))
}

function pushFrame(bytes: ArrayBuffer): void {
  const listener = mocks.listeners.get('transcription:audio')
  if (!listener) throw new Error('transcription:audio not registered')
  ;(listener as unknown as (e: unknown, c: ArrayBuffer) => void)({ sender: {} }, bytes)
}

/** Stream `ms` of audio at exactly realtime ON THE FAKE CLOCK: one frame,
 *  then FRAME_MS of fake time, so the producer is 1.0x regardless of how
 *  loaded the machine running the test is. */
async function streamNominal(ms: number, channels: 1 | 2): Promise<void> {
  const frames = Math.round(ms / FRAME_MS)
  for (let i = 0; i < frames; i++) {
    pushFrame(frame(channels))
    await advance(FRAME_MS)
  }
}

function fallbackEvents(): Array<Record<string, unknown>> {
  return mocks.sent
    .filter((e) => e.channel === 'transcription:multichannelFallback')
    .map((e) => e.payload)
}

/** Poll `predicate` while stepping fake time in small increments (each step
 *  yields to I/O, which is what the socket handshake needs). The budget is
 *  fake milliseconds, so it bounds the simulation, not the machine. */
async function waitFor(predicate: () => boolean, budgetMs = 10_000): Promise<void> {
  const deadline = performance.now() + budgetMs
  while (performance.now() < deadline) {
    if (predicate()) return
    await advance(25)
  }
  throw new Error('timed out (fake clock)')
}

let server: MockDeepgram

beforeEach(async () => {
  // Installed BEFORE the mock server and the session exist, so every
  // `performance.now()` origin they record is on the same clock.
  vi.useFakeTimers({ toFake: [...FAKED_CLOCKS] })
  server = await MockDeepgram.start({ ingestRate: 0.02 })
  process.env.DEEPGRAM_API_KEY = 'test-key'
  process.env.DEEPGRAM_LISTEN_URL = server.url
  mocks.sent.length = 0
  registerTranscription()
})

afterEach(async () => {
  disposeTranscription()
  vi.useRealTimers()
  await server.stop()
  delete process.env.DEEPGRAM_LISTEN_URL
})

describe('multichannel fallback on a sustained throughput deficit', () => {
  it('signals the renderer exactly once after enough resets in the window, not before', async () => {
    // Near-zero ingest rate: the median-of-last-5-samples value trigger
    // (resetLagSec=15, needs only 5s of samples) fires well before the
    // rising-slope guard's 30s window would even have enough data — each
    // reset cycle takes ~20s, so a 75s run reliably produces multiple resets.
    await startSession(true)
    await waitFor(() => transcriptionHealth() !== null)

    await streamNominal(NOMINAL_STREAM_MS, 2)

    const events = fallbackEvents()
    const health = transcriptionHealth()!
    console.log(
      `[bug247] multichannel: resets=${health.resets} fallbackEvents=${events.length} ` +
        `submitted=${health.submittedSec.toFixed(1)}s acked=${health.acknowledgedSec.toFixed(1)}s ` +
        `server rx=${server.totalReceivedSec.toFixed(1)}s (fake clock, ${NOMINAL_STREAM_MS / 1000}s nominal)`
    )
    expect(events.length).toBe(1) // signaled exactly once, not per tick
    expect(health.resets).toBeGreaterThanOrEqual(HEALTH_TUNING.maxResetsPerWindow)

    await stopSession()
  }, 20_000) // real ms; the 75 s of audio above are fake

  it('never fires for a mono session, even under the same sustained deficit', async () => {
    await startSession(false)
    await waitFor(() => transcriptionHealth() !== null)
    await streamNominal(NOMINAL_STREAM_MS, 1)

    const health = transcriptionHealth()!
    console.log(
      `[bug247] mono: resets=${health.resets} fallbackEvents=${fallbackEvents().length} ` +
        `submitted=${health.submittedSec.toFixed(1)}s acked=${health.acknowledgedSec.toFixed(1)}s`
    )
    expect(health.resets).toBeGreaterThanOrEqual(HEALTH_TUNING.maxResetsPerWindow)
    expect(fallbackEvents()).toHaveLength(0) // mono has nothing to fall back FROM

    await stopSession()
  }, 20_000)
})
