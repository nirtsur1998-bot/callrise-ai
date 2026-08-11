// M22 Phase 1b — when a multichannel session's connection has a SUSTAINED
// throughput deficit (not a one-off blip), healthTick's 'reset' branch
// signals the renderer to drop buyer capture instead of reconnecting forever
// in the same doomed configuration. See lag.ts's evaluate() doc comment and
// transcription.ts's healthTick for the full story.
import { afterEach, describe, expect, it, vi } from 'vitest'
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

async function streamRealtime(ms: number, channels: 1 | 2): Promise<void> {
  const frames = Math.round(ms / FRAME_MS)
  for (let i = 0; i < frames; i++) {
    pushFrame(frame(channels))
    await sleep(FRAME_MS)
  }
}

function fallbackEvents(): Array<Record<string, unknown>> {
  return mocks.sent
    .filter((e) => e.channel === 'transcription:multichannelFallback')
    .map((e) => e.payload)
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

afterEach(async () => {
  disposeTranscription()
  await server.stop()
  delete process.env.DEEPGRAM_LISTEN_URL
})

describe('multichannel fallback on a sustained throughput deficit', () => {
  it('signals the renderer exactly once after enough resets in the window, not before', async () => {
    // Near-zero ingest rate: the median-of-last-5-samples value trigger
    // (resetLagSec=15, needs only 5s of samples) fires well before the
    // rising-slope guard's 30s window would even have enough data — each
    // reset cycle takes ~20s, so a 75s run reliably produces multiple resets.
    server = await MockDeepgram.start({ ingestRate: 0.02 })
    process.env.DEEPGRAM_API_KEY = 'test-key'
    process.env.DEEPGRAM_LISTEN_URL = server.url
    mocks.sent.length = 0
    registerTranscription()

    await startSession(true)
    await waitFor(() => transcriptionHealth() !== null)

    await streamRealtime(75_000, 2)

    const events = fallbackEvents()
    expect(events.length).toBe(1) // signaled exactly once, not per tick
    expect(transcriptionHealth()!.resets).toBeGreaterThanOrEqual(HEALTH_TUNING.maxResetsPerWindow)

    await stopSession()
  }, 100_000)

  it('never fires for a mono session, even under the same sustained deficit', async () => {
    server = await MockDeepgram.start({ ingestRate: 0.02 })
    process.env.DEEPGRAM_API_KEY = 'test-key'
    process.env.DEEPGRAM_LISTEN_URL = server.url
    mocks.sent.length = 0
    registerTranscription()

    await startSession(false)
    await waitFor(() => transcriptionHealth() !== null)
    await streamRealtime(75_000, 1)

    expect(transcriptionHealth()!.resets).toBeGreaterThanOrEqual(HEALTH_TUNING.maxResetsPerWindow)
    expect(fallbackEvents()).toHaveLength(0) // mono has nothing to fall back FROM

    await stopSession()
  }, 100_000)
})
