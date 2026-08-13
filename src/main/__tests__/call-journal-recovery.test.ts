// M26 Phase 4.2 — the scenarios, not the mechanism.
//
// The bar for this phase is not "the journal writer writes lines". It is:
//   - force-quit mid-call, relaunch, and the transcript is recoverable
//   - the renderer dies mid-call and the same holds
//   - journaling can never break a call, whatever the disk does
//   - recovery is conservative: it never invents a call, and never silently
//     throws one away
// So these tests drive the real entry points the live call uses, kill the
// process the way a crash would (by simply never running the shutdown path),
// and then check what a fresh launch can actually recover.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const {
  setCallJournalsDirForTests,
  listOrphanJournals,
  readJournal,
  replayJournal,
  discardJournal
} = await import('../live/call-journal')

const {
  beginCall,
  recordResult,
  recordGap,
  recordConsent,
  recordRepIdentified,
  endCall,
  currentTranscript,
  resetLiveTranscriptForTests
} = await import('../live/live-transcript')

const { listRecoverableCalls, recoverCall } = await import('../live/live-transcript-ipc')
const { getCall, listCalls } = await import('../calls-fs')

let dir: string
let callsDir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'journal-test-'))
  callsDir = mkdtempSync(join(tmpdir(), 'calls-test-'))
  setCallJournalsDirForTests(dir)
})

afterEach(() => {
  resetLiveTranscriptForTests()
  setCallJournalsDirForTests(null)
  rmSync(dir, { recursive: true, force: true })
  rmSync(callsDir, { recursive: true, force: true })
})

type Word = { speaker: number; text: string; channel?: number }

function result(words: Word[], over: Record<string, unknown> = {}): Parameters<
  typeof recordResult
>[0] {
  return {
    transcript: words.map((w) => w.text).join(' '),
    words,
    isFinal: true,
    speakerEpoch: 0,
    speakerCertain: true,
    minConfidence: 0.9,
    multichannel: false,
    ...over
  } as Parameters<typeof recordResult>[0]
}

/** The whole point: a crash runs NO shutdown code. So "crashing" in these
 *  tests means dropping the in-memory state without calling endCall — exactly
 *  what a kill -9 or a power cut does. */
function crash(): void {
  resetLiveTranscriptForTests()
}

/** The single journal file on disk. Note the `call-journals` subdirectory —
 *  the configured dir is the userData root, not the journal folder itself. */
function journalFile(): string {
  const folder = join(dir, 'call-journals')
  const name = readdirSync(folder).find((f) => f.endsWith('.jsonl'))
  if (!name) throw new Error('no journal was written')
  return join(folder, name)
}

/** A fresh launch sees only what is on disk. */
async function afterRelaunch(): Promise<Awaited<ReturnType<typeof listRecoverableCalls>>> {
  return listRecoverableCalls()
}

describe('force-quit mid-call → relaunch → transcript recoverable', () => {
  it('recovers the words that were spoken before the process died', async () => {
    beginCall({ restart: false })
    recordResult(result([{ speaker: 0, text: 'thanks for taking the time' }]))
    recordResult(result([{ speaker: 1, text: 'happy to be here' }]))
    recordResult(result([{ speaker: 0, text: 'let me walk you through pricing' }]))
    crash()

    const found = await afterRelaunch()
    expect(found).toHaveLength(1)
    expect(found[0].segmentCount).toBe(3)
    expect(found[0].preview).toContain('thanks for taking the time')
    expect(found[0].preview).toContain('happy to be here')
  })

  it('turns one into a real saved call, with the transcript intact', async () => {
    beginCall({ restart: false })
    recordResult(result([{ speaker: 0, text: 'first thing' }]))
    recordResult(result([{ speaker: 1, text: 'second thing' }]))
    crash()

    const [found] = await afterRelaunch()
    const summary = await recoverCall(found.id, callsDir)
    expect(summary).not.toBeNull()

    const saved = await getCall(callsDir, summary!.id)
    expect(saved?.segments.map((s) => s.text)).toEqual(['first thing', 'second thing'])
    // It is a real call, indistinguishable from a normally-saved one.
    expect(await listCalls(callsDir)).toHaveLength(1)
  })

  it('a recovered call is no longer offered a second time', async () => {
    beginCall({ restart: false })
    recordResult(result([{ speaker: 0, text: 'only once' }]))
    crash()

    const [found] = await afterRelaunch()
    await recoverCall(found.id, callsDir)
    expect(await afterRelaunch()).toHaveLength(0)
  })

  it('keeps gaps and rep attribution, so a recovered call reads like the live one', async () => {
    beginCall({ restart: false })
    recordResult(result([{ speaker: 0, text: 'before the drop' }]))
    recordGap('[gap: 12s]')
    recordResult(result([{ speaker: 1, text: 'after the drop' }]))
    recordRepIdentified(0, 0)
    // The live copy is the reference — recovery must reproduce it exactly.
    const live = JSON.stringify(currentTranscript())
    crash()

    const journal = await readJournal((await listOrphanJournals())[0].id)
    expect(JSON.stringify(replayJournal(journal!).segments)).toBe(live)
    expect(replayJournal(journal!).segments.some((s) => s.kind === 'gap')).toBe(true)
    expect(replayJournal(journal!).segments[0].role).toBe('rep')
  })
})

