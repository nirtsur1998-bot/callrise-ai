import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The gate imports `app` only to find userData; tests override the directory.
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const {
  persistActiveConsent,
  readActiveConsent,
  clearActiveConsent,
  consentPermitsCapture,
  setConsentGateDirForTests
} = await import('../consent-gate')

let dir: string
const file = (): string => join(dir, 'active-consent.json')

const CONSENTED = {
  status: 'consented',
  jurisdiction: 'two-party',
  method: 'verbal-on-call',
  recordOtherParty: true
}

// M27 E1 — keyed on callId (a stable string, e.g. a UUID in production), not
// sessionId (a per-connection integer). A mono<->multichannel restart
// mid-call mints a new session id for the SAME call; callId survives that
// restart, which is the whole point of the fix.
const CALL_A = 'call-a'
const CALL_B = 'call-b'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'consent-gate-'))
  setConsentGateDirForTests(dir)
})

afterEach(() => {
  setConsentGateDirForTests(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('the gate is closed by default', () => {
  it('refuses capture when nothing has been written', () => {
    expect(consentPermitsCapture()).toBe(false)
    expect(readActiveConsent()).toBeNull()
  })

  it('refuses capture after the record is cleared', () => {
    persistActiveConsent(CALL_A, CONSENTED)
    expect(consentPermitsCapture()).toBe(true)
    clearActiveConsent()
    expect(consentPermitsCapture()).toBe(false)
  })

  it('survives clearing something that was never there', () => {
    expect(() => clearActiveConsent()).not.toThrow()
  })
})

describe('what opens it', () => {
  it('opens for a genuinely consented record', () => {
    expect(persistActiveConsent(CALL_A, CONSENTED)).toBe(true)
    expect(consentPermitsCapture()).toBe(true)
    expect(readActiveConsent()?.callId).toBe(CALL_A)
  })

  it('records HOW consent was obtained, for the audit trail', () => {
    persistActiveConsent(CALL_A, { ...CONSENTED, method: 'pre-agreed' })
    expect(readActiveConsent()?.consent.method).toBe('pre-agreed')
    expect(readActiveConsent()?.persistedAt).not.toBe('')
  })
})

describe('what keeps it shut', () => {
  // The same hard invariant as a saved call: recordOtherParty is only ever
  // honoured alongside an explicit 'consented' status.
  it.each([
    ['not asked', { status: 'not-asked', recordOtherParty: true }],
    ['declined', { status: 'declined', recordOtherParty: true }],
    ['disclosed but not agreed', { status: 'disclosed', recordOtherParty: true }],
    ['consented but flag off', { status: 'consented', recordOtherParty: false }],
    ['a bogus status', { status: 'whatever', recordOtherParty: true }],
    ['nothing at all', {}]
  ])('refuses to write %s', (_label, raw) => {
    expect(persistActiveConsent(CALL_A, raw)).toBe(false)
    expect(consentPermitsCapture()).toBe(false)
  })

  // A renderer that has been compromised, or simply has a bug, cannot talk the
  // main process into capture by sending a confident-looking object.
  it('refuses a truthy-but-not-true flag', () => {
    expect(persistActiveConsent(CALL_A, { status: 'consented', recordOtherParty: 'yes' })).toBe(
      false
    )
  })

  it('clears a previous grant when consent is turned off', () => {
    persistActiveConsent(CALL_A, CONSENTED)
    expect(consentPermitsCapture()).toBe(true)
    // The rep revokes mid-call: the write fails AND the old grant goes.
    expect(persistActiveConsent(CALL_A, { status: 'declined', recordOtherParty: false })).toBe(
      false
    )
    expect(consentPermitsCapture()).toBe(false)
  })
})

describe('the file is not trusted either', () => {
  // Re-sanitized on read, exactly like a saved call — the gate must hold even
  // for a file someone edited by hand.
  it('refuses a hand-edited file claiming consent it never had', () => {
    writeFileSync(
      file(),
      JSON.stringify({
        callId: CALL_A,
        consent: { status: 'declined', recordOtherParty: true },
        persistedAt: new Date().toISOString()
      })
    )
    expect(consentPermitsCapture()).toBe(false)
  })

  it('refuses a file with no call id', () => {
    writeFileSync(file(), JSON.stringify({ consent: CONSENTED }))
    expect(consentPermitsCapture()).toBe(false)
  })

  it('refuses a file with an empty-string call id', () => {
    writeFileSync(file(), JSON.stringify({ callId: '', consent: CONSENTED }))
    expect(consentPermitsCapture()).toBe(false)
  })

  it('refuses unparseable contents rather than throwing', () => {
    writeFileSync(file(), 'not json {{{')
    expect(() => consentPermitsCapture()).not.toThrow()
    expect(consentPermitsCapture()).toBe(false)
  })

  it('writes only the sanitized record, never the raw input', () => {
    persistActiveConsent(CALL_A, { ...CONSENTED, method: 'telepathy', smuggled: 'payload' })
    const onDisk = JSON.parse(readFileSync(file(), 'utf8'))
    expect(onDisk.consent.method).toBeUndefined() // unrecognised method dropped
    expect(onDisk.consent.smuggled).toBeUndefined()
  })
})

describe('consent does not carry between calls', () => {
  // The case that matters: a rep consents on call A, hangs up, and starts call
  // B without being asked again.
  it('refuses a call that did not record the consent', () => {
    persistActiveConsent(CALL_A, CONSENTED)
    expect(consentPermitsCapture(CALL_A)).toBe(true)
    expect(consentPermitsCapture(CALL_B)).toBe(false)
  })

  it('still opens when no call id is named, for the un-scoped check', () => {
    persistActiveConsent(CALL_A, CONSENTED)
    expect(consentPermitsCapture()).toBe(true)
  })

  it('replaces the previous call’s record rather than accumulating', () => {
    persistActiveConsent(CALL_A, CONSENTED)
    persistActiveConsent(CALL_B, CONSENTED)
    expect(consentPermitsCapture(CALL_A)).toBe(false)
    expect(consentPermitsCapture(CALL_B)).toBe(true)
  })

  // M27 E1 — the actual bug: a mono<->multichannel restart mid-call mints a
  // NEW session id but is still the SAME call. Proven here at the gate level
  // (the restart itself is exercised end-to-end in
  // live-engine-consent-gate.test.ts); this pins that callId, unlike the old
  // sessionId keying, is exactly the identifier that survives it.
  it('survives what used to break it — a new session id for the same call', () => {
    persistActiveConsent(CALL_A, CONSENTED)
    // The restart mints main a new session id, but the call id — what this
    // gate is actually keyed on now — never changes.
    expect(consentPermitsCapture(CALL_A)).toBe(true)
  })
})
