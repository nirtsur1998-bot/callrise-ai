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
    // M26 Batch 5 — what the download job did, recorded for assertions.
    registeredJobTypes: [] as string[],
    enqueued: [] as string[],
    electron: {
      app: { getVersion: () => '1.0.0' },
      ipcMain: {
        handle: (c: string, fn: (...args: never[]) => unknown) => handlers.set(c, fn)
      }
    }
  }
})

vi.mock('electron', () => mocks.electron)

// M29: auto-update is ON by default now, and these tests used to INHERIT the
// old off-default from real loadAppSettings() (whose app.getPath throws under
// this electron mock, landing on DEFAULT_SETTINGS). The manual-mode tests'
// premise is "auto mode off", so the pref is pinned here explicitly instead
// of borrowed from whatever the product default happens to be.
vi.mock('../../app-settings', () => ({
  isAutoUpdateEnabled: () => false,
  setAutoUpdateEnabledChangedListener: vi.fn()
}))
vi.mock('electron-updater', () => ({ autoUpdater: mocks.autoUpdater }))

// M26 Batch 5 — registerUpdater() now registers a job type for the download
// (so it can report a real percentage instead of a fake spinner), which
// means it needs the shared JobManager. Production always has one by then;
// this minimal stand-in keeps these tests focused on what they cover, and
// records the enqueues so the download tests can assert on them.
vi.mock('../../jobs/instance', () => ({
  getJobManager: () => ({
    registerType: (def: { type: string }) => {
      mocks.registeredJobTypes.push(def.type)
    },
    list: () => [],
    enqueue: (type: string) => {
      mocks.enqueued.push(type)
      return { id: `job-${mocks.enqueued.length}` }
    }
  })
}))

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
  mocks.registeredJobTypes.length = 0
  mocks.enqueued.length = 0
  vi.mocked(mocks.autoUpdater.setFeedURL).mockClear()
  vi.mocked(mocks.autoUpdater.quitAndInstall).mockClear()
  vi.mocked(mocks.autoUpdater.downloadUpdate).mockClear()
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

// M26 Batch 5 — the download runs as a job so it can report the REAL
// percentage electron-updater already emits (nothing listened before, so
// the UI showed a fake spinner for the longest operation in the product).
describe('registerUpdater — download as a job', () => {
  // A real-shaped checksum: validateUpdate requires base64 SHA-512
  // (86 chars + '=='), and rightly refuses anything else — so a lazy 'abc'
  // fixture would be refused by the gate and never reach the download.
  const VALID_SHA512 = `${'A'.repeat(86)}==`

  async function enabledUpdater(): Promise<void> {
    process.env.UPDATE_FEED_URL = 'https://github.com/nirtsur1998-bot/callrise-ai'
    const { registerUpdater } = await import('../index')
    registerUpdater()
  }

  it('registers the download job type', async () => {
    await enabledUpdater()
    expect(mocks.registeredJobTypes).toContain('updater:download')
  })

  it('registers NO job type when the updater is disabled — a disabled updater wires up nothing', async () => {
    delete process.env.UPDATE_FEED_URL
    const { registerUpdater } = await import('../index')
    registerUpdater()
    expect(mocks.registeredJobTypes).toEqual([])
  })

  it('the manual download button enqueues the job instead of downloading inline', async () => {
    await enabledUpdater()
    fire('update-available', { version: '2.0.0', path: 'app.exe', sha512: VALID_SHA512 })

    await invoke('updater:download')

    expect(mocks.enqueued).toEqual(['updater:download'])
    // The IPC returns immediately now; the executor is what downloads.
    expect(mocks.autoUpdater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('refuses to enqueue from a state our own gate has not accepted', async () => {
    await enabledUpdater()
    // status is 'idle' — never went through update-available.
    await invoke('updater:download')
    expect(mocks.enqueued).toEqual([])
  })

  it('does not enqueue for an update our gate REFUSED, even in auto mode', async () => {
    await enabledUpdater()
    // A downgrade — validateUpdate rejects it, so no download may start,
    // even though the checksum itself is perfectly well-formed.
    fire('update-available', { version: '0.0.1', path: 'app.exe', sha512: VALID_SHA512 })
    expect(mocks.enqueued).toEqual([])
    await invoke('updater:download')
    expect(mocks.enqueued).toEqual([])
  })
})

describe('M29 — the update check carries nothing stable about the install', () => {
  it('registerUpdater blanks the x-user-staging-id header electron-updater would otherwise send', async () => {
    // electron-updater fills this header with the per-install .updaterId
    // UUID on every check (AppUpdater.js:386) and merges OUR requestHeaders
    // last — so registerUpdater must set it to the empty string. The staged
    // rollout decision is made locally from the file, so blanking the
    // header changes nothing about rollout behaviour.
    process.env.UPDATE_FEED_URL = 'https://github.com/nirtsur1998-bot/callrise-ai'
    const { registerUpdater } = await import('../index')
    registerUpdater()
    expect(
      (mocks.autoUpdater as unknown as { requestHeaders: Record<string, string> }).requestHeaders
    ).toEqual({ 'x-user-staging-id': '' })
  })
})
