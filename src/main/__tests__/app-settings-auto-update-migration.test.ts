// M29 (founder decision 2026-08-24) — auto-update flips ON by default, with a
// one-time override-with-notice migration. Every pre-1.3.4 install has
// autoUpdateEnabled: false PERSISTED (whole-object writes), so a changed code
// default alone reaches nobody; the load path overrides the stored value once
// and marks the migration so the user's own later choice is never overridden
// again. Drives the REAL loadAppSettings()/saveAppSettings() against a real
// temp file, same pattern as app-settings-jobs.test.ts.
//
// Red-checked by making the load path respect the stored value regardless of
// the marker (the pre-M29 line): the migration tests fail; the
// user's-choice-wins tests keep passing — proving the tests discriminate the
// migration specifically.
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dir: string

vi.mock('electron', () => ({ app: { getPath: () => dir } }))

async function freshModule(): Promise<typeof import('../app-settings')> {
  vi.resetModules()
  return import('../app-settings')
}

function writeSettingsFile(obj: Record<string, unknown>): void {
  writeFileSync(join(dir, 'app-settings.json'), JSON.stringify(obj), 'utf8')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'app-settings-autoupdate-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('the one-time migration to on-by-default', () => {
  it('a pre-1.3.4 file (stored false, no marker) loads as ON, marked, with the notice queued', async () => {
    writeSettingsFile({ autoUpdateEnabled: false })
    const { loadAppSettings, isAutoUpdateEnabled } = await freshModule()
    const s = loadAppSettings()
    expect(s.autoUpdateEnabled).toBe(true)
    expect(s.autoUpdateMigratedToDefaultOn).toBe(true)
    expect(s.autoUpdateNoticePending).toBe(true)
    expect(isAutoUpdateEnabled()).toBe(true) // the gate the updater actually reads
  })

  it('a fresh install (no file) is ON with the notice queued — a new user was not asked either', async () => {
    const { loadAppSettings } = await freshModule()
    const s = loadAppSettings()
    expect(s.autoUpdateEnabled).toBe(true)
    expect(s.autoUpdateMigratedToDefaultOn).toBe(true)
    expect(s.autoUpdateNoticePending).toBe(true)
  })

  it("after the migration, the user's explicit OFF wins forever — no re-override on any later load", async () => {
    writeSettingsFile({ autoUpdateEnabled: false }) // legacy file
    const first = await freshModule()
    expect(first.loadAppSettings().autoUpdateEnabled).toBe(true) // control: migration fired

    // The user turns it off. The save persists the marker with it.
    first.saveAppSettings({ autoUpdateEnabled: false })
    const onDisk = JSON.parse(readFileSync(join(dir, 'app-settings.json'), 'utf8'))
    expect(onDisk.autoUpdateEnabled).toBe(false) // control: their choice landed
    expect(onDisk.autoUpdateMigratedToDefaultOn).toBe(true)

    // A brand-new process (fresh module = fresh load) must respect it.
    const second = await freshModule()
    const s = second.loadAppSettings()
    expect(s.autoUpdateEnabled).toBe(false)
    expect(s.autoUpdateMigratedToDefaultOn).toBe(true)
  })

  it('dismissing the notice persists and never resurrects it', async () => {
    writeSettingsFile({ autoUpdateEnabled: false })
    const first = await freshModule()
    expect(first.loadAppSettings().autoUpdateNoticePending).toBe(true) // control
    first.saveAppSettings({ autoUpdateNoticePending: false })
    const second = await freshModule()
    const s = second.loadAppSettings()
    expect(s.autoUpdateNoticePending).toBe(false)
    expect(s.autoUpdateEnabled).toBe(true) // dismissing the card is not opting out
  })

  it('a migrated file that already says ON keeps its state and shows no queued notice unless pending', async () => {
    writeSettingsFile({
      autoUpdateEnabled: true,
      autoUpdateMigratedToDefaultOn: true,
      autoUpdateNoticePending: false
    })
    const { loadAppSettings } = await freshModule()
    const s = loadAppSettings()
    expect(s.autoUpdateEnabled).toBe(true)
    expect(s.autoUpdateNoticePending).toBe(false)
  })

  it('a pre-migration cloud payload cannot un-migrate a device (marker only moves forward)', async () => {
    // Device already migrated; a settings pull arrives from an old install
    // whose payload predates the marker. The enabled value in the payload is
    // applied (it is the user's cross-device preference surface), but the
    // marker stays — so the next load does NOT re-run the migration and
    // does NOT re-queue the notice.
    writeSettingsFile({ autoUpdateEnabled: false })
    const mod = await freshModule()
    mod.saveAppSettings({ autoUpdateNoticePending: false }) // migration persisted, notice dismissed
    mod.saveAppSettings({ autoUpdateEnabled: false } as never) // simulates the old payload's field arriving via a save/pull merge
    const onDisk = JSON.parse(readFileSync(join(dir, 'app-settings.json'), 'utf8'))
    expect(onDisk.autoUpdateMigratedToDefaultOn).toBe(true)
    const again = await freshModule()
    const s = again.loadAppSettings()
    expect(s.autoUpdateEnabled).toBe(false) // the payload's value stands…
    expect(s.autoUpdateNoticePending).toBe(false) // …and nothing re-migrates or re-notices
  })
})

