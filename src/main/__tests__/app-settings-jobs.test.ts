// M26 Phase 5 — per-lane job concurrency + job-completion notification
// preferences, moved into app-settings.ts's AppSettings so JobManager
// (concurrency) and jobs/activity.ts (notifications) can both read a
// persisted, user-adjustable value instead of a hardcoded default. Drives
// the REAL loadAppSettings()/saveAppSettings() against a real temp file —
// same pattern as app-settings-live-engines.test.ts.
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
  dir = mkdtempSync(join(tmpdir(), 'app-settings-jobs-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('jobConcurrency — defaults, clamping, and getter', () => {
  it('a fresh install matches JobManager\'s own hardcoded DEFAULT_LANE_CONFIG', async () => {
    const { loadAppSettings } = await freshModule()
    expect(loadAppSettings().jobConcurrency).toEqual({ interactive: 2, batch: 1, maintenance: 1 })
  })

  it('clamps below 1 up to 1 — 0 would deadlock that lane forever', async () => {
    const { saveAppSettings } = await freshModule()
    const next = saveAppSettings({ jobConcurrency: { interactive: 0 } })
    expect(next.jobConcurrency.interactive).toBe(1)
  })

  it('clamps above 10 down to 10', async () => {
    const { saveAppSettings } = await freshModule()
    const next = saveAppSettings({ jobConcurrency: { batch: 999 } })
    expect(next.jobConcurrency.batch).toBe(10)
  })

  it('a non-numeric value falls back to the current value, not a crash', async () => {
    const { saveAppSettings, loadAppSettings } = await freshModule()
    saveAppSettings({ jobConcurrency: { maintenance: 'lots' as never } })
    expect(loadAppSettings().jobConcurrency.maintenance).toBe(1) // unchanged default
  })

  it('rounds a fractional value to the nearest integer', async () => {
    const { saveAppSettings } = await freshModule()
    const next = saveAppSettings({ jobConcurrency: { interactive: 3.7 } })
    expect(next.jobConcurrency.interactive).toBe(4)
  })

  it('each lane updates independently, leaving the others untouched', async () => {
    const { saveAppSettings } = await freshModule()
    saveAppSettings({ jobConcurrency: { interactive: 5 } })
    const next = saveAppSettings({ jobConcurrency: { batch: 3 } })
    expect(next.jobConcurrency).toEqual({ interactive: 5, batch: 3, maintenance: 1 })
  })

  it('getJobConcurrencySettings() reflects a just-saved value, read fresh', async () => {
    const { saveAppSettings, getJobConcurrencySettings } = await freshModule()
    expect(getJobConcurrencySettings().interactive).toBe(2)
    saveAppSettings({ jobConcurrency: { interactive: 6 } })
    expect(getJobConcurrencySettings().interactive).toBe(6)
  })

  it('a real restart (fresh module import) reads back what was persisted to disk', async () => {
    const first = await freshModule()
    first.saveAppSettings({ jobConcurrency: { interactive: 4, batch: 2, maintenance: 3 } })
    const second = await freshModule()
    expect(second.loadAppSettings().jobConcurrency).toEqual({
      interactive: 4,
      batch: 2,
      maintenance: 3
    })
  })
})

describe('jobConcurrency — live-change listener', () => {
  it('fires only when the concurrency object actually changes', async () => {
    const { saveAppSettings, setJobConcurrencyChangedListener } = await freshModule()
    const fired = vi.fn()
    setJobConcurrencyChangedListener(fired)

    saveAppSettings({ allowOtherPartyRecording: false }) // unrelated field
    expect(fired).not.toHaveBeenCalled()

    saveAppSettings({ jobConcurrency: { interactive: 5 } })
    expect(fired).toHaveBeenCalledTimes(1)

    saveAppSettings({ jobConcurrency: { interactive: 5 } }) // same value again
    expect(fired).toHaveBeenCalledTimes(1) // no-op, no spurious re-fire
  })

  it('a listener that throws never fails the settings save', async () => {
    const { saveAppSettings, setJobConcurrencyChangedListener } = await freshModule()
    setJobConcurrencyChangedListener(() => {
      throw new Error('boom')
    })
    expect(() => saveAppSettings({ jobConcurrency: { batch: 4 } })).not.toThrow()
  })
})

describe('jobNotifications — defaults, sanitize, merge, getter', () => {
  it('defaults to on, matching the unconditional behavior before this setting existed', async () => {
    const { loadAppSettings, isJobNativeNotificationsEnabled } = await freshModule()
    expect(loadAppSettings().jobNotifications).toEqual({ nativeEnabled: true })
    expect(isJobNativeNotificationsEnabled()).toBe(true)
  })

  it('a non-boolean patch value is treated as false, same convention as every other boolean merge in this file (mergeSalesBrain, etc.) — only a literal `true` sets it true', async () => {
    const { saveAppSettings, loadAppSettings } = await freshModule()
    saveAppSettings({ jobNotifications: { nativeEnabled: 'yes' as never } })
    expect(loadAppSettings().jobNotifications.nativeEnabled).toBe(false)
  })

  it('a corrupt/garbage value on LOAD (not a patch) collapses to the safe default (on)', async () => {
    const { writeFileSync } = await import('node:fs')
    const { app } = await import('electron')
    const { join } = await import('node:path')
    writeFileSync(
      join(app.getPath('userData'), 'app-settings.json'),
      JSON.stringify({ jobNotifications: { nativeEnabled: 'garbage' } }),
      'utf8'
    )
    const { loadAppSettings } = await freshModule()
    expect(loadAppSettings().jobNotifications.nativeEnabled).toBe(true)
  })

  it('turning it off persists and is read back fresh by the getter', async () => {
    const { saveAppSettings, isJobNativeNotificationsEnabled } = await freshModule()
    saveAppSettings({ jobNotifications: { nativeEnabled: false } })
    expect(isJobNativeNotificationsEnabled()).toBe(false)
  })

  it('a real restart (fresh module import) reads back what was persisted to disk', async () => {
    const first = await freshModule()
    first.saveAppSettings({ jobNotifications: { nativeEnabled: false } })
    const second = await freshModule()
    expect(second.loadAppSettings().jobNotifications.nativeEnabled).toBe(false)
  })
})
