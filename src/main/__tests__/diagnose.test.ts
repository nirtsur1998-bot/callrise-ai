import { describe, expect, it, vi } from 'vitest'

// M37 — THE MOCK MUST HAVE THE SURFACE THE CODE CALLS.
//
// This mock had no `getPath`, and the sweep rows added below read
// `app.getPath('userData')`. So the call threw, `safe()` swallowed it, and the
// two assertions written to prove those rows carry only counts passed against
// a report where the rows were empty — a guard that reads as coverage and
// tests nothing. Exactly the shape recorded as taxonomy species 93 ("a mock
// missing a surface doesn't fail, it makes the code under test take a
// different path").
//
// So the mock now points at a real temp profile carrying a real poisoned
// memory.db, and the assertions run against a report where the sweep was
// actually read. Hoisted because vi.mock's factory is hoisted above the imports
// and the database has to exist before buildDiagnoseReport() runs at
// describe-time.
const fixture = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs')
  const { tmpdir } = require('node:os')
  const { join } = require('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'diagnose-brain-'))
  const Database = require('better-sqlite3')
  const db = new Database(join(dir, 'memory.db'))
  try {
    db.exec('CREATE TABLE memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT INTO memory_meta (key, value) VALUES (?, ?)').run(
      'bug215.quoteSweep',
      JSON.stringify({
        status: 'ran',
        at: '2026-09-08T08:54:52.846Z',
        callsSwept: 25,
        rescuedByFileCheck: 0,
        // the poison: keys no version has written, of the kind a later one might
        lastCallId: 'call-2026-09-01-abc123',
        lastError: "ENOENT: open 'C:\\\\Users\\\\Dana\\\\private-note.txt'"
      })
    )
  } finally {
    db.close()
  }
  return { dir }
})

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.1.0',
    isPackaged: false,
    getPath: (name: string) => (name === 'userData' ? fixture.dir : fixture.dir)
  },
  ipcMain: { handle: () => undefined, on: () => undefined },
  BrowserWindow: { fromWebContents: () => null },
  systemPreferences: { getMediaAccessStatus: () => 'granted' },
  shell: { openExternal: async () => undefined },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../ai-keys', () => ({ keyRejectedHint: () => '' }))
vi.mock('../app-settings', () => ({
  loadAppSettings: () => ({ allowOtherPartyRecording: true, alwaysRecordOtherParty: false })
}))
vi.mock('../consent-gate', () => ({ readActiveConsent: () => null }))

const { buildDiagnoseReport, wantsDiagnose } = await import('../diagnose')

describe('wantsDiagnose', () => {
  it('detects the flag anywhere in argv', () => {
    expect(wantsDiagnose(['electron', '.', '--diagnose'])).toBe(true)
    expect(wantsDiagnose(['electron', '--diagnose', '.'])).toBe(true)
  })

  it('is false without it, and is not fooled by a lookalike', () => {
    expect(wantsDiagnose(['electron', '.'])).toBe(false)
    expect(wantsDiagnose(['electron', '--diagnose-later'])).toBe(false)
  })
})

describe('buildDiagnoseReport', () => {
  const report = buildDiagnoseReport()

  it('actually renders, rather than only typechecking', () => {
    expect(report.length).toBeGreaterThan(200)
    expect(report).toContain('CallRise AI — diagnose')
  })

  it('covers every section the spec asks for', () => {
    for (const section of [
      'AUDIO CAPTURE',
      'CHANNEL SELF-TEST',
      'SESSION HEALTH',
      'CONSENT GATE',
      'UPDATER',
      'API KEYS'
    ]) {
      expect(report, `missing section ${section}`).toContain(section)
    }
  })

  // M37 — the ramp criterion, printed where a tester can paste it. The
  // electron mock above has no getPath, so memory.db is unreachable here:
  // this is the degraded path, and it must still print the rows rather than
  // take the report down or claim a check it never ran. That is this file's
  // own first rule — "never claim a check ran when it did not".
  it('reads the real sweep record and reports it', () => {
    // The control for the two assertions below: if this fails, the report
    // never reached the database and everything after it is vacuous.
    expect(report).toContain('quote sweep       : ran')
    expect(report).toContain('rescuedByFileCheck: 0 (should be 0)')
    expect(report).toContain('healthy result')
  })

  it('the sweep block is EXACTLY three known lines, whatever the record holds', () => {
    // WHY ENUMERATION AND NOT A POISON SWEEP, stated because the obvious test
    // here is worthless and I wrote it first. The fixture's record carries a
    // call id and a Windows path in keys no version has written, so the
    // tempting assertion is `report does not contain 'call-2026-...'`. That
    // assertion passes whether or not the projection runs — bypassing
    // projectSweepRecord at this call site was red-checked and changed NOTHING
    // in the output — because diagnose renders three NAMED fields and never
    // the object. A test that cannot fail is not a guard.
    //
    // What can actually go wrong here is someone adding a fourth line that
    // prints more of the record. So the block is enumerated: any new line, or
    // any change to these three, fails. The projection remains defence in
    // depth for the day someone prints the object; the unit tests in
    // memory/__tests__/sweep-record-summary.test.ts are what hold it.
    const from = report.indexOf('  quote sweep')
    expect(from, 'the sweep block is missing entirely').toBeGreaterThan(-1)
    const block = report
      .slice(from, from + report.slice(from).indexOf('\n\n'))
      .split('\n')
      .filter((l) => l.trim())
    expect(block).toEqual([
      '  quote sweep       : ran',
      '  rescuedByFileCheck: 0 (should be 0)',
      '  rescuedByFileCheck is 0 over 25 call(s) actually examined — the call listing and the filesystem agreed. This is the healthy result.'
    ])
  })

  // The channel self-test is the one check that runs for real here, with no
  // call in progress and no hardware — so it must actually pass.
  it('runs the channel self-test and passes it', () => {
    expect(report).toContain('stereo (rep+buyer): PASS')
    expect(report).toContain('mono (mic only)   : PASS')
  })

  // A row claiming "ok" because nothing tested it is worth less than nothing,
  // so the capture section must state its real position on THIS platform:
  // "not built" where buyer capture is supported, "unsupported" where it isn't.
  it('never claims a capture path it does not have', () => {
    const honest = report.includes('not built') || report.includes('unsupported')
    expect(honest, 'the capture section overstates what exists').toBe(true)
  })

  it('reports no live call rather than inventing numbers', () => {
    expect(report).toContain('no call in progress')
  })

  it('reports the consent gate as closed when nothing is on disk', () => {
    expect(report).toContain('buyer capture cannot start')
  })

  it('reports the updater as disabled without a trusted feed', () => {
    expect(report).toContain('disabled —')
  })

  // The whole report is meant to be pasted into a bug thread by a stranger.
  it('never prints a key value, only whether one is set', () => {
    process.env.DEEPGRAM_API_KEY = 'sk-super-secret-value-1234567890'
    const withKey = buildDiagnoseReport()
    expect(withKey).toContain('DEEPGRAM_API_KEY  : set')
    expect(withKey).not.toContain('super-secret')
    delete process.env.DEEPGRAM_API_KEY
  })
})
