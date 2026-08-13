// M26 Phase 4.4 — the race main gaining its own end-of-call trigger opens up.
//
// Before 4.4, endCall({saved:true}) was called from exactly one place: the
// calls:save handler, after a successful save. There was never a second,
// concurrent caller. Once main can independently decide a call is over WHILE
// a save is still in flight — render-process-gone firing mid-await, or a
// fault threshold tripping — that stops being true.
//
// THE FAILURE THIS PREVENTS: render-process-gone fires during an in-flight
// save. Without a guard, it calls endCall({saved:false}) and nulls `current`
// FIRST. The save then resolves successfully and calls endCall({saved:true})
// against an already-null `current` — a no-op, per endCall's own `if
// (!call) return`. The journal never gets its `.done` marker despite a real
// Call record now existing on disk. Next launch, it's offered as
// "recoverable" — and recovering it mints a SECOND Call record for the same
// conversation, with a fresh randomUUID(), silently.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const { setCallJournalsDirForTests } = await import('../live/call-journal')
const {
  beginCall,
  beginSave,
  endSave,
  endCall,
  recordResult,
  liveCallInfo,
  resetLiveTranscriptForTests
} = await import('../live/live-transcript')
const { listRecoverableCalls } = await import('../live/live-transcript-ipc')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'save-race-'))
  setCallJournalsDirForTests(dir)
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

describe('a save in flight wins the race against a concurrent main-initiated endCall', () => {
  it('a saved:false landing mid-save is deferred, and the save’s own saved:true still lands', () => {
    beginCall({ restart: false })
    recordResult(result('the call in progress'))
    const callId = liveCallInfo()!.callId

    // The save begins (mirrors calls.ts's beginSave() before `await
    // saveCall(...)`) — this is the window render-process-gone/failSession
    // can now land in, that never existed before 4.4.
    beginSave()

    // render-process-gone fires mid-await. Without the guard this would null
    // `current` right here.
    endCall({ saved: false })

    // `current` must survive — the in-flight save is what gets to decide.
    expect(liveCallInfo()?.callId).toBe(callId)

    // The save resolves successfully (mirrors calls.ts's finally { endSave() }
    // followed by its own endCall({saved:true})).
    endSave()
    endCall({ saved: true })

    // `current` is null now, from the REAL completion, not the earlier
    // deferred attempt.
    expect(liveCallInfo()).toBeNull()
  })

  it('without the guard this would leave the journal recoverable after a real save — proving the fix matters', async () => {
    // Same sequence, but observed the way a rep would experience it: does the
    // journal end up looking "still needs saving" (bad) or properly retired
    // (good) after a save that actually succeeded?
    beginCall({ restart: false })
    recordResult(result('a call that really did save'))

    beginSave()
    endCall({ saved: false }) // the race
    endSave()
    endCall({ saved: true }) // the real completion

    // A properly-retired journal is not offered for recovery at all — if the
    // guard had failed, this call would show up here, and "recovering" it
    // would mint a duplicate Call record for a conversation that already
    // saved cleanly.
    const recoverable = await listRecoverableCalls()
    expect(recoverable).toHaveLength(0)
  })

  it('a saved:false with NO save in flight behaves exactly as before — the common case is untouched', () => {
    beginCall({ restart: false })
    recordResult(result('an ordinary crash, nothing being saved'))
    const callId = liveCallInfo()!.callId

    endCall({ saved: false }) // no beginSave() ever called — the ordinary path
    expect(liveCallInfo()).toBeNull()
    void callId
  })

  it('two genuine saves in a row are unaffected — the latch is not sticky across calls', () => {
    beginCall({ restart: false })
    recordResult(result('first call'))
    beginSave()
    endSave()
    endCall({ saved: true })
    expect(liveCallInfo()).toBeNull()

    beginCall({ restart: false })
    recordResult(result('second call'))
    beginSave()
    endSave()
    endCall({ saved: true })
    expect(liveCallInfo()).toBeNull()
  })
})
