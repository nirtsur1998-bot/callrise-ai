// BUG-271 — the recovery path used to have ONE exit. Reading the journal,
// replaying it, writing the Call record, marking the journal, retiring it:
// any throw anywhere became `{ ok: false }`, so "a tidy-up step stumbled AFTER
// the call was saved" and "this call could not be saved" were the same answer
// — and the first of those left an unmarked orphan journal behind a saved
// call, which the next "Save this call" turned into a duplicate.
//
// Same harness as call-journal-recovery.test.ts (real filesystem, real journal
// writer, a "crash" is simply never running the shutdown path). The only thing
// faked is the FAILURE: one switchable throw per step, wrapped around the real
// implementation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fail = vi.hoisted(() => ({
  markRecovered: false,
  retire: false,
  readJournal: false,
  readCall: false,
  save: false
}))

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '1.14.0-test' } }))

vi.mock('../live/call-journal', async (importOriginal) => {
  const real = await importOriginal<typeof import('../live/call-journal')>()
  return {
    ...real,
    markJournalRecoveredAsCall: async (id: string, callId: string) => {
      if (fail.markRecovered) throw new Error('EPERM: marker could not be written')
      return real.markJournalRecoveredAsCall(id, callId)
    },
    retireJournal: async (id: string) => {
      if (fail.retire) throw new Error('EBUSY: journal is locked')
      return real.retireJournal(id)
    },
    readJournal: async (id: string) => {
      if (fail.readJournal) throw new Error('EIO: journal unreadable')
      return real.readJournal(id)
    }
  }
})

vi.mock('../calls-fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../calls-fs')>()
  return {
    ...real,
    saveCall: async (...args: Parameters<typeof real.saveCall>) => {
      if (fail.save) throw new Error('ENOSPC: no space left on device')
      return real.saveCall(...args)
    },
    getCall: async (...args: Parameters<typeof real.getCall>) => {
      if (fail.readCall) throw new Error('EIO: call record unreadable')
      return real.getCall(...args)
    }
  }
})

const { setCallJournalsDirForTests } = await import('../live/call-journal')
const { beginCall, recordResult, resetLiveTranscriptForTests } =
  await import('../live/live-transcript')
const { listRecoverableCalls, recoverCall, recoverCallDetailed, recoverCallForIpc } =
  await import('../live/live-transcript-ipc')
const { listCalls } = await import('../calls-fs')

let dir: string
let callsDir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'journal-steps-'))
  callsDir = mkdtempSync(join(tmpdir(), 'calls-steps-'))
  setCallJournalsDirForTests(dir)
  fail.markRecovered = fail.retire = fail.readJournal = fail.readCall = fail.save = false
})

afterEach(() => {
  resetLiveTranscriptForTests()
  setCallJournalsDirForTests(null)
  rmSync(dir, { recursive: true, force: true })
  rmSync(callsDir, { recursive: true, force: true })
})

/** One interrupted call on disk; returns its journal id. */
async function interruptedCall(): Promise<string> {
  beginCall({ restart: false })
  recordResult({
    transcript: 'let me walk you through pricing',
    words: [{ speaker: 0, text: 'let me walk you through pricing' }],
    isFinal: true,
    speakerEpoch: 0,
    speakerCertain: true,
    minConfidence: 0.9,
    multichannel: false
  } as Parameters<typeof recordResult>[0])
  resetLiveTranscriptForTests() // the crash: no shutdown path runs
  const [found] = await listRecoverableCalls()
  if (!found) throw new Error('the harness did not produce a recoverable call')
  return found.id
}