describe('renderer crash mid-call', () => {
  // Main survives a renderer crash, so its accumulator and journal are still
  // live. What makes the call recoverable is that the renderer's reload starts
  // a NEW call, which retires the old one as unsaved rather than continuing it.
  it('the abandoned call becomes recoverable when the renderer starts over', async () => {
    beginCall({ restart: false })
    recordResult(result([{ speaker: 0, text: 'said before the renderer died' }]))

    // Renderer reloads and begins a fresh call. NOT a restart — from the
    // renderer's point of view there is no session to continue.
    beginCall({ restart: false })
    recordResult(result([{ speaker: 0, text: 'the call after the crash' }]))
    endCall({ saved: true }) // ...and this one ends normally

    // Exactly one interrupted call is offered: the one the crash orphaned.
    // The call that followed it saved fine and must not be offered.
    const found = await afterRelaunch()
    expect(found).toHaveLength(1)
    expect(found[0].preview).toContain('said before the renderer died')
    expect(found[0].preview).not.toContain('the call after the crash')
  })
})

describe('journaling can never break a call', () => {
  it('survives an unwritable journal directory and keeps accumulating', () => {
    // A path that cannot be created (a file where the directory should be) is
    // the cheapest honest stand-in for a full disk or a permissions failure.
    const blocker = join(tmpdir(), `journal-blocker-${Date.now()}`)
    writeFileSync(blocker, 'not a directory')
    setCallJournalsDirForTests(blocker)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => {
        beginCall({ restart: false })
        recordResult(result([{ speaker: 0, text: 'the call goes on' }]))
        recordGap('[gap: 3s]')
        recordRepIdentified(0, 0)
        recordConsent(null)
        endCall({ saved: true })
      }).not.toThrow()
    } finally {
      err.mockRestore()
      rmSync(blocker, { force: true })
    }
  })

  it('still builds the in-memory transcript when the journal cannot be written', () => {
    const blocker = join(tmpdir(), `journal-blocker2-${Date.now()}`)
    writeFileSync(blocker, 'not a directory')
    setCallJournalsDirForTests(blocker)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      beginCall({ restart: false })
      recordResult(result([{ speaker: 0, text: 'still here' }]))
      // The live call is completely unaffected — it simply has no safety net.
      expect(currentTranscript().map((s) => s.text)).toEqual(['still here'])
    } finally {
      err.mockRestore()
      rmSync(blocker, { force: true })
    }
  })
})

