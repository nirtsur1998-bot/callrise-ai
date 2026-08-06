// The orphaned-producer regression — "first call perfect, every call after it
// unusable, until you kill the process".
//
// THE BUG (found 2026-08-06, reported from three separate Windows machines):
// `beginSession` in useTranscription.ts could walk away from a live Recorder
// without stopping it — two post-await supersession checks returned early while
// the local `recorder` still held an open mic, a running AudioContext, and a
// worklet whose port was still posting PCM into `sendAudio`. Nothing referenced
// it any more, so nothing could ever stop it. It kept feeding audio into
// whatever session came next, for the life of the process.
//
// WHY THAT IS CATASTROPHIC RATHER THAN MERELY UNTIDY. Deepgram acknowledges at
// ~1.25x realtime of DECLARED audio duration. One live producer submits 1.0s of
// declared audio per wall second, so lag stays flat. TWO producers submit 2.0s
// per wall second against a 1.25x drain:
//
//     lag growth = 2.00 - 1.25 = 0.75 s per wall second = 45 s per minute
//
// which reaches 10,000ms about 13s into a call and 100,000ms about 2.25 minutes
// in — precisely the 10,000-100,000ms band that was reported. A third orphan
// (call 3) makes it 1.75 s/s. That is why a process restart bought exactly ONE
// good call.
//
// It also explains the half of the report that pure slowness does not: two
// unsynchronised mic captures interleaved into one linear16 stream is not
// speech, so Deepgram returns few or no results — "sometimes nothing transcribes
// at all".
//
// THE FIX, AND WHAT THIS FILE PINS. Main used to authenticate audio by WINDOW
// alone (`BrowserWindow.fromWebContents(event.sender) !== s.window`), which an
// orphan trivially satisfies — it lives in the same window. `transcription:start`
// already had a stronger notion of authority (`expectedSessionId`); the audio
// path had none. Each Recorder now carries a `producerId` and main refuses audio
// from any producer other than the one the session was started for. The renderer
// no longer orphans recorders either, but this guard is the backstop that makes
// the whole class of bug harmless even if a renderer path is missed again.
//
// These tests drive the REAL ipcMain handlers, so they fail on the pre-fix code.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockDeepgram } from './mock-deepgram'
import { HEALTH_TUNING } from '../types'

const RATE = 16000
const FRAME_MS = 100

// --- Electron stand-in (same shape as cross-session-leak.test.ts) ------------
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

/** A steady tone, not DC — frames that behave like speech to the RMS gate. */
function pcm(): ArrayBuffer {
  const frames = (FRAME_MS / 1000) * RATE
  const buffer = new ArrayBuffer(frames * 2)
  const view = new Int16Array(buffer)
  for (let i = 0; i < frames; i++) view[i] = Math.round(Math.sin(i / 8) * 0.4 * 32767)
  return buffer
}
const MONO = pcm()
const FRAME_SEC = FRAME_MS / 1000

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

function startSession(opts: { producerId?: number; multichannel?: boolean } = {}): {
  ok: boolean
  sessionId?: number
} {
  const handler = mocks.handlers.get('transcription:start')
  if (!handler) throw new Error('transcription:start not registered')
  return (handler as unknown as (e: unknown, o: unknown) => { ok: boolean; sessionId?: number })(
    { sender: { id: 1 } },
    { sampleRate: RATE, multichannel: opts.multichannel === true, producerId: opts.producerId }
  )
}

function stopSession(): unknown {
  const handler = mocks.handlers.get('transcription:stop')
  if (!handler) throw new Error('transcription:stop not registered')
  return (handler as unknown as (e: unknown) => unknown)({ sender: { id: 1 } })
}

/** Push one frame AS a given producer. `undefined` models a legacy caller. */
function pushFrame(producerId?: number): void {
  const listener = mocks.listeners.get('transcription:audio')
  if (!listener) throw new Error('transcription:audio not registered')
  ;(listener as unknown as (e: unknown, c: ArrayBuffer, p?: number) => void)(
    { sender: { id: 1 } },
    MONO,
    producerId
  )
}

function reportDropped(frames: number, producerId?: number): void {
  const listener = mocks.listeners.get('transcription:audioDropped')
  if (!listener) throw new Error('transcription:audioDropped not registered')
  ;(listener as unknown as (e: unknown, f: number, p?: number) => void)(
    { sender: { id: 1 } },
    frames,
    producerId
  )
}

function stateEvents(): string[] {
  return mocks.sent
    .filter((e) => e.channel === 'transcription:state')
    .map((e) => String((e.payload as { state?: unknown }).state))
}

function countChannel(channel: string): number {
  return mocks.sent.filter((e) => e.channel === channel).length
}

async function startAndWait(opts: { producerId?: number; multichannel?: boolean } = {}): Promise<void> {
  mocks.sent.length = 0
  startSession(opts)
  await waitFor(() => stateEvents().includes('listening'), 15_000, "'listening'")
  await waitFor(() => transcriptionHealth() !== null, 5_000, 'health snapshot')
}

