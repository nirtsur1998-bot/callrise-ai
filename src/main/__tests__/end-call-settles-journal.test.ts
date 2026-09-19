// BUG-285 (second half) — a throw INSIDE endCall must not leave a saved
// call's journal looking recoverable.
//
// calls.ts now runs endCall({saved:true}) as a post-save step, so a throw
// there no longer fails the save — but if the throw landed BEFORE the
// journal was marked complete, the next launch would still offer the saved
// call for recovery and recovering it would mint a duplicate Call record
// (save-in-flight-race.test.ts describes the same end state from a
// different cause). endCall's pre-journal steps are each exception-safe
// today, so this drives the property through a mock rather than a real
// failure: the consent clear is made to throw, and the journal must still
// be retired. Red on the pre-`finally` shape of endCall.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const consentClearThrows = { value: false }
vi.mock('../consent-gate', async (importOriginal) => {
  const real = await importOriginal<typeof import('../consent-gate')>()
  return {
    ...real,
    clearActiveConsent: () => {
      if (consentClearThrows.value) throw new Error('consent store unavailable')
      real.clearActiveConsent()
    }
  }
})

const { setCallJournalsDirForTests } = await import('../live/call-journal')
const { beginCall, endCall, recordResult, liveCallInfo, resetLiveTranscriptForTests } =
  await import('../live/live-transcript')
const { listRecoverableCalls } = await import('../live/live-transcript-ipc')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'end-call-settle-'))
  setCallJournalsDirForTests(dir)
  consentClearThrows.value = false
})

afterEach(() => {
  resetLiveTranscriptForTests()
  setCallJournalsDirForTests(null)
  rmSync(dir, { recursive: true, force: true })
})

function result(text: string): Parameters<typeof recordResult>[0] {
  return {
    transcript: text,
    words: [{ speaker: 0, text }],
    isFinal: true,
    speakerEpoch: 0,
    speakerCertain: true,
    minConfidence: 0.9,
    multichannel: false
  } as Parameters<typeof recordResult>[0]
}

describe('endCall settles the journal even when a step before it throws', () => {
  it('control — with nothing throwing, a saved call is not offered for recovery', async () => {
    beginCall({ restart: false })
    recordResult(result('a call that saved cleanly'))
    endCall({ saved: true })
    expect(liveCallInfo()).toBeNull()
    expect(await listRecoverableCalls()).toHaveLength(0)
  })

  it('control — the mocked throw is reachable: endCall rethrows it', () => {
    beginCall({ restart: false })
    recordResult(result('a call whose consent clear fails'))
    consentClearThrows.value = true
    expect(() => endCall({ saved: true })).toThrow('consent store unavailable')
  })

  it('the journal of a SAVED call is still marked complete when the consent clear throws', async () => {
    beginCall({ restart: false })
    recordResult(result('saved, then the consent clear failed'))
    consentClearThrows.value = true
    try {
      endCall({ saved: true })
    } catch {
      /* the throw is the caller's business (postSaveStep logs it) */
    }
    // `current` was released before the throw — the call is over either way.
    expect(liveCallInfo()).toBeNull()
    // The property: no duplicate on the next launch. Without the `finally`
    // this list holds the saved call.
    expect(await listRecoverableCalls()).toHaveLength(0)
  })

  it('an UNSAVED call whose consent clear throws stays a recovery candidate — the throw does not lose it either', async () => {
    beginCall({ restart: false })
    recordResult(result('abandoned, then the consent clear failed'))
    consentClearThrows.value = true
    try {
      endCall({ saved: false })
    } catch {
      /* same */
    }
    const recoverable = await listRecoverableCalls()
    expect(recoverable).toHaveLength(1)
  })
})