describe('a torn journal — the crash interrupted a write', () => {
  it('keeps every complete line and reports that the tail was lost', async () => {
    beginCall({ restart: false })
    recordResult(result([{ speaker: 0, text: 'complete line one' }]))
    recordResult(result([{ speaker: 1, text: 'complete line two' }]))
    crash()

    // Simulate the process dying mid-write: a trailing fragment of JSON.
    const path = journalFile()
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"t":"result","at":900,"p":{"trans`)

    const found = await afterRelaunch()
    expect(found).toHaveLength(1)
    expect(found[0].segmentCount).toBe(2)
    expect(found[0].truncated).toBe(true)
    expect(found[0].preview).toContain('complete line two')
  })

  it('a journal with no readable header is not offered as a call', async () => {
    beginCall({ restart: false })
    recordResult(result([{ speaker: 0, text: 'doomed' }]))
    crash()
    writeFileSync(journalFile(), 'garbage not json\n')
    expect(await afterRelaunch()).toHaveLength(0)
  })
})

describe('recovery is conservative', () => {
  it('a normally-saved call is never offered for recovery', async () => {
    beginCall({ restart: false })
    recordResult(result([{ speaker: 0, text: 'saved properly' }]))
    endCall({ saved: true })
    expect(await afterRelaunch()).toHaveLength(0)
  })

  it('a call where nobody spoke is never offered — no phantom records', async () => {
    beginCall({ restart: false })
    recordResult(result([], { transcript: 'partial', isFinal: false }))
    recordConsent(null)
    crash()
    expect(await afterRelaunch()).toHaveLength(0)
  })

  it('a mono↔multichannel restart is ONE call, not two', async () => {
    beginCall({ restart: false })
    recordResult(result([{ speaker: 0, text: 'mic only' }]))
    // Buyer capture switched on mid-call: main disposes and recreates its
    // Session, but the rep is on the same call and the renderer keeps one
    // transcript. A second journal here would prompt about a call that saved
    // perfectly well.
    beginCall({ restart: true })
    recordResult(
      result([{ speaker: 0, text: 'now with buyer', channel: 0 }], { multichannel: true })
    )
    crash()

    const found = await afterRelaunch()
    expect(found).toHaveLength(1)
    expect(found[0].preview).toContain('mic only')
    expect(found[0].preview).toContain('now with buyer')
  })

  it('declining removes it for good', async () => {
    beginCall({ restart: false })
    recordResult(result([{ speaker: 0, text: 'not wanted' }]))
    crash()
    const [found] = await afterRelaunch()
    await discardJournal(found.id)
    expect(await afterRelaunch()).toHaveLength(0)
  })

  it('two interrupted calls are both offered, oldest first', async () => {
    // Fake time so the two calls are genuinely minutes apart, as they would be
    // in reality. Without it both journals get the same millisecond stamp and
    // the ordering assertion is decided by readdir order, not by the sort.
    vi.useFakeTimers()
    try {
      beginCall({ restart: false })
      recordResult(result([{ speaker: 0, text: 'call one' }]))
      crash()
      vi.advanceTimersByTime(10 * 60_000)
      beginCall({ restart: false })
      recordResult(result([{ speaker: 0, text: 'call two' }]))
      crash()

      const found = await afterRelaunch()
      expect(found).toHaveLength(2)
      expect(found[0].preview).toContain('call one')
      expect(found[1].preview).toContain('call two')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('consent survives recovery', () => {
  // The hazard: applyConsentRetention strips every channel-tagged buyer
  // segment from a call whose recordOtherParty is not true. A recovered
  // buyer-capture call that lost its consent record would therefore have the
  // buyer's entire half deleted at the moment of rescue — silently.
  const CONSENTED = {
    status: 'consented' as const,
    jurisdiction: 'two-party' as const,
    recordOtherParty: true,
    method: 'verbal-on-call' as const
  }

  it('keeps the buyer’s side of a consented buyer-capture call', async () => {
    beginCall({ restart: false })
    recordConsent(CONSENTED)
    recordResult(
      result(
        [
          { speaker: 0, text: 'rep talking', channel: 0 },
          { speaker: 1, text: 'buyer talking', channel: 1 }
        ],
        { multichannel: true }
      )
    )
    crash()

    const [found] = await afterRelaunch()
    const summary = await recoverCall(found.id, callsDir)
    const saved = await getCall(callsDir, summary!.id)
    expect(saved?.segments.map((s) => s.text)).toEqual(['rep talking', 'buyer talking'])
    expect(saved?.consent?.recordOtherParty).toBe(true)
  })

  it('honours a mid-call revocation — last consent state wins', async () => {
    beginCall({ restart: false })
    recordConsent(CONSENTED)
    recordResult(
      result(
        [
          { speaker: 0, text: 'rep talking', channel: 0 },
          { speaker: 1, text: 'buyer talking', channel: 1 }
        ],
        { multichannel: true }
      )
    )
    recordConsent(null) // rep switched recording off
    crash()

    const [found] = await afterRelaunch()
    const summary = await recoverCall(found.id, callsDir)
    const saved = await getCall(callsDir, summary!.id)
    // The buyer's turn is gone, the rep's remains — the same outcome a
    // normally-saved revoked call gets.
    expect(saved?.segments.map((s) => s.text)).toEqual(['rep talking'])
  })

  it('a mic-only call recovers fully even with no consent record at all', async () => {
    beginCall({ restart: false })
    recordResult(result([{ speaker: 0, text: 'mono words' }, { speaker: 1, text: 'more mono' }]))
    crash()

    const [found] = await afterRelaunch()
    const summary = await recoverCall(found.id, callsDir)
    const saved = await getCall(callsDir, summary!.id)
    // Mono is never stripped (BUG-002) — diarization labels are a guess, and
    // there is no real second party on a mic-only call to protect.
    expect(saved?.segments).toHaveLength(2)
  })
})

describe('the recovered call carries a real duration', () => {
  it('derives it from the journal rather than saving a zero', async () => {
    vi.useFakeTimers()
    try {
      beginCall({ restart: false })
      recordResult(result([{ speaker: 0, text: 'start' }]))
      vi.advanceTimersByTime(65_000)
      recordResult(result([{ speaker: 1, text: 'end' }]))
      crash()
      const [found] = await afterRelaunch()
      expect(found.durationMs).toBeGreaterThanOrEqual(65_000)
    } finally {
      vi.useRealTimers()
    }
  })
})
