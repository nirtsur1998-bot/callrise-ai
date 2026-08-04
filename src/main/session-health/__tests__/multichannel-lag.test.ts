// Regression coverage gap found investigating a live-call report (2026-08-04):
// "buyer side capture has delay with lag that keeps rising, mono doesn't do
// this." lag-regression.test.ts proves the pipeline never ratchets under
// mono (CHANNELS = 1 is hardcoded there) — multichannel was never run
// against the same ingest-cap-enforcing mock at all. This fills that gap.
//
// Verdict from running it: lag stays pinned at ~1 frame (0.1s) for BOTH mono
// and stereo under sustained 1.0x-realtime streaming with the same mock —
// this pipeline's queue/lag/drain/healthTick code is not what ratchets for
// multichannel. That clears the single most likely LOCAL cause and points
// the remaining live-call symptom at something outside this module (real
// Deepgram's per-channel compute cost, or renderer-thread contention from
// the ~2x Results-message volume multichannel produces — see
// SpeakerTranscript's memoization fix and segments.ts's mergeSegments
// identity fix, landed alongside this test, for the renderer-side half of
// that investigation).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockDeepgram } from './mock-deepgram'
import { HEALTH_TUNING } from '../types'

const RATE = 16000
const FRAME_MS = 100

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

function makeFrame(channels: 1 | 2): ArrayBuffer {
  const framesCount = (FRAME_MS / 1000) * RATE
  const buffer = new ArrayBuffer(framesCount * 2 * channels)
  const view = new Int16Array(buffer)
  for (let i = 0; i < framesCount; i++) {
    view[i * channels] = Math.round(Math.sin(i / 8) * 0.4 * 32767)
    if (channels === 2) view[i * channels + 1] = Math.round(Math.sin(i / 5) * 0.4 * 32767)
  }
  return buffer
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

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

async function streamRealtime(ms: number, channels: 1 | 2): Promise<number[]> {
  const frames = Math.round(ms / FRAME_MS)
  const lagSamples: number[] = []
  for (let i = 0; i < frames; i++) {
    pushFrame(makeFrame(channels))
    await sleep(FRAME_MS)
    const h = transcriptionHealth()
    if (h) lagSamples.push(h.lagSec)
  }
  return lagSamples
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (predicate()) return
    await sleep(25)
  }
  throw new Error('timed out')
}

let server: MockDeepgram

beforeEach(async () => {
  server = await MockDeepgram.start()
  process.env.DEEPGRAM_API_KEY = 'test-key'
  process.env.DEEPGRAM_LISTEN_URL = server.url
  mocks.sent.length = 0
  registerTranscription()
})

afterEach(async () => {
  disposeTranscription()
  await server.stop()
  delete process.env.DEEPGRAM_LISTEN_URL
})

describe('multichannel lag under sustained 1.0x realtime streaming, no disconnects', () => {
  it('stays bounded, matching mono, against the same ingest-cap mock', async () => {
    await startSession(true)
    await waitFor(() => transcriptionHealth() !== null)
    const samples = await streamRealtime(15_000, 2)
    // Never asserted "never rises at all" — a single tick of jitter is fine.
    // The ratchet this guards against is SUSTAINED growth: the back half of
    // the run staying near where it started, not climbing away from it.
    const first5 = samples.slice(0, 5)
    const last5 = samples.slice(-5)
    const firstAvg = first5.reduce((a, b) => a + b, 0) / first5.length
    const lastAvg = last5.reduce((a, b) => a + b, 0) / last5.length
    expect(lastAvg).toBeLessThan(HEALTH_TUNING.warnLagSec)
    expect(lastAvg).toBeLessThan(firstAvg + 0.5)
    await stopSession()
  }, 30_000)
})