describe('a CLEANUP step failing can no longer cost the rescue', () => {
  it('marker write fails AFTER the save: the rep is told the call was saved, and it is not offered again', async () => {
    const id = await interruptedCall()
    fail.markRecovered = true

    const res = await recoverCallForIpc(id, callsDir)

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.degraded).toEqual(['mark-recovered'])
    expect(await listCalls(callsDir)).toHaveLength(1)
    // The part that used to go wrong next: with no marker AND a journal still
    // on disk, a second "Save this call" minted a duplicate. Retirement still
    // ran, so there is nothing left to offer.
    expect(await listRecoverableCalls()).toHaveLength(0)
  })

  it('marker AND retire both fail: still reported as saved, with both stumbles named', async () => {
    const id = await interruptedCall()
    fail.markRecovered = true
    fail.retire = true

    const res = await recoverCallDetailed(id, callsDir)

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.degraded).toEqual(['mark-recovered', 'retire-journal'])
    expect(await listCalls(callsDir)).toHaveLength(1)
  })

  it('retire fails but the marker landed: a second attempt returns the SAME call, not a duplicate', async () => {
    const id = await interruptedCall()
    fail.retire = true
    const first = await recoverCallDetailed(id, callsDir)
    expect(first.ok).toBe(true)

    fail.retire = false
    const second = await recoverCallDetailed(id, callsDir)

    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.call.id).toBe(first.call.id)
    expect(await listCalls(callsDir)).toHaveLength(1)
  })

  it('a clean recovery reports no stumbles', async () => {
    const id = await interruptedCall()
    const res = await recoverCallDetailed(id, callsDir)
    expect(res).toMatchObject({ ok: true, degraded: [] })
  })
})

describe('a DECIDING step failing says which one, and loses nothing', () => {
  it('the save fails: step "save", the cause in the message, no call minted, still offered', async () => {
    const id = await interruptedCall()
    fail.save = true

    const res = await recoverCallForIpc(id, callsDir)

    expect(res).toEqual({
      ok: false,
      reason: 'step-failed',
      step: 'save',
      message: 'ENOSPC: no space left on device'
    })
    expect(await listCalls(callsDir)).toHaveLength(0)
    expect((await listRecoverableCalls()).map((r) => r.id)).toEqual([id])
  })

  it('…and the same call saves on the next attempt, once the cause is gone', async () => {
    const id = await interruptedCall()
    fail.save = true
    await recoverCallForIpc(id, callsDir)

    fail.save = false
    const retry = await recoverCallForIpc(id, callsDir)

    expect(retry.ok).toBe(true)
    expect(await listCalls(callsDir)).toHaveLength(1)
  })

  it('the journal cannot be read: step "read-journal", not the same answer as a failed save', async () => {
    const id = await interruptedCall()
    fail.readJournal = true

    const res = await recoverCallForIpc(id, callsDir)

    expect(res).toMatchObject({ ok: false, reason: 'step-failed', step: 'read-journal' })
  })

  it('an ALREADY-recovered call whose saved copy cannot be opened: step "read-call", not "read-journal"', async () => {
    // First attempt saves the call and lands the marker, but retirement fails
    // — the state a second attempt meets through the idempotency branch.
    const id = await interruptedCall()
    fail.retire = true
    const first = await recoverCallDetailed(id, callsDir)
    expect(first.ok).toBe(true)
    fail.retire = false

    // Now the SAVED CALL is unreadable. The recording is fine; the sentence
    // the rep gets must say which one it was.
    fail.readCall = true
    const res = await recoverCallForIpc(id, callsDir)

    expect(res).toMatchObject({
      ok: false,
      reason: 'step-failed',
      step: 'read-call',
      message: 'EIO: call record unreadable'
    })
    // Nothing minted twice, nothing lost: the one call is still there.
    expect(await listCalls(callsDir)).toHaveLength(1)
  })
})

describe('non-failures stay non-failures', () => {
  it('an id with no journal is "nothing-to-recover", not a failed step', async () => {
    expect(await recoverCallForIpc('no-such-journal', callsDir)).toEqual({
      ok: false,
      reason: 'nothing-to-recover'
    })
  })

  it('a malformed request is named as one', async () => {
    expect(await recoverCallForIpc(undefined, callsDir)).toEqual({
      ok: false,
      reason: 'bad-request'
    })
    expect(await recoverCallForIpc('', callsDir)).toEqual({ ok: false, reason: 'bad-request' })
  })
})

describe('recoverCall keeps its original contract for its existing callers', () => {
  it('returns null when there is nothing to recover', async () => {
    expect(await recoverCall('no-such-journal', callsDir)).toBeNull()
  })

  it('throws the ORIGINAL error when a deciding step fails', async () => {
    const id = await interruptedCall()
    fail.save = true
    await expect(recoverCall(id, callsDir)).rejects.toThrow('ENOSPC')
  })
})
