// M26 Phase 4.4 — a crashed renderer must not leave a live session running
// forever.
//
// TODAY, WITHOUT THIS: no render-process-gone / crashed / unresponsive
// handler exists anywhere in main. The liveness watchdog keys off
// lastAudioMs, which freezes the instant the renderer dies — so the health
// tick just injects a synthetic silence frame every few seconds, exactly
// what Deepgram's no-audio deadline needs to stay satisfied. The socket
// stays open, and billing, indefinitely, into a page that no longer exists.
//
// This drives the REAL ipcMain handlers and a REAL (local) Deepgram-shaped
// WebSocket server — same harness as orphaned-producer.test.ts — so a
// regression here fails on the actual wiring, not on a description of it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

const { registerTranscription, disposeTranscription, transcriptionHealth, handleRenderProcessGone } =
  await import('../../transcription')
const { setCallJournalsDirForTests, readJournal } = await import('../../live/call-journal')
const { resetLiveTranscriptForTests, liveCallInfo } = await import('../../live/live-transcript')
// `listRecoverableCalls`, not the lower-level `listOrphanJournals` — it's the
// one that applies the "the call still in progress is not an orphan" filter,
// and that filter is exactly what depends on endLiveCallUnsaved() having
// actually nulled live-transcript's own `current`. The raw journal-listing
// function would find this journal either way (it never checks `current` at
// all), which would make this test pass whether or not main's own
// end-of-call trigger did its job.
const { listRecoverableCalls } = await import('../../live/live-transcript-ipc')

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

function countChannel(channel: string): number {
  return mocks.sent.filter((e) => e.channel === channel).length
}

async function startAndWait(): Promise<void> {
  mocks.sent.length = 0
  startSession()
  await waitFor(() => stateEvents().includes('listening'), 15_000, "'listening'")
  await waitFor(() => transcriptionHealth() !== null, 5_000, 'health snapshot')
}

/** Stream frames until at least one real transcript event has come back
 *  through the socket, so the journal being tested actually has content —
 *  otherwise "no phantom recovery" and "genuinely lost this call" would look
 *  identical. */
async function speakUntilTranscribed(): Promise<void> {
  const before = countChannel('transcription:transcript')
  const deadline = performance.now() + 20_000
  while (performance.now() < deadline) {
    pushFrame()
    await sleep(FRAME_MS)
    if (countChannel('transcription:transcript') > before) return
  }
  throw new Error('timed out waiting for a real transcript event')
}

let server: MockDeepgram
let journalsDir: string

beforeEach(async () => {
  server = await MockDeepgram.start()
  process.env.DEEPGRAM_API_KEY = 'test-key'
  process.env.DEEPGRAM_LISTEN_URL = server.url
  mocks.sent.length = 0
  journalsDir = mkdtempSync(join(tmpdir(), 'rpg-journal-'))
  setCallJournalsDirForTests(journalsDir)
  registerTranscription() // idempotent; the handler map persists across tests
})

afterEach(async () => {
  disposeTranscription()
  resetLiveTranscriptForTests()
  setCallJournalsDirForTests(null)
  await server.stop()
  delete process.env.DEEPGRAM_LISTEN_URL
  rmSync(journalsDir, { recursive: true, force: true })
})

describe('a crashed renderer does not leave a session running forever', () => {
  it('tears down main’s own session state', async () => {
    await startAndWait()
    await speakUntilTranscribed()
    expect(transcriptionHealth()).not.toBeNull()

    handleRenderProcessGone()

    // Main's own authoritative signal that nothing is live any more — the
    // same function `--diagnose` and transcription:attach both trust.
    expect(transcriptionHealth()).toBeNull()
  })

  it('leaves the journal recoverable — never a phantom save, never silently lost', async () => {
    await startAndWait()
    await speakUntilTranscribed()
    const callId = liveCallInfo()!.callId

    handleRenderProcessGone()
    await sleep(50) // let the journal's own fire-and-forget writes settle

    // Main's OWN idea of "is a call still live" must have genuinely cleared —
    // otherwise this journal would never surface to the rep at all, on the
    // grounds that main still thinks it's in progress.
    expect(liveCallInfo()).toBeNull()

    const recoverable = await listRecoverableCalls()
    expect(recoverable).toHaveLength(1)
    expect(recoverable[0].id).toBe(callId)

    // The words that were actually said survived the crash — this is the
    // whole point of 4.1-4.2's journaling, now proven through a real crash
    // rather than through a synthetic event sequence.
    const journal = await readJournal(callId)
    expect(journal?.events.some((e) => e.t === 'result')).toBe(true)
  })

  it('is idempotent — a second crash signal (or one with nothing live) does not throw', async () => {
    await startAndWait()
    await speakUntilTranscribed()

    expect(() => {
      handleRenderProcessGone()
      handleRenderProcessGone()
      handleRenderProcessGone()
    }).not.toThrow()
    expect(transcriptionHealth()).toBeNull()
  })

  it('a fresh call can start normally right after — the module is not left wedged', async () => {
    await startAndWait()
    await speakUntilTranscribed()
    handleRenderProcessGone()

    await startAndWait()
    await speakUntilTranscribed()
    expect(transcriptionHealth()).not.toBeNull()
  }, 40_000)
})
