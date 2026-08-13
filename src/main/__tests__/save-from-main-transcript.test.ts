// M26 Phase 4.3 — what gets WRITTEN to disk comes from main's transcript.
//
// The renderer still sends its mirror, and it is still what decides WHETHER to
// save at all. But the bytes are main's, and that is what makes the whole
// phase mean anything: a renderer that missed a patch, was mid-remount, or
// crashed and re-attached must not be able to persist a shorter transcript
// than the one that actually happened.
//
// These drive saveCall through the same substitution the IPC handler performs,
// rather than through Electron's ipcMain (which cannot be invoked from a test),
// so the assertion is about the real transformation and not a mock of it.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const { setCallJournalsDirForTests } = await import('../live/call-journal')
const {
  beginCall,
  recordResult,
  endCall,
  currentTranscript,
  liveCallInfo,
  resetLiveTranscriptForTests
} = await import('../live/live-transcript')
const { saveCall, getCall } = await import('../calls-fs')
import type { CallSaveInput } from '../calls-fs'

let journalsDir: string
let callsDir: string

beforeEach(() => {
  journalsDir = mkdtempSync(join(tmpdir(), 'save-journal-'))
  callsDir = mkdtempSync(join(tmpdir(), 'save-calls-'))
  setCallJournalsDirForTests(journalsDir)
})

afterEach(() => {
  resetLiveTranscriptForTests()
  setCallJournalsDirForTests(null)
  rmSync(journalsDir, { recursive: true, force: true })
  rmSync(callsDir, { recursive: true, force: true })
})

function result(text: string, over: Record<string, unknown> = {}): Parameters<
  typeof recordResult
>[0] {
  return {
    transcript: text,
    words: [{ speaker: 0, text }],
    isFinal: true,
    speakerEpoch: 0,
    speakerCertain: true,
    minConfidence: 0.9,
    multichannel: false,
    ...over
  } as Parameters<typeof recordResult>[0]
}

/** The exact substitution performed inside the `calls:save` handler. Kept
 *  identical to calls.ts on purpose — if that changes, this must too, and a
 *  diff between the two is the signal. */
function effectiveInput(input: CallSaveInput): CallSaveInput {
  const live = liveCallInfo()
  return live
    ? {
        ...input,
        segments: currentTranscript(),
        startedAt: input?.startedAt || live.startedAt,
        durationMs:
          Number.isFinite(input?.durationMs) && input.durationMs > 0
            ? input.durationMs
            : Math.max(0, Date.now() - live.startedAtMs)
      }
    : input
}

