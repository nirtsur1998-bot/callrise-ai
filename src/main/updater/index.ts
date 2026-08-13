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
import { githubRepoFromFeed, isTrustedFeed, validateUpdate } from './policy'
import { isAutoUpdateEnabled, setAutoUpdateEnabledChangedListener } from '../app-settings'
import { getJobManager } from '../jobs/instance'
import type { Job } from '../jobs/types'

// How often the background check runs when auto-update is on. Not too eager
// (this is a network request against GitHub's API on every user's machine)
// and not so rare that a security fix sits unseen for days.
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 hours
// Give the app a moment to finish starting up before the first background
// check — nothing about update-checking should compete with call-detection
// or transcription for the first few seconds after launch.
const FIRST_CHECK_DELAY_MS = 30 * 1000

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

/** M26 Batch 5 — the update download's job type. */
const DOWNLOAD_JOB_TYPE = 'updater:download'

/** Start a download job unless one is already queued or running. Both the
 *  manual button and auto-mode's own trigger come through here, so they can
 *  never race into two concurrent downloads sharing one
 *  'download-progress' event stream. Never throws into its caller — a
 *  failed enqueue must not break an update check. */
function startDownloadJob(): void {
  try {
    const manager = getJobManager()
    const already = manager
      .list()
      .find(
        (j: Job) => j.type === DOWNLOAD_JOB_TYPE && (j.state === 'running' || j.state === 'queued')
      )
    if (already) return
    manager.enqueue(DOWNLOAD_JOB_TYPE, {})
  } catch (err) {
    console.error('[updater] could not start the download job:', err)
  }
}

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
  const url = feedUrl() as string
  // A github.com repo URL gets electron-updater's dedicated 'github'
  // provider (reads the repo's Releases assets + its own generated
  // latest.yml directly) instead of 'generic' — no behavior change to the
  // trust check above, isTrustedFeed already accepted this exact URL either
  // way; this only decides which HTTP client electron-updater uses to fetch
  // update metadata from it.
  const gh = githubRepoFromFeed(url)
  if (gh) {
    autoUpdater.setFeedURL({ provider: 'github', owner: gh.owner, repo: gh.repo })
  } else {
    autoUpdater.setFeedURL({ provider: 'generic', url })
  }

  // Nothing downloads or installs without the user asking AT LEAST ONCE.
  // Manual mode (default) needs an explicit click for every step. Opting
  // into `autoUpdateEnabled` in Settings IS that one ask — from then on,
  // download and install-on-quit happen without further clicks. Either way
  // it's the user's own decision, never an updater that decides for them.
  // applyAutoUpdatePreference (below) sets the real values from the current
  // setting; these are just the safe starting point before that first read.
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
    // before anything about it has been verified. autoDownload stays FALSE
    // always (see above) specifically so this gate is always the thing that
    // decides whether a download starts, in both manual and auto mode — the
    // library's own autoDownload flag would start downloading before this
    // handler even runs, which would make the gate advisory instead of
    // authoritative.
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
    // Auto mode downloads without a further click — now through the same
    // job as the manual button, so a background download is visible in the
    // Activity Center and on the taskbar instead of happening invisibly.
    if (isAutoUpdateEnabled()) startDownloadJob()
  })

  autoUpdater.on('update-not-available', () => {
    status = { state: 'idle' }
  })

  // M26 Batch 5 — the download as a MAINTENANCE-lane job reporting a REAL
  // percentage. electron-updater has always emitted 'download-progress'
  // with an exact percent; nothing in the app ever listened, so the UI
  // showed a fake indeterminate spinner for what is often the longest
  // single operation in the product. This is the whole "free win" the
  // Phase 0 inventory flagged: the number already existed, it just had
  // nowhere to go.
  //
  // Not cancellable: electron-updater exposes no way to abort a download
  // in flight, and pretending otherwise would give the rep a Cancel button
  // that silently does nothing.
  getJobManager().registerType<Record<string, never>, string>({
    type: DOWNLOAD_JOB_TYPE,
    lane: 'MAINTENANCE',
    titleFor: () => 'Downloading update',
    cancellable: false,
    executor: {
      kind: 'inline-async',
      run: async (_input, handle) => {
        handle.reportProgress({
          mode: 'determinate',
          itemsDone: 0,
          itemsTotal: 100,
          unit: 'percent'
        })
        // 'download-progress' is a singleton event on autoUpdater, not
        // scoped to one call — safe here only because MAINTENANCE runs one
        // at a time AND the enqueue path below refuses a second concurrent
        // download. Removed in `finally` so a later download never reports
        // into this job's handle.
        const onProgress = (p: { percent?: number }): void => {
          const percent = Math.max(0, Math.min(100, Math.round(p?.percent ?? 0)))
          handle.reportProgress({
            mode: 'determinate',
            itemsDone: percent,
            itemsTotal: 100,
            unit: 'percent'
          })
        }
        autoUpdater.on('download-progress', onProgress)
        try {
          await autoUpdater.downloadUpdate()
          return status.state === 'downloaded' ? status.version : ''
        } catch (err) {
          // Keep the module-level status authoritative for the Settings
          // card, which reads it directly, then rethrow so the job itself
          // records the failure too.
          status = {
            state: 'error',
            message: err instanceof Error ? err.message : 'update download failed'
          }
          throw err
        } finally {
          autoUpdater.off('download-progress', onProgress)
        }
      }
    }
  })

  autoUpdater.on('update-downloaded', (info) => {
    status = { state: 'downloaded', version: String(info?.version ?? '') }
    // Only reached after OUR gate above already accepted this exact update —
    // safe to let it install itself on the next natural quit rather than
    // waiting for a manual "Restart & install" click.
    autoUpdater.autoInstallOnAppQuit = isAutoUpdateEnabled()
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
    // Returns immediately now: the download runs as a job, and the Settings
    // card keeps reading `status` exactly as before. The real percentage
    // shows in the Activity Center and on the taskbar.
    startDownloadJob()
    return status
  })

  // Only from 'downloaded' — same reasoning as 'download' above: this is a
  // quit-and-relaunch, so it must be a state OUR gate already verified this
  // update against, not something the renderer can trigger unconditionally.
  // No status transition on success: the app is about to quit.
  ipcMain.handle('updater:install', () => {
    if (!enabled || status.state !== 'downloaded') return { ok: false as const }
    autoUpdater.quitAndInstall()
    return { ok: true as const }
  })

  // --- Background auto-check (only while autoUpdateEnabled) -----------------
  // A silent check on a timer, purely additive to the manual "Check for
  // updates" button — never runs unless the user opted in, and a failure
  // here is exactly as inert as a failed manual check (status goes to
  // 'error', nothing crashes, nothing retries in a tight loop).
  let checkInterval: ReturnType<typeof setInterval> | null = null
  let firstCheckTimer: ReturnType<typeof setTimeout> | null = null

  const runBackgroundCheck = (): void => {
    if (!isAutoUpdateEnabled() || status.state === 'checking') return
    autoUpdater.checkForUpdates().catch((err) => {
      status = {
        state: 'error',
        message: err instanceof Error ? err.message : 'update check failed'
      }
    })
  }

  const applyAutoUpdatePreference = (): void => {
    const on = isAutoUpdateEnabled()
    // Only affects an update not yet found — a download or install already
    // in flight from before the toggle changed is left to finish/settle on
    // its own rather than being torn out from under the user mid-action.
    if (on && !checkInterval) {
      firstCheckTimer = setTimeout(runBackgroundCheck, FIRST_CHECK_DELAY_MS)
      checkInterval = setInterval(runBackgroundCheck, AUTO_CHECK_INTERVAL_MS)
    } else if (!on && checkInterval) {
      clearInterval(checkInterval)
      checkInterval = null
      if (firstCheckTimer) {
        clearTimeout(firstCheckTimer)
        firstCheckTimer = null
      }
    }
  }

  setAutoUpdateEnabledChangedListener(applyAutoUpdatePreference)
  applyAutoUpdatePreference()

  status = { state: 'idle' }
  console.log('[updater] enabled')
}
