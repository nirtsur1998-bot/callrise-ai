// BUG-290 — a recovered call didn't appear in the Past Calls list until
// reload: recoverCallForIpc saved the record but told no already-mounted
// screen to re-read (useCalls() only listens for 'backup:changed', its own
// remove(), or mount). The broadcast lives in the ipcMain.handle callback
// registered by registerLiveTranscriptIpc, not in recoverCallForIpc itself
// (which stays window-free and independently testable — see
// call-journal-recovery-steps.test.ts), so this drives a REAL interrupted
// call through the REAL IPC wiring and checks what got sent to the window.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sent: string[] = []
let registeredHandler: ((event: unknown, ...args: unknown[]) => unknown) | undefined

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getVersion: () => '1.14.0-test' },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      if (channel === 'live:recoverCall') registeredHandler = fn
    },
    on: () => {}
  },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: (ch: string) => sent.push(ch) } }
    ]
  }
}))

const { setCallJournalsDirForTests } = await import('../live/call-journal')
const { beginCall, recordResult, resetLiveTranscriptForTests } = await import(
  '../live/live-transcript'
)
const { listRecoverableCalls, registerLiveTranscriptIpc } = await import(
  '../live/live-transcript-ipc'
)

let dir: string
let callsDir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'journal-bug290-'))
  callsDir = mkdtempSync(join(tmpdir(), 'calls-bug290-'))
  setCallJournalsDirForTests(dir)
  sent.length = 0
  registeredHandler = undefined
  registerLiveTranscriptIpc(() => callsDir)
})

afterEach(() => {
  resetLiveTranscriptForTests()
  setCallJournalsDirForTests(null)
  rmSync(dir, { recursive: true, force: true })
  rmSync(callsDir, { recursive: true, force: true })
})

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

describe('live:recoverCall broadcasts backup:changed on success (BUG-290)', () => {
  it('a real recovered call broadcasts so an already-mounted Past Calls list re-reads', async () => {
    const id = await interruptedCall()
    expect(registeredHandler).toBeTruthy()

    const result = (await registeredHandler!({}, id)) as { ok: boolean }

    expect(result.ok).toBe(true)
    expect(sent).toEqual(['backup:changed'])
  })

  it('does NOT broadcast when there is nothing to recover - nothing changed on disk to re-read', async () => {
    const result = (await registeredHandler!({}, 'no-such-journal')) as { ok: boolean }

    expect(result.ok).toBe(false)
    expect(sent).toEqual([])
  })
})
