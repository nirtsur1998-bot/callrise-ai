// M29 sweep item 5 — "the app must never do the thing the user declined."
//
// Two trust violations found by the sweep, both about auto-update:
//   (a) autoInstallOnAppQuit was set ONLY inside the update-downloaded
//       handler, so turning auto-update off AFTER a download still installed
//       on the next quit.
//   (b) a cloud settings pull re-enabled auto-update on a device where the
//       user had turned it off (covered in app-settings' own suite).
//
// This file covers (a). It needs a CONTROLLABLE preference, unlike
// index.test.ts which deliberately pins it to false for the whole file, so it
// carries its own mock set.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (...args: never[]) => void>()
  return {
    listeners,
    prefOn: true,
    /** The callback registered via setAutoUpdateEnabledChangedListener. */
    onPrefChanged: null as null | (() => void),
    autoUpdater: {
      setFeedURL: vi.fn(),
      autoDownload: true,
      autoInstallOnAppQuit: false,
      allowDowngrade: true,
      allowPrerelease: true,
      checkForUpdates: vi.fn(async () => undefined),
      downloadUpdate: vi.fn(async () => undefined),
      quitAndInstall: vi.fn(),
      on: (event: string, fn: (...args: never[]) => void) => listeners.set(event, fn)
    }
  }
})

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0' },
  ipcMain: { handle: vi.fn() }
}))
vi.mock('electron-updater', () => ({ autoUpdater: mocks.autoUpdater }))
vi.mock('../../app-settings', () => ({
  isAutoUpdateEnabled: () => mocks.prefOn,
  setAutoUpdateEnabledChangedListener: (fn: () => void) => {
    mocks.onPrefChanged = fn
  }
}))
vi.mock('../../jobs/instance', () => ({
  getJobManager: () => ({
    registerType: vi.fn(),
    list: () => [],
    enqueue: () => ({ id: 'job-1' })
  })
}))

function fire(event: string, ...args: unknown[]): void {
  mocks.listeners.get(event)?.(...(args as never[]))
}

/** Flip the pref the way Settings does, then let the updater react. */
function setAutoUpdate(on: boolean): void {
  mocks.prefOn = on
  mocks.onPrefChanged?.()
}

beforeEach(async () => {
  vi.resetModules()
  mocks.listeners.clear()
  mocks.onPrefChanged = null
  mocks.prefOn = true
  mocks.autoUpdater.autoInstallOnAppQuit = false
  process.env.UPDATE_FEED_URL = 'https://github.com/nirtsur1998-bot/callrise-ai'
  const { registerUpdater } = await import('../index')
  registerUpdater()
})

describe('turning auto-update off must cancel a PENDING install, not just future checks', () => {
  it('off AFTER an update has downloaded clears autoInstallOnAppQuit', () => {
    // 09:00 — the background check finds an update and it downloads.
    fire('update-downloaded', { version: '1.4.0' })
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true)

    // 11:00 — the user sees "restart to install", decides they do not want
    // this, and flips the Settings toggle off.
    setAutoUpdate(false)

    // 18:00 — they quit. electron-updater re-reads this flag in its own quit
    // handler, so `false` here is what stops the install.
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(false)
  })

  it('turning it back on re-arms the pending install', () => {
    fire('update-downloaded', { version: '1.4.0' })
    setAutoUpdate(false)
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(false)
    setAutoUpdate(true)
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true)
  })

  it('with the pref off at download time the flag never latches on', () => {
    setAutoUpdate(false)
    fire('update-downloaded', { version: '1.4.0' })
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(false)
  })

  it('the flag tracks the pref even with no update in flight', () => {
    setAutoUpdate(false)
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(false)
    setAutoUpdate(true)
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true)
  })
})
