// M29 A1.3 — consent: its own device-local file, its side effects, and the
// wiring that makes record() live. Each negative assertion is paired with
// the positive branch in the same test. Red-check: remove the consent read
// from setupTelemetry's isEnabled (→ "off writes nothing" goes red).
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { anonIdPath, readAnonId } from '../anon-id'
import { consentPath, readConsent, resetConsent, setConsent } from '../consent'
import { listQueued, record, resetTelemetry } from '../index'
import { NATIVE_CRASH_MARKER } from '../native-crashes'
import {
  applyConsentDecision,
  currentConsent,
  recordLaunch,
  recordQuit,
  setupTelemetry
} from '../setup'

let dir: string
let dumps: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'callrise-consent-'))
  dumps = join(dir, 'crashDumps')
})
afterEach(async () => {
  resetTelemetry()
  await rm(dir, { recursive: true, force: true })
})

describe('the consent file', () => {
  it('reads as unasked when missing, corrupt, or carrying an unknown value', async () => {
    expect(readConsent(dir)).toEqual({ consent: 'unasked' })
    await writeFile(consentPath(dir), '{nope')
    expect(readConsent(dir)).toEqual({ consent: 'unasked' })
    await writeFile(consentPath(dir), JSON.stringify({ consent: 'yes please' }))
    expect(readConsent(dir)).toEqual({ consent: 'unasked' })
  })

  it("'on' mints the id; 'off' deletes the id and the queue; the write is atomic", async () => {
    const now = (): Date => new Date('2026-08-23T12:00:00.000Z')
    expect(readAnonId(dir)).toBeNull()

    const on = setConsent(dir, 'on', { now, appVersion: '1.4.0' })
    expect(on).toEqual({
      consent: 'on',
      decidedAt: '2026-08-23T12:00:00.000Z',
      askedWithVersion: '1.4.0'
    })
    expect(readConsent(dir)).toEqual(on)
    const id = readAnonId(dir)
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]) // no temp left behind

    // queue something while on, then turn off
    setupTelemetry({ userDataDir: dir, appVersion: '1.4.0', crashDumpsDir: dumps })
    expect(record('usage', 'feature.rise.opened').ok).toBe(true)
    expect(listQueued()).toHaveLength(1)

    const off = setConsent(dir, 'off', { now })
    expect(off.consent).toBe('off')
    expect(readAnonId(dir)).toBeNull()
    expect(existsSync(anonIdPath(dir))).toBe(false)
    expect(listQueued()).toEqual([])
    expect(existsSync(join(dir, 'telemetry-queue.jsonl'))).toBe(false)

    // turning on again mints a DIFFERENT id — no continuity across consent
    setConsent(dir, 'on', { now })
    expect(readAnonId(dir)).not.toBe(id)
  })

  it('resetConsent returns the device to unasked with nothing left on disk', () => {
    setConsent(dir, 'on')
    resetConsent(dir)
    expect(readConsent(dir)).toEqual({ consent: 'unasked' })
    expect(readAnonId(dir)).toBeNull()
    expect(existsSync(consentPath(dir))).toBe(false)
  })
})

describe('setup — the gate reads the file fresh on every call', () => {
  it('unasked and off write nothing; on writes; off again stops immediately and wipes', async () => {
    setupTelemetry({ userDataDir: dir, appVersion: '1.4.0', crashDumpsDir: dumps })
    expect(currentConsent()).toEqual({ consent: 'unasked' })
    expect(record('usage', 'feature.rise.opened')).toEqual({ ok: false, reason: 'disabled' })
    recordLaunch()
    recordQuit()
    expect(await readdir(dir)).toEqual([]) // not the queue, not the id, not the crash marker

    applyConsentDecision('off')
    expect(record('usage', 'feature.rise.opened').ok).toBe(false)
    expect((await readdir(dir)).sort()).toEqual(['telemetry-consent.json']) // the decision only

    const rec = applyConsentDecision('on')
    expect(rec.consent).toBe('on')
    expect(rec.askedWithVersion).toBe('1.4.0')
    // a fresh 'on' starts the session right away
    expect(listQueued().map((e) => [e.name, e.props.consentJustGiven])).toEqual([
      ['session.start', true]
    ])
    expect(record('usage', 'feature.rise.opened').ok).toBe(true)
    expect(listQueued()).toHaveLength(2)

    applyConsentDecision('off')
    expect(listQueued()).toEqual([])
    expect(readAnonId(dir)).toBeNull()
    expect(record('usage', 'feature.rise.opened').ok).toBe(false)
  })

  it('a decision made on disk by a previous process is honoured without a restart', () => {
    setupTelemetry({ userDataDir: dir, appVersion: '1.4.0', crashDumpsDir: dumps })
    expect(record('usage', 'a.b').ok).toBe(false)
    setConsent(dir, 'on') // simulates the other process / the user editing — not via applyConsentDecision
    expect(record('usage', 'a.b').ok).toBe(true)
    setConsent(dir, 'off')
    expect(record('usage', 'a.b').ok).toBe(false)
  })

  it('recordLaunch with consent on: baselines old dumps, then counts new ones, and marks the session', async () => {
    setupTelemetry({ userDataDir: dir, appVersion: '1.4.0', crashDumpsDir: dumps })
    await mkdir(join(dumps, 'reports'), { recursive: true })
    const old = join(dumps, 'reports', 'old.dmp')
    await writeFile(old, 'MDMP')
    const t = (Date.now() - 3600_000) / 1000
    await utimes(old, t, t)

    applyConsentDecision('on') // → session.start(consentJustGiven: true)
    recordLaunch() // first launch after consent: old dump baselined, not reported
    let names = listQueued().map((e) => e.name)
    expect(names).toEqual(['session.start', 'session.start'])
    expect(names).not.toContain('crash.native')
    expect(existsSync(join(dir, NATIVE_CRASH_MARKER))).toBe(true)

    await writeFile(join(dumps, 'reports', 'new.dmp'), 'MDMP')
    recordLaunch() // next launch: the new dump is counted once
    names = listQueued().map((e) => e.name)
    expect(names.filter((n) => n === 'crash.native')).toHaveLength(1)
    const native = listQueued().find((e) => e.name === 'crash.native')
    expect(native?.props).toEqual({ count: 1 })
    expect(JSON.stringify(listQueued())).not.toContain('MDMP') // the dump's bytes never appear

    recordQuit()
    expect(listQueued().at(-1)?.name).toBe('session.end')
  })
})
