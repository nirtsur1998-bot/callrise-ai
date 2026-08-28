// M29 sweep item 8 — "off means off", enforced as a whole-directory property
// rather than a list of remembered filenames.
//
// THE DIRECTION RULE (founder, 2026-08-24): opt-in may fail safe by staying
// off; opt-out must NEVER fail toward on. Every test here is written from that
// asymmetry.
//
// Why this file exists at all: the privacy suite's revocation case checked two
// NAMED files (queue, id) while only its never-consented case did the strict
// whole-directory readdir. So telemetry-sent.jsonl and the native-crash marker
// survived opt-out for the whole milestone, and the suite stayed green — the
// sent log holding the exact anon id the opt-out had just "deleted".
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readConsent, resetConsent, setConsent } from '../consent'
import { listQueued, record, resetTelemetry } from '../index'
import { flushTelemetry, resetFlushState, setIngestConfig } from '../flush'
import { appendSent, listSent } from '../sent-log'
import { readAnonId } from '../anon-id'
import { NATIVE_CRASH_MARKER } from '../native-crashes'
import { applyConsentDecision, recordLaunch, setupTelemetry } from '../setup'

const CFG = { url: 'https://example-project.supabase.co/', anonKey: 'anon-key-for-tests' }

let dir: string
let respond: () => Response | Promise<Response>

const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
  return new Promise<Response>((resolve, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    )
    Promise.resolve()
      .then(() => respond())
      .then(resolve, reject)
  })
}) as unknown as typeof fetch

/** Every file the telemetry system can create, whatever its name. */
function telemetryFiles(): string[] {
  return readdirSync(dir).filter((f) => f.startsWith('telemetry'))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'consent-revoke-'))
  respond = () => new Response(null, { status: 201 })
  resetFlushState()
  setupTelemetry({ userDataDir: dir, appVersion: '1.4.0', crashDumpsDir: join(dir, 'dumps') })
  setIngestConfig(() => CFG)
})

afterEach(() => {
  resetTelemetry()
  resetFlushState()
  rmSync(dir, { recursive: true, force: true })
})

describe('opt-out erases EVERY telemetry file, not a remembered subset', () => {
  it('after a real send then opt-out, no telemetry file survives except the consent record', async () => {
    applyConsentDecision('on')
    record('usage', 'feature.crm.opened')
    await flushTelemetry({ fetchImpl })
    // Control: the state we are about to revoke really exists on disk.
    expect(listSent(dir).length).toBeGreaterThan(0)
    expect(readAnonId(dir)).toBeTruthy()

    setConsent(dir, 'off')

    // The whole-directory assertion — this is the property, not a file list.
    expect(telemetryFiles().sort()).toEqual(['telemetry-consent.json'])
    expect(readAnonId(dir)).toBeNull()
    expect(listSent(dir)).toEqual([])
    expect(listQueued()).toEqual([])
  })

  it('the deleted install ID does not survive inside the sent log', async () => {
    applyConsentDecision('on')
    const id = readAnonId(dir)
    expect(id).toBeTruthy()
    record('usage', 'feature.crm.opened')
    await flushTelemetry({ fetchImpl })
    // Control: the id really is in the sent log's bytes before revocation.
    expect(readFileSync(join(dir, 'telemetry-sent.jsonl'), 'utf8')).toContain(id!)

    setConsent(dir, 'off')

    for (const f of telemetryFiles()) {
      expect(readFileSync(join(dir, f), 'utf8'), f).not.toContain(id!)
    }
  })

  it('the native-crash marker is removed, so re-consent re-baselines instead of reporting the off-window', () => {
    applyConsentDecision('on')
    recordLaunch()
    expect(existsSync(join(dir, NATIVE_CRASH_MARKER))).toBe(true) // control

    setConsent(dir, 'off')
    expect(existsSync(join(dir, NATIVE_CRASH_MARKER))).toBe(false)
  })

  it('resetConsent erases the same set — the two paths cannot drift', async () => {
    applyConsentDecision('on')
    recordLaunch()
    record('usage', 'feature.crm.opened')
    await flushTelemetry({ fetchImpl })
    expect(telemetryFiles().length).toBeGreaterThan(1) // control

    resetConsent(dir)
    expect(telemetryFiles()).toEqual([])
  })
})

