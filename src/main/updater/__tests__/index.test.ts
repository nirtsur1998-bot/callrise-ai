// M23: registerUpdater() previously had no way to actually APPLY a
// downloaded update (no quitAndInstall wiring at all — a real gap, since
// 'download' had nothing after it), and always used electron-updater's
// 'generic' provider even when the feed was a github.com repo URL (worked,
// but not what the 'github' provider — which reads Releases assets and
// electron-builder's own generated latest.yml directly — is built for).
// Both fixed; this proves the fixes rather than just that they typecheck.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: never[]) => unknown>()
  const listeners = new Map<string, (...args: never[]) => void>()
  const autoUpdater = {
    setFeedURL: vi.fn(),
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowDowngrade: true,
    allowPrerelease: true,
    checkForUpdates: vi.fn(async () => undefined),
    downloadUpdate: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(),
    on: (event: string, fn: (...args: never[]) => void) => listeners.set(event, fn)
  }
  return {
    handlers,
    listeners,
    autoUpdater,
    electron: {
      app: { getVersion: () => '1.0.0' },
      ipcMain: {
        handle: (c: string, fn: (...args: never[]) => unknown) => handlers.set(c, fn)
      }
    }
  }
})

vi.mock('electron', () => mocks.electron)
vi.mock('electron-updater', () => ({ autoUpdater: mocks.autoUpdater }))

const ORIGINAL_ENV = { ...process.env }

async function invoke(channel: string): Promise<unknown> {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`${channel} not registered`)
  return (handler as unknown as () => Promise<unknown> | unknown)()
}

function fire(event: string, ...args: unknown[]): void {
  mocks.listeners.get(event)?.(...(args as never[]))
}

beforeEach(() => {
  vi.resetModules()
  mocks.handlers.clear()
  mocks.listeners.clear()
  vi.mocked(mocks.autoUpdater.setFeedURL).mockClear()
  vi.mocked(mocks.autoUpdater.quitAndInstall).mockClear()
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe('registerUpdater — provider selection', () => {
  it('uses the github provider for a github.com feed URL', async () => {
    process.env.UPDATE_FEED_URL = 'https://github.com/nirtsur1998-bot/callrise-ai'
    const { registerUpdater } = await import('../index')
    registerUpdater()
    expect(mocks.autoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: 'github',
      owner: 'nirtsur1998-bot',
      repo: 'callrise-ai'
    })
  })

  it('falls back to the generic provider for a non-github https feed', async () => {
    process.env.UPDATE_FEED_URL = 'https://updates.callrise.ai/'
    const { registerUpdater } = await import('../index')
    registerUpdater()
    expect(mocks.autoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://updates.callrise.ai/'
    })
  })

  it('stays disabled and never calls setFeedURL when no feed is configured', async () => {
    delete process.env.UPDATE_FEED_URL
    const { registerUpdater, updateStatus } = await import('../index')
    registerUpdater()
    expect(mocks.autoUpdater.setFeedURL).not.toHaveBeenCalled()
    expect(updateStatus().state).toBe('disabled')
  })
})

describe('registerUpdater — install handler', () => {
  it('only quits and installs from a downloaded state', async () => {
    process.env.UPDATE_FEED_URL = 'https://github.com/nirtsur1998-bot/callrise-ai'
    const { registerUpdater } = await import('../index')
    registerUpdater()

    // Not downloaded yet (status starts 'idle') — must refuse.
    const refused = await invoke('updater:install')
    expect(refused).toEqual({ ok: false })
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled()

    // Drive status to 'downloaded' via the real event handler, then retry.
    fire('update-downloaded', { version: '2.0.0' })
    const accepted = await invoke('updater:install')
    expect(accepted).toEqual({ ok: true })
    expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledOnce()
  })

  it('never registers an install handler at all when disabled', async () => {
    delete process.env.UPDATE_FEED_URL
    const { registerUpdater } = await import('../index')
    registerUpdater()
    await expect(invoke('updater:install')).rejects.toThrow('not registered')
  })
})
