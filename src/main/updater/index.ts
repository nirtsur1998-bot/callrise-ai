// Auto-update wiring (§5.3).
//
// Two properties, both deliberate:
//
// IT IS INERT UNTIL A REAL FEED IS CONFIGURED. electron-builder's publish block
// still carries electron-vite's scaffold placeholder
// (https://example.com/auto-updates), and an updater pointed at a domain you do
// not control is a supply-chain compromise waiting for someone to register it.
// So the feed comes from UPDATE_FEED_URL and is checked by isTrustedFeed before
// a single request is made. Unset or untrusted means no network activity at
// all — not a failed check, no check.
//
// EVERY VALIDATION ERROR REJECTS. The canonical failure in this class does not
// look like an attack, it looks like a bug: in the 2020 Doyensec bypass a
// filename containing one quote caused a PowerShell parse error, the signature
// check returned null, null was read as "no problem found", and the update
// installed. So nothing here treats absence of a failure as a pass, and the
// promise chain below cannot silently resolve into an install.

import { app, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import { isTrustedFeed, validateUpdate } from './policy'

export type UpdateStatus =
  | { state: 'disabled'; reason: string }
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'refused'; reason: string }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }

let status: UpdateStatus = { state: 'disabled', reason: 'not initialised' }
let enabled = false

export function updateStatus(): UpdateStatus {
  return status
}

function feedUrl(): string | undefined {
  return process.env.UPDATE_FEED_URL?.trim() || undefined
}

let registered = false

export function registerUpdater(): void {
  if (registered) return
  registered = true

  const trusted = isTrustedFeed(feedUrl())
  if (!trusted.ok) {
    status = { state: 'disabled', reason: trusted.reason }
    console.log(`[updater] disabled: ${trusted.reason}`)
    // Deliberately no listeners and no check. A disabled updater must make no
    // network requests, not make them and ignore the answer.
    ipcMain.handle('updater:status', () => status)
    ipcMain.handle('updater:check', () => status)
    return
  }

  enabled = true
  autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl() as string })

  // Nothing downloads or installs without the user asking. An updater that
  // stages an install on quit takes the decision away from the person whose
  // machine it is.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  // A downgrade is the move an attacker makes: reinstall a version whose bugs
  // they already know how to use.
  autoUpdater.allowDowngrade = false
  autoUpdater.allowPrerelease = false

  autoUpdater.on('checking-for-update', () => {
    status = { state: 'checking' }
  })

  autoUpdater.on('update-available', (info) => {
    // OUR gate, in addition to electron-updater's own signature and checksum
    // verification — not instead of it. This one runs before any download, on
    // the metadata itself, because `latest.yml` is fetched over the network
    // before anything about it has been verified.
    const verdict = validateUpdate(
      { version: info?.version, path: info?.path, sha512: info?.sha512 },
      app.getVersion()
    )
    if (!verdict.ok) {
      status = { state: 'refused', reason: verdict.reason }
      console.warn(`[updater] refused update: ${verdict.reason}`)
      return
    }
    status = { state: 'available', version: String(info.version) }
  })

  autoUpdater.on('update-not-available', () => {
    status = { state: 'idle' }
  })

  autoUpdater.on('update-downloaded', (info) => {
    status = { state: 'downloaded', version: String(info?.version ?? '') }
  })

  autoUpdater.on('error', (err) => {
    // An error is a refusal. It is never "carry on and hope".
    status = { state: 'error', message: err?.message ?? 'update check failed' }
    console.warn(`[updater] error: ${status.state === 'error' ? status.message : ''}`)
  })

  ipcMain.handle('updater:status', () => status)

  ipcMain.handle('updater:check', async () => {
    if (!enabled) return status
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      status = {
        state: 'error',
        message: err instanceof Error ? err.message : 'update check failed'
      }
    }
    return status
  })

  ipcMain.handle('updater:download', async () => {
    // Only from a state our own gate has already accepted. Re-checked here
    // rather than trusted from the renderer, which could ask at any time.
    if (!enabled || status.state !== 'available') return status
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      status = {
        state: 'error',
        message: err instanceof Error ? err.message : 'update download failed'
      }
    }
    return status
  })

  status = { state: 'idle' }
  console.log('[updater] enabled')
}
