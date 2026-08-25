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
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { getStatus } from './tier1'
import { scrubbedCopy } from './scrubbed-copy'
import { createLocalScrubber } from './scrub'

/** Whole-document scrubber. The app-wide `scrub()` caps a single string at
 *  4096 chars, which is right for a log LINE and wrong for a JSON document
 *  — it would truncate the file into unparseable output. */
const scrubDocument = createLocalScrubber({ maxLength: Number.MAX_SAFE_INTEGER })

/** The complete list of engine files eligible for collection. A pure
 *  function of the LOCALAPPDATA root so tests can point it at a fixture
 *  tree — and so the privacy claim above is checkable by reading one array. */
export function engineDiagnosticFiles(localAppData: string): string[] {
  const root = join(localAppData, 'CallRiseAI')
  return [
    join(root, 'logs', 'kern_bridge.log'),
    // The engine's ROTATED log. SOURCE OF TRUTH IS THE C++ WRITER, NOT THIS
    // LIST — kern_bridge.cpp, verified 2026-08-25 at these exact lines:
    //
    //   :614   g_logPathPrev = g_logPath + L".1";      <- builds the name
    //   :288   #define LOG_MAX_BYTES (2 * 1024 * 1024) <- rotates at 2 MB
    //   :1423  startup banner: "rotates at %d MB, one previous kept as .1"
    //
    // This list said `kern_bridge.prev.log` until BUG-094 — a name that appears
    // NOWHERE in the engine source. `existsSync` was therefore always false and
    // the rotated log has never been collected by this export. The live log was
    // at 2,064,534 bytes against that 2 MB threshold when this was found, so
    // the next engine start moves the entire history of whatever the user is
    // reporting into a file the export ignores: a support bundle can arrive
    // missing the exact evidence it was sent for, and nobody can tell.
    //
    // WHY THE TESTS WERE GREEN: the fixtures were written from THIS list's
    // expectation rather than cross-checked against the writer. A fixture that
    // agrees with the thing it is testing proves only that they agree. If you
    // change this name, change it against kern_bridge.cpp — not against the
    // tests, which will happily follow you.
    join(root, 'logs', 'kern_bridge.log.1'),
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
      // BUG-094 — this was a raw copyFileSync and this module never imported a
      // scrubber at all, so the zip shipped kern_bridge.log BYTE FOR BYTE,
      // including the `C:\Users\<name>\…` paths every line carries. The whole
      // purpose of this file is to be sent to someone else, which makes it an
      // egress path, not a local artifact.
      //
      // scrubbedCopy returns false rather than throwing, which preserves the
      // skip-never-fatal behaviour this loop always had: a locked or unreadable
      // log is skipped, and partial diagnostics still beat none.
      if (scrubbedCopy(src, join(staging, src.split(/[\\/]/).pop()!))) collected++
    }
    // The renderer supplies deviceLabels — EVERY audio input's raw label from
    // enumerateDevices(), not just the selected one — and those routinely carry
    // a person's name ("<name>'s AirPods"). tier1Status carries enginePath, an
    // absolute path. Both are scrubbed here.
    //
    // KNOWN LIMIT, tracked separately: a bare personal name inside a device
    // label has no path separator, no delimiter and no structure, so a
    // line-based scrubber CANNOT catch it without redacting every capitalised
    // word. Scrubbing this document does not solve device labels and must not
    // be read as having solved them.
    writeFileSync(
      join(staging, 'app-diagnostics.json'),
      scrubDocument(buildAppDiagnostics(renderer)),
      'utf8'
    )
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
