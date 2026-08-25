// M29 A2.7 — consent-gate I/O failures become consent.flowError counters.
// THE CLAIM THAT MATTERS MOST: every gate outcome is byte-identical to
// before — the signal is a side observation and can never alter fail-closed
// behaviour. Every telemetry assertion here is therefore PAIRED with the
// behaviour assertion for the same operation, in the same test, so a
// regression in either direction goes red.
//
// ENOENT is the gate's NORMAL state (no active consent) and must not count;
// only a file that exists-but-can't-be-used, or a write/clear that fails,
// is a flow error.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const { persistActiveConsent, readActiveConsent, clearActiveConsent, setConsentGateDirForTests } =
  await import('../consent-gate')
const telemetry = await import('../telemetry/index')
const { setupTelemetry } = await import('../telemetry/setup')
const { setConsent } = await import('../telemetry/consent')

const CONSENTED = {
  status: 'consented',
  jurisdiction: 'two-party',
  method: 'verbal-on-call',
  recordOtherParty: true
}

let dir: string
let telemetryDir: string

const flowErrors = (): Array<Record<string, unknown>> =>
  telemetry
    .listQueued()
    .filter((e) => e.name === 'consent.flowError')
    .map((e) => e.props)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'consent-gate-tel-'))
  telemetryDir = mkdtempSync(join(tmpdir(), 'consent-gate-tel-store-'))
  setConsentGateDirForTests(dir)
  setupTelemetry({
    userDataDir: telemetryDir,
    appVersion: '1.4.0',
    crashDumpsDir: join(telemetryDir, 'dumps')
  })
  setConsent(telemetryDir, 'on')
})

afterEach(() => {
  setConsentGateDirForTests(null)
  telemetry.resetTelemetry()
  rmSync(dir, { recursive: true, force: true })
  rmSync(telemetryDir, { recursive: true, force: true })
})

describe('the green path emits nothing', () => {
  it('persist → read → clear on a healthy disk: correct outcomes, zero flow errors', () => {
    expect(persistActiveConsent('call-1', CONSENTED)).toBe(true)
    expect(readActiveConsent()?.callId).toBe('call-1')
    clearActiveConsent()
    expect(readActiveConsent()).toBeNull()
    expect(flowErrors()).toEqual([])
  })

  it('a missing gate file is the NORMAL state — read and clear stay silent', () => {
    expect(readActiveConsent()).toBeNull() // no file: benign
    clearActiveConsent() // already gone: benign
    expect(flowErrors()).toEqual([])
  })
})

describe('failures are counted AND the gate behaves exactly as before', () => {
  it('an unwritable gate directory: persist still returns false (closed), one write error counted', () => {
    // Point the gate at a path whose parent is a FILE — mkdir/write must fail.
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'i am a file, not a directory')
    setConsentGateDirForTests(join(blocker, 'sub'))

    expect(persistActiveConsent('call-2', CONSENTED)).toBe(false) // fail-closed, unchanged
    const errs = flowErrors()
    expect(errs).toHaveLength(1)
    expect(errs[0].op).toBe('write')
    // fs codes vary by OS (ENOTDIR/EEXIST/ENOENT); a token code or absent.
    if ('code' in errs[0]) expect(String(errs[0].code)).toMatch(/^[A-Za-z0-9_.-]{1,64}$/)
  })

  it('a corrupt gate file: read still returns null (closed), one read error counted, no call id in the event', () => {
    writeFileSync(join(dir, 'active-consent.json'), '{ this is not json')
    expect(readActiveConsent()).toBeNull() // fail-closed, unchanged
    const errs = flowErrors()
    expect(errs).toHaveLength(1)
    expect(errs[0]).toEqual({ op: 'read' }) // SyntaxError has no fs code; nothing else rides along
    expect(JSON.stringify(telemetry.listQueued())).not.toContain('call-')
  })

  it('a hand-edited file CLAIMING consent still collapses to null — and counts nothing (that is sanitize, not I/O)', () => {
    writeFileSync(
      join(dir, 'active-consent.json'),
      JSON.stringify({ callId: 'call-3', consent: { status: 'not-asked', recordOtherParty: true } })
    )
    expect(readActiveConsent()).toBeNull() // the M27 invariant, untouched
    expect(flowErrors()).toEqual([]) // a refused grant is not a flow error
  })
})

describe('telemetry off: identical gate behaviour, zero events', () => {
  it('the same unwritable-dir failure returns the same false with nothing recorded', () => {
    setConsent(telemetryDir, 'off')
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'file')
    setConsentGateDirForTests(join(blocker, 'sub'))
    expect(persistActiveConsent('call-4', CONSENTED)).toBe(false) // behaviour parity
    writeFileSync(join(dir, 'active-consent.json'), '{ nope')
    setConsentGateDirForTests(dir)
    expect(readActiveConsent()).toBeNull() // behaviour parity
    expect(telemetry.listQueued()).toEqual([])
  })
})