describe('the saved transcript is main’s, not the renderer’s', () => {
  it('persists main’s copy even when the renderer’s payload is short', async () => {
    beginCall({ restart: false })
    recordResult(result('the first thing that was said'))
    recordResult(result('and the second', { words: [{ speaker: 1, text: 'and the second' }] }))

    // A renderer that missed the second patch — remounting, mid-navigation, or
    // simply behind. Before 4.3 this is exactly what would have been written.
    const summary = await saveCall(
      callsDir,
      effectiveInput({
        startedAt: new Date().toISOString(),
        durationMs: 1000,
        segments: [{ speaker: 0, text: 'the first thing that was said' }]
      })
    )
    const saved = await getCall(callsDir, summary.id)
    expect(saved?.segments.map((s) => s.text)).toEqual([
      'the first thing that was said',
      'and the second'
    ])
  })

  it('includes words that finalized AFTER the renderer armed its save', async () => {
    // BUG-053's scenario, from main's side: Stop is pressed, Deepgram's
    // Finalize delivers the last words during the flush window, and they must
    // be in the file.
    beginCall({ restart: false })
    recordResult(result('before stop'))
    const rendererPayload: CallSaveInput = {
      startedAt: new Date().toISOString(),
      durationMs: 5000,
      segments: [{ speaker: 0, text: 'before stop' }]
    }
    recordResult(result('after stop, in the flush', { speakerEpoch: 1 }))

    const summary = await saveCall(callsDir, effectiveInput(rendererPayload))
    const saved = await getCall(callsDir, summary.id)
    expect(saved?.segments.map((s) => s.text)).toEqual(['before stop', 'after stop, in the flush'])
  })

  it('falls back to the payload entirely when no call is live in main', async () => {
    // Recovery and the existing tests both go through this path. Nothing that
    // worked before 4.3 may regress because main happens to have no session.
    expect(liveCallInfo()).toBeNull()
    const summary = await saveCall(
      callsDir,
      effectiveInput({
        startedAt: new Date().toISOString(),
        durationMs: 2000,
        segments: [{ speaker: 0, text: 'from the payload alone' }]
      })
    )
    const saved = await getCall(callsDir, summary.id)
    expect(saved?.segments.map((s) => s.text)).toEqual(['from the payload alone'])
    expect(saved?.durationMs).toBe(2000)
  })

  it('fills a missing duration from main — a view that attached mid-call has none', async () => {
    vi.useFakeTimers()
    try {
      beginCall({ restart: false })
      recordResult(result('words'))
      vi.advanceTimersByTime(90_000)
      const summary = await saveCall(
        callsDir,
        effectiveInput({ startedAt: '', durationMs: 0, segments: [] })
      )
      const saved = await getCall(callsDir, summary.id)
      expect(saved?.durationMs).toBeGreaterThanOrEqual(90_000)
      expect(saved?.segments.map((s) => s.text)).toEqual(['words'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('never overrides a duration the renderer did supply', async () => {
    beginCall({ restart: false })
    recordResult(result('words'))
    const summary = await saveCall(
      callsDir,
      effectiveInput({
        startedAt: '2026-01-01T00:00:00.000Z',
        durationMs: 4242,
        segments: []
      })
    )
    const saved = await getCall(callsDir, summary.id)
    expect(saved?.durationMs).toBe(4242)
    // saveCall records the start as `createdAt`; there is no `startedAt` on a
    // stored Call.
    expect(saved?.createdAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('main’s segments survive the save sanitizer unchanged', async () => {
    // sanitizeSegments clamps speaker ids, drops blank text and enforces the
    // channel domain. Main's accumulator output has to already satisfy all of
    // it, or the saved transcript quietly differs from the displayed one.
    beginCall({ restart: false })
    recordResult(
      result('rep side', {
        words: [{ speaker: 0, text: 'rep side', channel: 0 }],
        multichannel: true
      })
    )
    recordResult(
      result('buyer side', {
        words: [{ speaker: 1, text: 'buyer side', channel: 1 }],
        multichannel: true
      })
    )
    const before = currentTranscript()
    const summary = await saveCall(
      callsDir,
      effectiveInput({
        startedAt: new Date().toISOString(),
        durationMs: 1,
        segments: [],
        consent: {
          status: 'consented',
          jurisdiction: 'two-party',
          recordOtherParty: true,
          method: 'verbal-on-call'
        }
      })
    )
    const saved = await getCall(callsDir, summary.id)
    // toEqual, not JSON.stringify: sanitizeSegments rebuilds each object in
    // its own field order, and always did — the renderer's segments went
    // through exactly the same rebuild before 4.3, so the bytes on disk are
    // unchanged. What matters here is that nothing was dropped, clamped or
    // altered on the way through.
    expect(saved?.segments).toEqual(before)
    expect(saved?.segments).toHaveLength(2)
  })

  it('a saved call still retires its journal', async () => {
    beginCall({ restart: false })
    recordResult(result('done'))
    const id = liveCallInfo()!.callId
    await saveCall(
      callsDir,
      effectiveInput({ startedAt: new Date().toISOString(), durationMs: 1, segments: [] })
    )
    endCall({ saved: true })
    const { listRecoverableCalls } = await import('../live/live-transcript-ipc')
    const recoverable = await listRecoverableCalls()
    expect(recoverable.find((r) => r.id === id)).toBeUndefined()
  })
})
