// M26 Phase 4.4b — drain() closed as the fourth entry point, on the same
// terms as healthTick/ingestAudio/the socket message handler: a single fault
// is logged and tolerated (matching today's accidental tolerance, not
// tightening it), and only faults that are clearly RECURRING within the
// window end the session.
//
// drain() has FOUR call sites (ws.on('open'), the audio-ingest path, its own
// drain timer, and transcription:stop's final flush) — wrapping the shared
// function itself, once, is what protects all four uniformly. This test
// forces a real throw via the one component drain() cannot avoid touching
// (AudioQueue.peek), through the real session started via the real IPC
// handlers, so it proves the WIRING rather than re-testing the counting logic
// (already covered directly in fault-threshold.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { AudioQueue } from '../queue'
import { MockDeepgram } from './mock-deepgram'

const RATE = 16000
const FRAME_MS = 100

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
      },
      app: { getPath: () => tmpdir() }
    }
  }
})

vi.mock('electron', () => mocks.electron)
vi.mock('../../ai-keys', () => ({ keyRejectedHint: () => '' }))

const { registerTranscription, disposeTranscription, transcriptionHealth } =
  await import('../../transcription')

function pcm(): ArrayBuffer {
  const frames = (FRAME_MS / 1000) * RATE
  const buffer = new ArrayBuffer(frames * 2)
  const view = new Int16Array(buffer)
  for (let i = 0; i < frames; i++) view[i] = Math.round(Math.sin(i / 8) * 0.4 * 32767)
  return buffer
}
const MONO = pcm()

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (predicate()) return
    await sleep(20)
  }
  throw new Error(`timed out waiting for ${label}`)
}

function startSession(): { ok: boolean; sessionId?: number } {
  const handler = mocks.handlers.get('transcription:start')
  if (!handler) throw new Error('transcription:start not registered')
  return (handler as unknown as (e: unknown, o: unknown) => { ok: boolean; sessionId?: number })(
    { sender: { id: 1 } },
    { sampleRate: RATE, multichannel: false }
  )
}

function pushFrame(): void {
  const listener = mocks.listeners.get('transcription:audio')
  if (!listener) throw new Error('transcription:audio not registered')
  ;(listener as unknown as (e: unknown, c: ArrayBuffer) => void)({ sender: { id: 1 } }, MONO)
}

function stateEvents(): string[] {
  return mocks.sent
    .filter((e) => e.channel === 'transcription:state')
    .map((e) => String((e.payload as { state?: unknown }).state))
}

async function startAndWait(): Promise<void> {
  mocks.sent.length = 0
  startSession()
  await waitFor(() => stateEvents().includes('listening'), 15_000, "'listening'")
  await waitFor(() => transcriptionHealth() !== null, 5_000, 'health snapshot')
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
  vi.restoreAllMocks()
  await server.stop()
  delete process.env.DEEPGRAM_LISTEN_URL
})

describe('drain() tolerates a fault the same way the other three entry points do', () => {
  it('a single fault is logged and the session survives — matching today’s tolerance, not tightening it', async () => {
    await startAndWait()

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Something has to actually be queued for drain() to reach peek() at
    // all — an empty queue never calls it.
    pushFrame()
    pushFrame()
    // Break exactly one call, on whichever entry point reaches it first
    // (the drain timer, in practice, since it fires every 25ms).
    const peekSpy = vi.spyOn(AudioQueue.prototype, 'peek').mockImplementationOnce(() => {
      throw new Error('synthetic drain fault')
    })

    // Keep audio flowing so drain() keeps having something to reach — and
    // give the drain timer a few ticks to hit the broken call and recover.
    for (let i = 0; i < 10; i++) {
      pushFrame()
      await sleep(FRAME_MS)
    }

    expect(peekSpy).toHaveBeenCalled()
    // The fault was reported through the SAME channel the other three
    // entry points use — proving this is the shared path, not a bespoke one.
    expect(
      errSpy.mock.calls.some((c) => String(c[0]).includes('[transcription:drain]'))
    ).toBe(true)
    // One fault does not end the session — the whole reason the threshold
    // exists rather than failing on the first throw.
    expect(transcriptionHealth()).not.toBeNull()

    // ...and the call keeps working afterward: real audio still flows.
    for (let i = 0; i < 20; i++) {
      pushFrame()
      await sleep(FRAME_MS)
    }
    expect(transcriptionHealth()).not.toBeNull()
  }, 30_000)

  it('recurring faults within the window end the session, via the shared threshold', async () => {
    await startAndWait()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    pushFrame()
    // Every call to peek() throws — the drain timer fires every 25ms, so the
    // threshold (3 faults / 5s window) is crossed almost immediately, as
    // long as there is something in the queue for it to reach.
    vi.spyOn(AudioQueue.prototype, 'peek').mockImplementation(() => {
      throw new Error('synthetic recurring drain fault')
    })

    // Keep the queue non-empty while waiting for the threshold to trip.
    const pusher = setInterval(pushFrame, FRAME_MS)
    try {
      await waitFor(() => transcriptionHealth() === null, 5_000, 'session to end on recurring faults')
    } finally {
      clearInterval(pusher)
    }
    expect(stateEvents()).toContain('error')
  }, 20_000)
})
