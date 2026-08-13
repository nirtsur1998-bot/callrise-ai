// M26 Phase 4.5.2 — Deal Intelligence / live-cue settings moved from
// renderer-only localStorage into app-settings.ts's AppSettings, so main
// can read them once the engines themselves move into main (4.5.3/4.5.4).
// Drives the REAL loadAppSettings()/saveAppSettings() against a real temp
// file (only 'electron' is stubbed — same pattern as purpose-health-store's
// own test), not a description of the sanitize/merge logic.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dir: string

vi.mock('electron', () => ({ app: { getPath: () => dir } }))

async function freshModule(): Promise<typeof import('../app-settings')> {
  vi.resetModules()
  return import('../app-settings')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'app-settings-live-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('dealIntelligence — defaults and sanitize', () => {
  it('a fresh install (no file yet) gets the same defaults the old localStorage hook shipped', async () => {
    const { loadAppSettings } = await freshModule()
    const s = loadAppSettings()
    expect(s.dealIntelligence).toEqual({
      enabled: false,
      sensitivity: 'balanced',
      enabledTypes: { risk: true, opportunity: true, tactical: true },
      frequency: 'balanced'
    })
    expect(s.liveCues).toEqual({ enabled: true, sensitivity: 'low' })
  })

  it('an invalid sensitivity/frequency value collapses to the safe default, never a made-up one', async () => {
    const { loadAppSettings, saveAppSettings } = await freshModule()
    saveAppSettings({
      dealIntelligence: { sensitivity: 'extreme', frequency: 'constant' } as never
    })
    const s = loadAppSettings()
    expect(s.dealIntelligence.sensitivity).toBe('balanced')
    expect(s.dealIntelligence.frequency).toBe('balanced')
  })

  it('a corrupt settings file degrades to safe defaults for both new fields, not a crash', async () => {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'app-settings.json'), '{not valid json', 'utf8')
    const { loadAppSettings } = await freshModule()
    const s = loadAppSettings()
    expect(s.dealIntelligence.enabled).toBe(false)
    expect(s.liveCues.enabled).toBe(true)
  })
})

describe('dealIntelligence — merge semantics', () => {
  it('enabled/sensitivity/frequency each update independently, leaving the others untouched', async () => {
    const { saveAppSettings } = await freshModule()
    saveAppSettings({ dealIntelligence: { enabled: true } })
    const afterEnable = saveAppSettings({ dealIntelligence: { sensitivity: 'aggressive' } })
    expect(afterEnable.dealIntelligence.enabled).toBe(true) // not reset by the second patch
    expect(afterEnable.dealIntelligence.sensitivity).toBe('aggressive')
    const afterFrequency = saveAppSettings({ dealIntelligence: { frequency: 'frequent' } })
    expect(afterFrequency.dealIntelligence.enabled).toBe(true)
    expect(afterFrequency.dealIntelligence.sensitivity).toBe('aggressive')
    expect(afterFrequency.dealIntelligence.frequency).toBe('frequent')
  })

  it('enabledTypes merges key-by-key — disabling one type leaves the others as they were', async () => {
    const { saveAppSettings } = await freshModule()
    const next = saveAppSettings({ dealIntelligence: { enabledTypes: { risk: false } } })
    expect(next.dealIntelligence.enabledTypes).toEqual({
      risk: false,
      opportunity: true,
      tactical: true
    })
  })

  it('a patch that would disable ALL three nudge types is rejected wholesale, not partially applied', async () => {
    const { saveAppSettings, loadAppSettings } = await freshModule()
    saveAppSettings({
      dealIntelligence: { enabledTypes: { risk: false, opportunity: false, tactical: false } }
    })
    const s = loadAppSettings()
    // Rejected entirely — the master `enabled` switch is the only honest way
    // to turn the feature off, per useDealIntelligenceSettings.ts's own
    // pre-existing guard, mirrored here at the merge layer.
    expect(s.dealIntelligence.enabledTypes).toEqual({
      risk: true,
      opportunity: true,
      tactical: true
    })
  })

  it('disabling the last remaining type ONE AT A TIME (not all in one patch) is still rejected on the final step', async () => {
    const { saveAppSettings, loadAppSettings } = await freshModule()
    saveAppSettings({ dealIntelligence: { enabledTypes: { risk: false } } })
    saveAppSettings({ dealIntelligence: { enabledTypes: { opportunity: false } } })
    // This last patch would leave all three false — rejected.
    saveAppSettings({ dealIntelligence: { enabledTypes: { tactical: false } } })
    const s = loadAppSettings()
    expect(s.dealIntelligence.enabledTypes).toEqual({
      risk: false,
      opportunity: false,
      tactical: true // the rejected final patch never took effect
    })
  })
})

describe('liveCues — merge semantics and persistence', () => {
  it('enabled and sensitivity update independently', async () => {
    const { saveAppSettings } = await freshModule()
    saveAppSettings({ liveCues: { enabled: false } })
    const next = saveAppSettings({ liveCues: { sensitivity: 'high' } })
    expect(next.liveCues).toEqual({ enabled: false, sensitivity: 'high' })
  })

  it('an invalid sensitivity value collapses to the default (low), never a made-up one', async () => {
    const { loadAppSettings, saveAppSettings } = await freshModule()
    saveAppSettings({ liveCues: { sensitivity: 'extreme' } as never })
    expect(loadAppSettings().liveCues.sensitivity).toBe('low')
  })

  it('a real restart (fresh module import) reads back what was persisted to disk', async () => {
    const first = await freshModule()
    first.saveAppSettings({
      liveCues: { enabled: false, sensitivity: 'medium' },
      dealIntelligence: { enabled: true, sensitivity: 'quiet' }
    })

    // A genuinely fresh module instance, same file on disk — proves this is
    // real persistence, not an in-memory value surviving by luck.
    const second = await freshModule()
    const s = second.loadAppSettings()
    expect(s.liveCues).toEqual({ enabled: false, sensitivity: 'medium' })
    expect(s.dealIntelligence.enabled).toBe(true)
    expect(s.dealIntelligence.sensitivity).toBe('quiet')
  })
})

describe('getDealIntelligenceSettings / getLiveCueSettings — the getters 4.5.3/4.5.4 will read', () => {
  it('reflect whatever was just saved, read fresh rather than cached', async () => {
    const { saveAppSettings, getDealIntelligenceSettings, getLiveCueSettings } = await freshModule()
    expect(getDealIntelligenceSettings().enabled).toBe(false)
    expect(getLiveCueSettings().enabled).toBe(true)
    saveAppSettings({ dealIntelligence: { enabled: true }, liveCues: { enabled: false } })
    expect(getDealIntelligenceSettings().enabled).toBe(true)
    expect(getLiveCueSettings().enabled).toBe(false)
  })
})