async function stopAndSettle(timeoutMs = 8000): Promise<void> {
  await Promise.resolve(stopSession())
  await waitFor(() => transcriptionHealth() === null, timeoutMs, 'session to retire after stop')
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

describe('orphaned producer cannot contaminate the next session', () => {
  it("drops audio from a stopped call's recorder, so lag never ratchets", async () => {
    // Call 1 belongs to producer 1.
    await startAndWait({ producerId: 1 })
    for (let i = 0; i < 30; i++) {
      pushFrame(1)
      await sleep(FRAME_MS)
    }
    await stopAndSettle()

    // Call 2 belongs to producer 2 — but producer 1 was never stopped (an
    // abandoned AudioContext whose worklet is still posting PCM). Both push at
    // 1x realtime, so main is offered 2x realtime while Deepgram drains 1.25x.
    await startAndWait({ producerId: 2 })
    let liveProducerSec = 0
    const TICKS = 120 // 12s of wall time — pre-fix this reaches ~9s of lag
    for (let i = 0; i < TICKS; i++) {
      pushFrame(2)
      liveProducerSec += FRAME_SEC
      pushFrame(1) // the ghost from call 1
      await sleep(FRAME_MS)
    }

    const h = transcriptionHealth()
    expect(h).not.toBeNull()
    const health = h!

    console.log(
      `[orphan] live-producer pushed=${liveProducerSec.toFixed(1)}s ` +
        `submitted=${health.submittedSec.toFixed(1)}s lag=${health.lagSec.toFixed(2)}s ` +
        `median=${health.medianLagSec.toFixed(2)}s resets=${health.resets} tier=${health.tier}`
    )

    // THE LOAD-BEARING ASSERTION: the ghost's audio never reached the socket.
    // Pre-fix this is ~2x liveProducerSec, because main accepted both producers.
    expect(health.submittedSec).toBeLessThan(liveProducerSec * 1.2)
    // The new diagnostic counter (session-health.log / --diagnose / the health
    // event) must actually see the rejection — this is what turns "still
    // slow tomorrow" into a one-bit answer about which mechanism is at fault.
    expect(health.rejectedProducerFrames).toBe(TICKS)

    // ...and therefore lag never ratchets and words keep flowing.
    expect(health.lagSec).toBeLessThan(HEALTH_TUNING.warnLagSec)
    expect(health.medianLagSec).toBeLessThan(HEALTH_TUNING.warnLagSec)
    expect(health.resets).toBe(0)
    expect(countChannel('transcription:transcript')).toBeGreaterThan(0)

    await stopAndSettle()
  }, 120_000)

  it("ignores a ghost producer's dropped-audio reports (no phantom gap markers)", async () => {
    // A dropped-audio report is accumulated, then emitted as a gap marker by
    // the drain path the next time audio actually flows (`flushPendingShed`,
    // transcription.ts:314) — so each phase below streams a little audio to
    // give that flush its chance.
    const stream = async (ticks: number, producerId: number): Promise<void> => {
      for (let i = 0; i < ticks; i++) {
        pushFrame(producerId)
        await sleep(FRAME_MS)
      }
    }

    await startAndWait({ producerId: 7 })
    await stream(5, 7)
    const gapsBefore = countChannel('transcription:gap')

    // A ghost reporting a huge ring overrun would otherwise punch a bogus gap
    // marker into a transcript it has nothing to do with.
    reportDropped(RATE * 5, 999)
    await stream(15, 7)
    expect(countChannel('transcription:gap')).toBe(gapsBefore)

    // The real producer's report IS honoured — proving the guard rejects by
    // identity, not by rejecting everything.
    reportDropped(RATE * 5, 7)
    await stream(15, 7)
    expect(countChannel('transcription:gap')).toBeGreaterThan(gapsBefore)

    await stopAndSettle()
  }, 60_000)

  it('a session started without a producerId still accepts untagged audio', async () => {
    // Backward compatibility: every other test in this suite (and any caller
    // that never mints an id) must keep working exactly as before.
    await startAndWait({})
    for (let i = 0; i < 20; i++) {
      pushFrame(undefined)
      await sleep(FRAME_MS)
    }
    const health = transcriptionHealth()
    expect(health).not.toBeNull()
    expect(health!.submittedSec).toBeGreaterThan(1)
    await stopAndSettle()
  }, 60_000)

  it('a producer id from an EARLIER session is rejected by a later one', async () => {
    // The narrow invariant, stated directly: ids are per-recorder, and main
    // only ever honours the one the current session was started for.
    await startAndWait({ producerId: 1 })
    await stopAndSettle()

    await startAndWait({ producerId: 2 })
    const before = transcriptionHealth()!.submittedSec
    for (let i = 0; i < 20; i++) {
      pushFrame(1) // ONLY the ghost pushes
      await sleep(FRAME_MS)
    }
    const after = transcriptionHealth()!.submittedSec
    expect(after).toBe(before) // not one frame of it was accepted

    await stopAndSettle()
  }, 60_000)
})
