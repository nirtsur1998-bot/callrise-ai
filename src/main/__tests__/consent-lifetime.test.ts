// 1.2.6 hotfix (privacy) — buyer-capture consent dies with its call.
//
// THE BUG. clearActiveConsent() ran at app start, on an explicit revoke, and
// when a grant was persisted as "off" — never at call end. So a grant for
// call A stayed on disk after call A finished. The audio path's two gate
// checks (loopback.ts's arm, and the display-media grant) ask only "is there
// ANY active consent?", never "consent for WHICH call?" — unlike every AI
// path, which passes its id and binds. A later call in the same app session
// could therefore arm and be granted buyer capture on the previous call's
// consent.
//
// Confirmed end-to-end before the fix, through these same doors — the real
// IPC handlers and the real display-media callback — not inferred from
// reading. These tests enter the same way.
//
// SCOPE, deliberately. This closes the LIFETIME half only. The binding half
// (making the audio checks name the call they mean) lands in 1.3.0, where
// consent is keyed on callId. Binding to sessionId HERE would refuse capture
// after an ordinary mono<->multichannel restart, which mints a fresh session
// id mid-call — trading an invisible leak for capture that visibly dies in
// front of a buyer. The third describe block below exists to prove this fix
// does not make that trade by accident.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir: string

const syncHandlers = new Map<string, (event: { returnValue?: unknown }, ...a: unknown[]) => void>()
let displayMediaHandler:
  | ((req: unknown, cb: (opts: Record<string, unknown>) => void) => void)
  | null = null

vi.mock('electron', () => ({
  app: { getPath: () => dir },
  shell: { openExternal: vi.fn() },
  desktopCapturer: { getSources: vi.fn(async () => [{ id: 'screen:0', name: 'Screen 1' }]) },
  ipcMain: {
    on: (channel: string, fn: (event: { returnValue?: unknown }, ...a: unknown[]) => void) => {
      syncHandlers.set(channel, fn)
    },
    handle: vi.fn()
  },
  session: {
    defaultSession: {
      setDisplayMediaRequestHandler: (
        fn: (req: unknown, cb: (opts: Record<string, unknown>) => void) => void
      ) => {
        displayMediaHandler = fn
      }
    }
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

const allowOtherPartyRecording = { value: true }
vi.mock('../app-settings', () => ({
  loadAppSettings: () => ({ allowOtherPartyRecording: allowOtherPartyRecording.value }),
  isSalesBrainEnabled: () => false
}))

const { registerLoopbackCapture } = await import('../loopback')
const { setConsentGateDirForTests } = await import('../consent-gate')
const { beginCall, endCall } = await import('../live/live-transcript')

const CONSENTED = {
  status: 'consented',
  jurisdiction: 'two-party',
  method: 'verbal-on-call',
  recordOtherParty: true
}
const SESSION_A = 101
const SESSION_B = 202

/** The renderer's real move — sendSync('consent:persist', {...}). Entering
 *  here rather than at persistActiveConsent() is the point: production
 *  derives the id and sends it, it never hands the gate a literal. */
function rendererPersists(sessionId: number, consent: unknown): boolean {
  const ev: { returnValue?: unknown } = {}
  syncHandlers.get('consent:persist')!(ev, { sessionId, consent })
  return ev.returnValue === true
}

function rendererArms(): boolean {
  const ev: { returnValue?: unknown } = {}
  syncHandlers.get('loopback:arm')!(ev)
  return ev.returnValue === true
}

/** Chromium asking for the stream. ASYNC because the grant path awaits
 *  desktopCapturer.getSources() before calling back — a synchronous read
 *  always sees "denied" and would make every assertion here vacuous. */
async function chromiumRequestsCapture(): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    displayMediaHandler!({}, (opts) => resolve(Boolean(opts && 'audio' in opts)))
  })
}

const gateFile = (): string => join(dir, 'active-consent.json')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'callrise-consent-lifetime-'))
  setConsentGateDirForTests(dir)
  syncHandlers.clear()
  displayMediaHandler = null
  allowOtherPartyRecording.value = true
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  registerLoopbackCapture()
})

