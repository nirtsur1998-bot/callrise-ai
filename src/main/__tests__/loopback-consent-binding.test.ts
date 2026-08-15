// ROW 16 — the buyer-audio capture gate, driven through the REAL doors.
//
// Why this file exists. Every other consent test in this repo calls
// `persistActiveConsent(CALL_A, CONSENTED)` — constructing the call id it
// wants. Production never does that: it derives the id (`getCallId() ?? ''`)
// and sends it over IPC. And the two gate checks on the AUDIO path take NO
// ARGUMENT at all:
//
//     loopback.ts:126   armed = ... && consentPermitsCapture()   // arm
//     loopback.ts:142   if (!armed || ... || !consentPermitsCapture())  // grant
//
// so they ask "is there ANY active consent?", not "is there consent for THIS
// call?" — while every AI path (deal-tier1/2, live-cue ×4) passes the callId
// and binds correctly. The one place the binding is skipped is the place
// buyer audio actually starts being captured, upstream of everything the AI
// paths gate.
//
// Before this file, `loopback:arm` and the display-media grant handler had
// ZERO test coverage of any kind.
//
// These tests deliberately attempt the ABNORMAL flows. "The re-persist
// effect always runs first" is a claim about the normal path; a race, a
// crash, or a recovered call is where such claims stop being true, and the
// gap between "probably unreachable" and "unreachable" is where this
// session's findings have all lived.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir: string

/** Captures the handlers the module registers, so the tests can drive the
 *  same entry points the renderer and Chromium drive — rather than calling
 *  the gate function directly, which is the door production doesn't use. */
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
  }
}))

const allowOtherPartyRecording = { value: true }
vi.mock('../app-settings', () => ({
  loadAppSettings: () => ({ allowOtherPartyRecording: allowOtherPartyRecording.value })
}))

// live-transcript is the journal side; row 16 is about the gate, so this is
// stubbed to keep the test about one thing. Its own consent journaling is
// covered by the call-journal tests.
const recordedConsents: unknown[] = []
vi.mock('../live/live-transcript', () => ({
  recordConsent: (c: unknown) => void recordedConsents.push(c)
}))

const { registerLoopbackCapture } = await import('../loopback')
const { setConsentGateDirForTests, clearActiveConsent } = await import('../consent-gate')

// The same shape consent-gate.test.ts uses — sanitizeConsent rejects
// anything else, and a rejected fixture would make every assertion here
// vacuously "refused".
const CONSENTED = {
  status: 'consented',
  jurisdiction: 'two-party',
  method: 'verbal-on-call',
  recordOtherParty: true
}
const CALL_A = 'call-aaaa'

/** The renderer's real move: `window.api.consent.persist(callId, consent)`
 *  → sendSync('consent:persist', { callId, consent }). Entering here rather
 *  than at persistActiveConsent() is the entire point of this file. */
function rendererPersists(callId: string, consent: unknown): boolean {
  const ev: { returnValue?: unknown } = {}
  syncHandlers.get('consent:persist')!(ev, { callId, consent })
  return ev.returnValue === true
}

function rendererArms(): boolean {
  const ev: { returnValue?: unknown } = {}
  syncHandlers.get('loopback:arm')!(ev)
  return ev.returnValue === true
}

/** Chromium asking for the display-media stream. Returns true if audio was
 *  actually granted — the moment buyer audio starts flowing. */
async function chromiumRequestsCapture(): Promise<boolean> {
  // ASYNC on purpose: the grant path awaits desktopCapturer.getSources()
  // before calling back, so a synchronous read of the result always sees
  // "denied" and would make every one of these assertions vacuous.
  return await new Promise<boolean>((resolve) => {
    displayMediaHandler!({}, (opts) => resolve(Boolean(opts && 'audio' in opts)))
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'callrise-loopback-'))
  setConsentGateDirForTests(dir)
  syncHandlers.clear()
  displayMediaHandler = null
  recordedConsents.length = 0
  allowOtherPartyRecording.value = true
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  registerLoopbackCapture()
})

