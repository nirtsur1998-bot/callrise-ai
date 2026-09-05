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
import { createLocalScrubber } from './telemetry/scrub'

/** Whole-document scrubber (no 4096-char cap) — see support-bundle.ts for
 *  why a document needs a different instance from a log line. */
const scrubDocument = createLocalScrubber({ maxLength: Number.MAX_SAFE_INTEGER })

/** The complete list of engine files eligible for collection. A pure
 *  function of the LOCALAPPDATA root so tests can point it at a fixture
 *  tree — and so the privacy claim above is checkable by reading one array. */
export function engineDiagnosticFiles(localAppData: string): string[] {
  const root = join(localAppData, 'CallRiseAI')
  return [
    join(root, 'logs', 'kern_bridge.log'),
    // The engine's ROTATED log. It is `kern_bridge.log.1` — see kern_bridge.cpp
    // (`g_logPathPrev = g_logPath + L".1"`, and its own startup banner says
    // "one previous kept as .1"). This list said `kern_bridge.prev.log` until
    // the M29 sweep, a name that appears NOWHERE in the engine source, so
    // `existsSync` was always false and the rotated log was silently collected
    // by neither this export nor M29's support bundle. Rotation fires at 2 MB
    // and the live log was already at 2,064,534 bytes — i.e. the very next
    // engine start moves the whole history of whatever the user is reporting
    // into a file both exports ignored. The fixtures were written from this
    // list's expectation rather than cross-checked against the C++ writer,
    // which is why the tests were green.
    join(root, 'logs', 'kern_bridge.log.1'),
    join(root, 'kern_bridge_status.json')
  ]
}

/** BUG-122 — what the bundle says about the device list: a classification
 *  derived from keywords in the labels (renderer/features/audio/deviceKinds),
 *  NEVER a label. A label is a person's name often enough ("Dana's AirPods")
 *  and the scrubber structurally cannot catch a bare name; you cannot scrub a
 *  name, only refuse to include it. Founder: "labels don't go in the bundle
 *  at all." */
export interface DeviceSummary {
  hasVirtualMic: boolean
  inputCount: number
  kinds: string[]
}

const DEVICE_KINDS = new Set(['virtual', 'bluetooth', 'usb', 'builtin', 'other'])

/** Re-validated on the main side: a renderer payload is never trusted blindly,
 *  and this is the one place that decides what a bundle can carry. */
export function sanitizeDeviceSummary(value: unknown): DeviceSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  const kinds = Array.isArray(v.kinds)
    ? v.kinds.filter((k): k is string => typeof k === 'string' && DEVICE_KINDS.has(k))
    : []
  const inputCount =
    typeof v.inputCount === 'number' && Number.isFinite(v.inputCount)
      ? Math.max(0, Math.min(64, Math.trunc(v.inputCount)))
      : kinds.length
  return { hasVirtualMic: v.hasVirtualMic === true, inputCount, kinds }
}

/** What the renderer contributes: state only IT can see. */
export interface RendererDiagnostics {
  /** See DeviceSummary. Labels are refused at the type: there is no field for them. */
  devices?: DeviceSummary
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
      devices: sanitizeDeviceSummary(renderer.devices) ?? { hasVirtualMic: false, inputCount: 0, kinds: [] }
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
      // BUG-094 — this was a raw copyFileSync and this module never imported
      // the scrubber at all, so the zip shipped kern_bridge.log BYTE FOR BYTE.
      // This milestone's own Phase 0 audit §1.4 records those logs carrying
      // `C:\Users\<name>\…`. Concealed by a phantom citation: the A1 plan
      // claimed all three egress paths shared one `buildOutbound()`, which
      // never existed. Same helper as the support bundle now — one mechanism,
      // both callers. scrubbedCopy returns false rather than throwing, which
      // preserves the skip-never-fatal behaviour this loop always had.
      if (scrubbedCopy(src, join(staging, src.split(/[\\/]/).pop()!))) collected++
    }
    // The renderer used to supply deviceLabels (microphone names, which
    // routinely contain a person's name — "Dana's AirPods"); BUG-122 replaced
    // them with a keyword-derived classification, because a bare name cannot
    // be scrubbed. tier1Status still carries enginePath, an absolute path,
    // which CAN be. Scrubbed as a DOCUMENT: the app-wide
    // scrubber caps a single string at 4096 chars, which would truncate this
    // JSON into unparseable output.
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