describe('the direction rule: opt-out must never fail toward on', () => {
  // The write is made to fail FOR REAL rather than by mocking node:fs (which
  // ESM will not let us spy on anyway): a DIRECTORY sitting where the consent
  // file must be renamed into place makes renameSync fail with a genuine
  // EPERM/EEXIST, exactly like a locked file or a denied ACL would.
  function blockConsentWrite(): void {
    rmSync(join(dir, 'telemetry-consent.json'), { force: true })
    mkdirSync(join(dir, 'telemetry-consent.json'), { recursive: true })
  }

  it('revocation still happens when the consent WRITE fails', async () => {
    applyConsentDecision('on')
    record('usage', 'feature.crm.opened')
    await flushTelemetry({ fetchImpl })
    expect(readAnonId(dir)).toBeTruthy() // control
    expect(listSent(dir).length).toBeGreaterThan(0) // control

    blockConsentWrite()
    setConsent(dir, 'off')

    // The write failed — but the erase must have happened anyway. That is the
    // rule: worst case the record is unwritable and the next launch re-asks,
    // which is strictly safer than sending after being told to stop.
    expect(readAnonId(dir)).toBeNull()
    expect(listSent(dir)).toEqual([])
    expect(listQueued()).toEqual([])
  })

  it('opt-IN failing to persist leaves telemetry OFF (failing safe is fine in this direction)', () => {
    blockConsentWrite()
    const persisted = setConsent(dir, 'on').consent
    // The caller is told what was ACTUALLY persisted, so the UI can tell.
    expect(persisted).not.toBe('on')
    expect(readConsent(dir).consent).not.toBe('on')
  })

  it('setConsent never throws even when the id mint fails', () => {
    // A directory where telemetry-id must be written makes the mint throw.
    mkdirSync(join(dir, 'telemetry-id'), { recursive: true })
    expect(() => setConsent(dir, 'on')).not.toThrow()
  })
})

describe('a send that is in flight when consent is revoked', () => {
  it('does not create the sent log after opt-out', async () => {
    applyConsentDecision('on')
    record('usage', 'feature.crm.opened')

    // The server responds only after we have revoked — the real race. The
    // deferred is built BEFORE the flush so there is no window in which
    // `release` is still undefined.
    let release!: (r: Response) => void
    const pending = new Promise<Response>((res) => {
      release = res
    })
    respond = () => pending

    const inFlight = flushTelemetry({ fetchImpl })
    await Promise.resolve() // let the transport actually issue the request
    setConsent(dir, 'off') // user flips the toggle mid-send
    release(new Response(null, { status: 201 }))
    const r = await inFlight

    expect(r.reason).toBe('consent revoked mid-send')
    // The bytes left the machine — that cannot be undone — but no telemetry
    // file may be CREATED after revocation.
    expect(existsSync(join(dir, 'telemetry-sent.jsonl'))).toBe(false)
    expect(telemetryFiles().sort()).toEqual(['telemetry-consent.json'])
  })
})

describe('the sent log is still written on the normal path (the fix must not disable it)', () => {
  it('a successful send with consent still on records the batch', async () => {
    applyConsentDecision('on')
    record('usage', 'feature.crm.opened')
    const r = await flushTelemetry({ fetchImpl })
    expect(r.sent).toBeGreaterThan(0)
    expect(listSent(dir).length).toBe(1)
  })
})

describe('appendSent itself is unchanged (control for the above)', () => {
  it('writes a row when called directly', () => {
    appendSent(dir, { sentAt: new Date().toISOString(), status: 201, count: 1, body: '[]' })
    expect(listSent(dir)).toHaveLength(1)
  })
})
