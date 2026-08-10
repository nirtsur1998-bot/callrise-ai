import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.0', isPackaged: false },
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
