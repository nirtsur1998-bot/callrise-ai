// M27 Tier 1 — "Export diagnostics": collect the noise-cancellation logs and
// this PC's audio state into one zip the user can attach to a support email.
//
// WHY THIS EXISTS. Every Tier 1 field failure so far was diagnosed from
// exactly two artifacts: the engine's own log (which mic it grabbed, whether
// the model loaded, the meter lines) and the status sidecar. Both live on the
// user's machine, and asking a non-technical user to fish files out of
// %LOCALAPPDATA% mid-support-thread loses a day per round trip. One button,
// one zip, attach it.
//
// PRIVACY, BY CONSTRUCTION rather than by promise: the inputs are enumerated
// below and nothing else is read. kern_bridge.log contains device names,
// dB meter lines and engine state transitions — no audio. The status sidecar
// is four fields. app-diagnostics.json is app version + Tier 1 state + the
// device LABELS the renderer already shows the user. No call audio, no
// recordings, no transcripts are anywhere in the collected set.
import { app, dialog, ipcMain, BrowserWindow } from 'electron'
import { execFile } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { getStatus } from './tier1'

/** The complete list of engine files eligible for collection. A pure
 *  function of the LOCALAPPDATA root so tests can point it at a fixture
 *  tree — and so the privacy claim above is checkable by reading one array. */
export function engineDiagnosticFiles(localAppData: string): string[] {
  const root = join(localAppData, 'CallRiseAI')
  return [
    join(root, 'logs', 'kern_bridge.log'),
    join(root, 'logs', 'kern_bridge.prev.log'),
    join(root, 'kern_bridge_status.json')
  ]
}

/** What the renderer contributes: state only IT can see. */
export interface RendererDiagnostics {
  /** Device labels from enumerateDevices() — names, never ids or streams. */
  deviceLabels?: string[]
  tier1Enabled?: boolean
  denoiseStrength?: string
}

/** Builds the app-side diagnostics JSON. Pure; exported for tests. */
export function buildAppDiagnostics(renderer: RendererDiagnostics): string {
  return JSON.stringify(
    {
      collectedAt: new Date().toISOString(),
      appVersion: app.getVersion(),
      platform: process.platform,
      tier1Status: getStatus(),
      tier1Enabled: renderer.tier1Enabled ?? null,
      denoiseStrength: renderer.denoiseStrength ?? null,
      deviceLabels: Array.isArray(renderer.deviceLabels)
        ? renderer.deviceLabels.filter((l): l is string => typeof l === 'string')
        : []
    },
    null,
    2
  )
}

/**
 * Zips `stagingDir` to `zipPath` using Windows' built-in Compress-Archive.
 *
 * PowerShell rather than a bundled zip dependency, deliberately: this
 * feature is Windows-only (Tier 1 is), Compress-Archive has shipped in-box
 * since PowerShell 5, and a new production dependency for one support
 * feature is a worse trade than shelling out. execFile (not exec) so the
 * paths are passed as argv, never interpolated into a shell string.
 */
function compressToZip(stagingDir: string, zipPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Compress-Archive -Path $env:CR_DIAG_SRC -DestinationPath $env:CR_DIAG_DEST -Force'
      ],
      {
        // Via environment, not string interpolation: a user name containing
        // a quote (or worse) must never reach PowerShell as syntax.
        env: {
          ...process.env,
          CR_DIAG_SRC: join(stagingDir, '*'),
          CR_DIAG_DEST: zipPath
        },
        windowsHide: true,
        timeout: 30_000
      },
      (err) => (err ? reject(err) : resolve())
    )
  })
}

export async function exportTier1Diagnostics(
  renderer: RendererDiagnostics
): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const defaultName = `callrise-diagnostics-${new Date().toISOString().slice(0, 10)}.zip`
  const { canceled, filePath } = await dialog.showSaveDialog(win!, {
    title: 'Save diagnostics',
    defaultPath: join(app.getPath('downloads'), defaultName),
    filters: [{ name: 'Zip archive', extensions: ['zip'] }]
  })
  if (canceled || !filePath) return { ok: false, canceled: true }

  const staging = join(tmpdir(), `callrise-diag-${Date.now()}`)
  try {
    mkdirSync(staging, { recursive: true })

    let collected = 0
    for (const src of engineDiagnosticFiles(process.env['LOCALAPPDATA'] ?? '')) {
      if (!existsSync(src)) continue
      try {
        copyFileSync(src, join(staging, src.split(/[\\/]/).pop()!))
        collected++
      } catch {
        /* a locked/unreadable log is skipped, never fatal — partial
           diagnostics still beat none */
      }
    }
    writeFileSync(join(staging, 'app-diagnostics.json'), buildAppDiagnostics(renderer), 'utf8')
    collected++

    await compressToZip(staging, filePath)
    return { ok: true, path: filePath }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    try {
      rmSync(staging, { recursive: true, force: true })
    } catch {
      /* temp dir cleanup is best-effort */
    }
  }
}

export function registerTier1Diagnostics(): void {
  ipcMain.handle('tier1:exportDiagnostics', (_e, renderer: unknown) =>
    exportTier1Diagnostics(
      renderer && typeof renderer === 'object' ? (renderer as RendererDiagnostics) : {}
    )
  )
}
