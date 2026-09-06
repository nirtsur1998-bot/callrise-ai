// M37 Stage 2 — BUG-D: THE TRAP. Proof that the next thin call answers for itself.
//
// BUG-D is six weeks old and three hypotheses have died on it, each because
// the measurement that would have tested it did not exist. The founder's
// standing order is to stop theorising and instrument, and the branch question
// they want answered in one look is:
//
//     "multichannel=true means capture worked and the fault is downstream;
//      only false means the restart failed"
//
// The app could not answer that. It recorded what it ASKED Deepgram for
// (`multichannel=`) and never what Deepgram said it GOT — even though Deepgram
// sends exactly that, unprompted, on every connection, in a `Metadata` frame
// carrying `channels` and a `request_id`. The message dispatch had two
// branches ('Results', 'UtteranceEnd'); everything else fell through both and
// vanished, three lines from where it would have been read. The websocket
// 'close' handler took no arguments, so the close code went the same way.
//
// This drives the REAL pipeline against the mock Deepgram server and asserts
// the trap catches all of it, ending in the one artefact a human can read:
// the line in session-health.log.
//
// RED CHECK at birth: with the new `else` branch removed, "records what
// Deepgram says it RECEIVED" fails on serverChannels=unknown; with the close
// handler's arguments removed, the close-code test fails on closeCode=none.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { MockDeepgram } from './mock-deepgram'

const RATE = 16000
const FRAME_MS = 100

const mocks = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os')
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'callrise-bugd-trap-'))
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
    userData,
    handlers,
    listeners,
    sent,
    electron: {
      // the real one, so logSessionSummary actually writes somewhere readable.
      // Without it the write throws and its own try/catch swallows it — which
      // is why the existing pipeline tests never noticed the log at all.
      app: { getPath: () => userData },
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

const { registerTranscription, disposeTranscription } = await import('../../transcription')

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function frame(channels: 1 | 2): ArrayBuffer {
  const n = (FRAME_MS / 1000) * RATE
  const buffer = new ArrayBuffer(n * 2 * channels)
  const view = new Int16Array(buffer)
  for (let i = 0; i < n; i++) {
    view[i * channels] = Math.round(Math.sin(i / 8) * 0.4 * 32767)
    if (channels === 2) view[i * channels + 1] = Math.round(Math.sin(i / 5) * 0.4 * 32767)
  }
  return buffer
}

function startSession(multichannel: boolean): Promise<{ ok: boolean }> {
  const handler = mocks.handlers.get('transcription:start')
  if (!handler) throw new Error('transcription:start not registered')
  return Promise.resolve(
    (handler as unknown as (e: unknown, o: unknown) => { ok: boolean })({ sender: {} }, { sampleRate: RATE, multichannel })
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

/** The artefact a human actually reads. */
function healthLines(): string[] {
  const file = join(mocks.userData, 'session-health.log')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
}

let server: MockDeepgram
let registered = false

beforeEach(async () => {
  server = await MockDeepgram.start({ emitMs: 50 })
  process.env.DEEPGRAM_LISTEN_URL = server.url
  process.env.DEEPGRAM_API_KEY = 'test-key'
  if (!registered) {
    registerTranscription()
    registered = true
  }
})

afterEach(async () => {
  disposeTranscription()
  await server.stop()
  delete process.env.DEEPGRAM_LISTEN_URL
})

describe('BUG-D trap — the branch question is answerable from the log', () => {
  it('records what Deepgram says it RECEIVED, not only what we asked for', async () => {
    const before = healthLines().length
    await startSession(true) // ASK for 2 channels
    await sleep(200)
    expect(server.requestedChannels, 'the client asked for multichannel').toBe(2)

    // Deepgram answers with its own count. This is the frame that used to be
    // dropped, and it is the entire branch question.
    server.sendMetadata(2, 'req_abc123')
    for (let i = 0; i < 4; i++) {
      pushFrame(frame(2))
      await sleep(FRAME_MS)
    }
    await stopSession()
    await sleep(400)

    const lines = healthLines()
    expect(lines.length, 'a session summary line must have been written').toBeGreaterThan(before)
    const line = lines.at(-1)!
    expect(line, 'what we ASKED for').toContain('multichannel=true')
    expect(line, "what Deepgram says it GOT — the answer that did not exist before").toContain('serverChannels=2')
    expect(line, "Deepgram's own join key for a support conversation").toContain('requestId=req_abc123')
    expect(line, 'a connection that produced no result still counts here').toMatch(/socketOpens=[1-9]/)
    expect(line).toContain('frames={"Metadata":1}')
  })

  it('catches the DISAGREEMENT: asked for two channels, served one', async () => {
    // The shape that would explain a thin multichannel call: the request said
    // 2, the server processed 1. Before this, both cases logged the identical
    // `multichannel=true` and were indistinguishable forever.
    await startSession(true)
    await sleep(200)
    server.sendMetadata(1, 'req_mismatch')
    pushFrame(frame(2))
    await sleep(FRAME_MS)
    await stopSession()
    await sleep(400)

    const line = healthLines().at(-1)!
    expect(line).toContain('multichannel=true')
    expect(line).toContain('serverChannels=1')
    // and that is a machine-checkable contradiction, which is the point
    const asked = /multichannel=true/.test(line)
    const got = Number(/serverChannels=(\d+)/.exec(line)?.[1] ?? 0)
    expect(asked && got < 2, 'ask-versus-got is now decidable from one line').toBe(true)
  })

  it('records WHY the connection ended, which the close handler used to discard', async () => {
    await startSession(false)
    await sleep(200)
    pushFrame(frame(1))
    await sleep(FRAME_MS)

    // A clean server-side close, exactly like a Deepgram-initiated drop.
    server.drop()
    // the reconnect is scheduled on a 500ms backoff (transcription.ts's
    // MAX_RECONNECTS ladder), so a shorter wait measures nothing
    await sleep(900)
    await stopSession()
    await sleep(400)

    const line = healthLines().at(-1)!
    expect(line, 'a close code was captured rather than thrown away').toMatch(/closeCode=\d+/)
    expect(line, 'and the reconnect it triggered is counted').toMatch(/socketOpens=[2-9]/)
  })

  it('the log line never carries a transcript word', async () => {
    // The whole file is written to a folder a user is told to open and paste
    // from, so it must stay numbers. The mock emits the word "mock" in every
    // Results message; it must not appear.
    await startSession(false)
    await sleep(200)
    for (let i = 0; i < 4; i++) {
      pushFrame(frame(1))
      await sleep(FRAME_MS)
    }
    await stopSession()
    await sleep(400)
    const line = healthLines().at(-1)!
    expect(line).not.toContain('mock')
    expect(line, 'only key=value pairs').not.toMatch(/[a-z]{4,}\s+[a-z]{4,}\s+[a-z]{4,}/i)
  })
})