afterEach(() => {
  vi.restoreAllMocks()
  setConsentGateDirForTests(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('the audio gate, entered the way production enters it', () => {
  it('refuses to arm with no consent on disk', async () => {
    expect(rendererArms()).toBe(false)
    expect(await chromiumRequestsCapture()).toBe(false)
  })

  it('arms and grants once the renderer has persisted consent for the call', async () => {
    expect(rendererPersists(CALL_A, CONSENTED)).toBe(true)
    expect(rendererArms()).toBe(true)
    expect(await chromiumRequestsCapture()).toBe(true)
  })

  // THE DERIVATION, tested at the point production derives it. Every existing
  // consent test hands the gate a call id; none exercises what happens when
  // the renderer's `getCallId() ?? ''` yields the empty fallback.
  it('refuses when the renderer supplies an empty call id', async () => {
    expect(rendererPersists('', CONSENTED)).toBe(false)
    expect(rendererArms()).toBe(false)
    expect(await chromiumRequestsCapture()).toBe(false)
  })

  // And the direction of that refusal is the safety-critical part: an empty
  // id must not merely fail to store — it must not leave an EARLIER grant
  // standing that the argument-less check would then accept.
  it('an empty call id does not leave a previous call\'s grant usable', async () => {
    expect(rendererPersists(CALL_A, CONSENTED)).toBe(true)
    expect(rendererArms()).toBe(true)

    // Call B begins; the renderer's id is not ready yet, so it sends ''.
    expect(rendererPersists('', CONSENTED)).toBe(false)

    // DOCUMENTED CURRENT BEHAVIOUR — NOT AN ENDORSEMENT. The lifetime half
    // shipped in 1.2.6; the binding half is the outstanding work here.
    //
    // These read `true`, and that is the finding. loopback.ts's handler does
    //     const ok = callId ? persistActiveConsent(callId, ...) : false
    // so an empty id means persistActiveConsent is NEVER CALLED — it does not
    // even overwrite the stale record with a useless one. Call A's grant is
    // left intact, and the argument-less `consentPermitsCapture()` at arm and
    // grant does not ask which call it belongs to.
    //
    // Both LiveView call sites then run `void enableOtherParty()`
    // UNCONDITIONALLY, without checking whether the persist above succeeded —
    // so a failed persist still proceeds to arm.
    expect(rendererArms()).toBe(true)
    expect(await chromiumRequestsCapture()).toBe(true)
  })
})

describe('abnormal flows — where "the effect always runs first" stops being true', () => {
  // THE ONE THAT MATTERS. Call A consents. Call A ends. Call B starts and
  // nothing re-persists (the renderer never got there, the effect has not
  // fired yet, the user has not clicked). clearActiveConsent() runs at app
  // START, on explicit revoke, and inside persist-when-off — but NOT at call
  // end. So A's grant is still on disk, and the arm check does not ask which
  // call it belongs to.
  // POST-1.2.6 STATUS. The LEAK this documented is fixed and shipped: endCall()
  // now clears the grant, so a real later call has nothing to inherit. What
  // this test still pins is the part 1.2.6 deliberately did NOT fix — the two
  // audio-path checks remain argument-less, so given a grant on disk they do
  // not ask which call it belongs to. Note it never calls endCall(): that is
  // the point. It isolates the BINDING gap from the LIFETIME fix.
  //
  // This is the next piece of work on this branch. Once the audio checks take
  // the callId (safe here, where E1 re-keyed consent so it survives a
  // mono<->multichannel restart), these assertions flip to false and this
  // comment comes out.
  it('still does not bind a grant to its call (the half 1.2.6 deferred to 1.3.0)', async () => {
    expect(rendererPersists(CALL_A, CONSENTED)).toBe(true)
    expect(rendererArms()).toBe(true)
    expect(await chromiumRequestsCapture()).toBe(true)

    // Call A ends. Nothing clears the record — verify that rather than assume.
    expect(existsSync(join(dir, 'active-consent.json'))).toBe(true)

    // Call B. No consent persisted for it at all.
    const armedForB = rendererArms()
    const grantedForB = await chromiumRequestsCapture()

    // Documented as the CURRENT behaviour, not asserted as correct. If these
    // are true, call B's buyer audio can start flowing on call A's consent.
    expect({ armedForB, grantedForB }).toEqual({ armedForB: true, grantedForB: true })
  })

  it('a revoke during call A does close it for call B', async () => {
    expect(rendererPersists(CALL_A, CONSENTED)).toBe(true)
    const ev: { returnValue?: unknown } = {}
    syncHandlers.get('consent:clear')!(ev)
    expect(rendererArms()).toBe(false)
    expect(await chromiumRequestsCapture()).toBe(false)
  })

  it('the master switch still overrides a stale grant', async () => {
    expect(rendererPersists(CALL_A, CONSENTED)).toBe(true)
    allowOtherPartyRecording.value = false
    expect(rendererArms()).toBe(false)
    expect(await chromiumRequestsCapture()).toBe(false)
  })

  // The startup clear is the backstop the code comments rely on. A crash
  // mid-call leaves the file behind; the next LAUNCH must not honour it.
  it('a grant surviving a crash is cleared at the next app start', async () => {
    expect(rendererPersists(CALL_A, CONSENTED)).toBe(true)
    clearActiveConsent() // what index.ts does during startup
    expect(rendererArms()).toBe(false)
    expect(await chromiumRequestsCapture()).toBe(false)
  })
})