afterEach(() => {
  endCall({ saved: false }) // leave no live call between tests
  vi.restoreAllMocks()
  setConsentGateDirForTests(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('the bug: a grant must not outlive its call', () => {
  it('refuses capture in a later call that never consented', async () => {
    // Call A, with consent.
    beginCall({ restart: false })
    expect(rendererPersists(SESSION_A, CONSENTED)).toBe(true)
    expect(rendererArms()).toBe(true)
    expect(await chromiumRequestsCapture()).toBe(true)

    // Call A ends.
    endCall({ saved: true })

    // RED without the fix: the grant was still on disk here, and both checks
    // below returned true — buyer audio for call B on call A's consent.
    expect(existsSync(gateFile())).toBe(false)

    // Call B. Nothing consents for it.
    beginCall({ restart: false })
    expect(rendererArms()).toBe(false)
    expect(await chromiumRequestsCapture()).toBe(false)
  })

  it('clears on an ABANDONED call too, not only a saved one', async () => {
    // An abandoned call's grant is exactly as dangerous as a saved call's,
    // so the clear is unconditional rather than gated on opts.saved.
    beginCall({ restart: false })
    expect(rendererPersists(SESSION_A, CONSENTED)).toBe(true)
    endCall({ saved: false })

    beginCall({ restart: false })
    expect(rendererArms()).toBe(false)
    expect(await chromiumRequestsCapture()).toBe(false)
  })

  it('clears even when a new call simply begins (no explicit end)', async () => {
    // beginCall's own implicit endCall({saved:false}) is the backstop for a
    // call that ended abnormally and never got a clean endCall of its own.
    beginCall({ restart: false })
    expect(rendererPersists(SESSION_A, CONSENTED)).toBe(true)

    beginCall({ restart: false }) // a brand-new call, no endCall in between
    expect(rendererArms()).toBe(false)
    expect(await chromiumRequestsCapture()).toBe(false)
  })
})

describe('the normal flow must still work — no permissive-for-restrictive trade', () => {
  it('a legitimate consent on a fresh call still arms and grants', async () => {
    beginCall({ restart: false })
    expect(rendererPersists(SESSION_B, CONSENTED)).toBe(true)
    expect(rendererArms()).toBe(true)
    expect(await chromiumRequestsCapture()).toBe(true)
  })

  it('consent re-granted in a LATER call works normally', async () => {
    beginCall({ restart: false })
    expect(rendererPersists(SESSION_A, CONSENTED)).toBe(true)
    endCall({ saved: true })

    beginCall({ restart: false })
    expect(rendererPersists(SESSION_B, CONSENTED)).toBe(true)
    expect(rendererArms()).toBe(true)
    expect(await chromiumRequestsCapture()).toBe(true)
  })
})

describe('a mid-call mono<->multichannel restart must NOT drop consent', () => {
  // THE REGRESSION THIS FIX COULD PLAUSIBLY HAVE INTRODUCED, and the reason
  // the clear went in endCall rather than anywhere in the restart path.
  // beginCall({restart:true}) returns early after markSpeakerBoundary() and
  // never reaches endCall — but "I read the code and it returns early" is
  // not evidence, so this asserts it against the real functions.
  it('keeps capture working across a restart', async () => {
    beginCall({ restart: false })
    expect(rendererPersists(SESSION_A, CONSENTED)).toBe(true)
    expect(rendererArms()).toBe(true)
    expect(await chromiumRequestsCapture()).toBe(true)

    // Buyer capture toggles: the session restarts, minting a fresh session
    // id for the SAME call. The consent record must survive it untouched.
    beginCall({ restart: true })

    expect(existsSync(gateFile())).toBe(true)
    expect(rendererArms()).toBe(true)
    expect(await chromiumRequestsCapture()).toBe(true)
  })

  it('survives several restarts in a row', async () => {
    beginCall({ restart: false })
    expect(rendererPersists(SESSION_A, CONSENTED)).toBe(true)
    for (let i = 0; i < 3; i++) beginCall({ restart: true })
    expect(rendererArms()).toBe(true)
    expect(await chromiumRequestsCapture()).toBe(true)
  })
})
