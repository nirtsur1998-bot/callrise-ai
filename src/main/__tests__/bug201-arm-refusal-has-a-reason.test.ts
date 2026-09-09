// BUG-201 — the app decides it will not capture the buyer, then reports it as
// though the USER refused.
//
// Main evaluated four conditions and returned a bare boolean; the preload was
// typed `arm: (): void` and discarded even that; the renderer saw
// `getDisplayMedia` reject and set `'denied'` — the same code the user gets
// when they see the OS prompt and click No. Five distinguishable situations,
// one indistinguishable outcome, and four of them are the app declining.
//
// NOTHING HERE CHANGES WHAT THE APP DOES. Every refusal is existing, deliberate
// behaviour (BUG-172: intent must never be trusted over evidence). These tests
// assert only that the reason survives the trip — and, in the last one, that
// the machinery which reports it cannot alter the decision it reports.
import { beforeEach, describe, expect, it, vi } from 'vitest'

type ArmHandler = (event: { returnValue: unknown }) => void
type MediaHandler = (
  request: unknown,
  callback: (r: Record<string, unknown>) => void
) => void

const handlers = new Map<string, ArmHandler>()
let mediaHandler: MediaHandler | null = null

let settings = { allowOtherPartyRecording: true }
let live: { callId: string } | null = { callId: 'call-1' }
let consentOk = true
/** Counts every call, so a test can prove the observation did not add one. */
let consentCalls = 0

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, fn: ArmHandler) => handlers.set(channel, fn),
    handle: vi.fn()
  },
  session: {
    defaultSession: {
      setDisplayMediaRequestHandler: (fn: MediaHandler) => {
        mediaHandler = fn
      }
    }
  },
  desktopCapturer: { getSources: async () => [{ id: 'screen:0', name: 'Screen 1' }] },
  shell: { openExternal: vi.fn() }
}))
vi.mock('../app-settings', () => ({ loadAppSettings: () => settings }))
vi.mock('../consent-gate', () => ({
  clearActiveConsent: vi.fn(),
  consentPermitsCapture: () => {
    consentCalls++
    return consentOk
  },
  persistActiveConsent: vi.fn(),
  readActiveConsent: () => null
}))
vi.mock('../live/live-transcript', () => ({
  liveCallInfo: () => live,
  recordConsent: vi.fn()
}))

const { registerLoopbackCapture, loopbackOutcomeCounts } = await import('../loopback')
registerLoopbackCapture()

const arm = (): { armed: boolean; reason: string } => {
  const event = { returnValue: undefined as unknown }
  handlers.get('loopback:arm')!(event)
  return event.returnValue as { armed: boolean; reason: string }
}

beforeEach(() => {
  settings = { allowOtherPartyRecording: true }
  live = { callId: 'call-1' }
  consentOk = true
  consentCalls = 0
})

describe('BUG-201 — an arm refusal says which of the four it was', () => {
  it('arms, and says so, when every condition holds', () => {
    expect(arm()).toEqual({ armed: true, reason: 'armed' })
  })

  it('names the master switch', () => {
    settings = { allowOtherPartyRecording: false }
    expect(arm()).toEqual({ armed: false, reason: 'master-switch-off' })
  })

  it('names the absent call', () => {
    live = null
    expect(arm()).toEqual({ armed: false, reason: 'no-live-call' })
  })

  it('names consent', () => {
    consentOk = false
    expect(arm()).toEqual({ armed: false, reason: 'consent-not-permitted' })
  })

  it('reports the FIRST failing condition when several fail at once', () => {
    // Otherwise the rep is told about consent when the master switch was off,
    // which sends them to the wrong screen.
    settings = { allowOtherPartyRecording: false }
    live = null
    consentOk = false
    expect(arm().reason).toBe('master-switch-off')
  })

  it('does not consult consent again to explain a refusal that never reached it', () => {
    // The load-bearing safety assertion. The reason is computed AFTER the
    // decision and must not re-run a consent check the decision short-circuited
    // past — an observation on a consent path has to be incapable of adding a
    // read, let alone changing an answer.
    settings = { allowOtherPartyRecording: false }
    arm()
    expect(consentCalls, 'the refusal explanation re-ran the consent check').toBe(0)
  })
})

describe('BUG-201 — the seven display-media outcomes are counted, not collapsed', () => {
  const request = async (): Promise<Record<string, unknown>> =>
    new Promise((resolve) => mediaHandler!({}, resolve))

  it('counts a request that was never armed', async () => {
    // The first draft of this test expected 'master-switch-off' here and was
    // WRONG, which is the useful part: a refused arm leaves `armed` false, so
    // the handler's first condition wins and the outcome is 'not-armed'. The
    // switch only names itself at this stage in the race below.
    settings = { allowOtherPartyRecording: false }
    arm()
    const before = loopbackOutcomeCounts()['not-armed'] ?? 0
    expect(await request()).toEqual({})
    expect(loopbackOutcomeCounts()['not-armed']).toBe(before + 1)
  })

  it('names the master switch when it is flipped BETWEEN arm and grant', async () => {
    // The case the re-check at grant time exists for: armed legitimately, then
    // the user turns buyer recording off before the OS prompt is answered.
    arm()
    settings = { allowOtherPartyRecording: false }
    const before = loopbackOutcomeCounts()['master-switch-off'] ?? 0
    expect(await request()).toEqual({})
    expect(loopbackOutcomeCounts()['master-switch-off']).toBe(before + 1)
  })

  it('names a call that ended between arm and grant', async () => {
    arm()
    live = null
    const before = loopbackOutcomeCounts()['no-live-call'] ?? 0
    expect(await request()).toEqual({})
    expect(loopbackOutcomeCounts()['no-live-call']).toBe(before + 1)
  })

  it('counts a grant', async () => {
    const before = loopbackOutcomeCounts()['granted'] ?? 0
    arm()
    const result = await request()
    expect(result).toHaveProperty('audio', 'loopback')
    expect(loopbackOutcomeCounts()['granted']).toBe(before + 1)
  })

  it('hands back a COPY of the counts, so a reader cannot reset the record', () => {
    const counts = loopbackOutcomeCounts()
    counts['granted'] = 0
    expect(loopbackOutcomeCounts()['granted']).not.toBe(0)
  })
})