describe('M29 sweep item 5 — a cloud pull must not re-enable auto-update on this device', () => {
  // Whether THIS machine downloads and executes new software is a per-device
  // decision, exactly like syncScope. The pushed payload is the WHOLE settings
  // object, so it always carries a value for autoUpdateEnabled — before the
  // fix, one unrelated edit on the desktop silently re-armed the laptop.

  it("the laptop's explicit OFF survives a pull from a device where it is ON", async () => {
    writeSettingsFile({ autoUpdateEnabled: false, autoUpdateMigratedToDefaultOn: true })
    const mod = await freshModule()
    expect(mod.loadAppSettings().autoUpdateEnabled).toBe(false) // the user's choice

    // Desktop changes something unrelated and pushes the whole object.
    const next = mod.applyPulledSettings(
      { autoUpdateEnabled: true, autoUpdateMigratedToDefaultOn: true, theme: 'dark' },
      new Date(Date.now() + 60_000).toISOString()
    )
    expect(next.autoUpdateEnabled).toBe(false) // NOT re-enabled

    const reloaded = await freshModule()
    expect(reloaded.loadAppSettings().autoUpdateEnabled).toBe(false) // and it stuck
  })

  it('a pull cannot clear the migration marker and re-arm the one-time override', async () => {
    writeSettingsFile({ autoUpdateEnabled: false, autoUpdateMigratedToDefaultOn: true })
    const mod = await freshModule()
    // A payload from an install that predates the marker entirely.
    mod.applyPulledSettings({ autoUpdateEnabled: false }, new Date(Date.now() + 60_000).toISOString())
    const onDisk = JSON.parse(readFileSync(join(dir, 'app-settings.json'), 'utf8'))
    expect(onDisk.autoUpdateMigratedToDefaultOn).toBe(true) // marker held
    const again = await freshModule()
    expect(again.loadAppSettings().autoUpdateEnabled).toBe(false) // no second override
  })

  it('the local toggle still works — the fix must not freeze the pref', async () => {
    writeSettingsFile({ autoUpdateEnabled: false, autoUpdateMigratedToDefaultOn: true })
    const mod = await freshModule()
    mod.saveAppSettings({ autoUpdateEnabled: true })
    expect(mod.loadAppSettings().autoUpdateEnabled).toBe(true)
  })

  it('syncScope stays protected too — the existing invariant is untouched', async () => {
    writeSettingsFile({
      autoUpdateMigratedToDefaultOn: true,
      syncScope: { transcripts: false }
    })
    const mod = await freshModule()
    const next = mod.applyPulledSettings(
      { syncScope: { transcripts: true } },
      new Date(Date.now() + 60_000).toISOString()
    )
    expect(next.syncScope.transcripts).toBe(false)
  })
})
