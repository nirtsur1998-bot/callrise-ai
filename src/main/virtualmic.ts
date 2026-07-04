// App-managed noise cancellation (Step 1: main-process service, no UI yet).
//
// "Sales OS Microphone" is a separate virtual-audio program (its own repo). It
// installs a Core Audio driver and runs a small helper, `michelper`, that
// captures the real mic, denoises it with DeepFilterNet3, and publishes the
// clean audio as the "Sales OS Microphone" input device. Any app (Zoom, Meet,
// or Sales OS itself) that selects that device then hears the denoised voice.
//
// This module lets the app DETECT and CONTROL that helper: is the driver
// installed, is the helper running, and start/stop it as a child process.
// It deliberately does NOT install the driver (that needs an admin password —
// the UI guides the user instead) and it never touches the consent/loopback
// path (denoising the rep's own mic is orthogonal to buyer capture).
//
// Fail-safe posture: everything here degrades gracefully. If the helper binary
// or driver is missing, we report that in the status and simply can't start —
// no crash. If the helper dies, we notice via its 'exit' event and reset state.
import { ipcMain, BrowserWindow, app } from 'electron'
import { spawn, execFileSync, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

// The installed Core Audio driver bundle (system-level; put there by the
// virtual-mic program's install step, which needs admin rights).
const DRIVER_PATH = '/Library/Audio/Plug-Ins/HAL/SalesOSMicrophone.driver'

// If the helper never confirms startup within this window (e.g. it wedged on a
// mic-permission prompt), we assume it's stuck and kill it rather than leave a
// process holding the mic with the UI showing a misleading state.
const STARTUP_CONFIRM_MS = 8000
// Grace period after SIGTERM before we escalate to SIGKILL on stop.
const KILL_GRACE_MS = 2000

export interface VirtualMicStatus {
  /** The Core Audio driver bundle is installed (the "Sales OS Microphone" device exists). */
  driverInstalled: boolean
  /** We found a michelper binary we can launch. */
  helperAvailable: boolean
  /** michelper is currently running (denoising). */
  helperRunning: boolean
  /** michelper reported its denoiser actually loaded and is ENABLED (vs raw passthrough). */
  denoiseActive: boolean
  /** Absolute path to the helper binary we resolved, or null if not found (for diagnostics). */
  helperPath: string | null
}

let child: ChildProcess | null = null
let denoiseActive = false

// Escape a string so it is matched LITERALLY by an extended regex (pkill -f).
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Resolve the michelper binary. Order: explicit env override, then the bundled
// location (packaged app — Step 4), then the sibling dev repo built in place.
// The helper resolves its model file relative to its own binary, so it must be
// run from a tree that has phase2/models next to build/ — true for both the
// dev sibling repo and the intended bundled layout.
function resolveHelperPath(): string | null {
  const candidates = [
    process.env['SALESOS_MICHELPER_PATH'],
    // Packaged (Step 4): shipped under the app's resources.
    join(process.resourcesPath ?? '', 'virtualmic', 'build', 'michelper'),
    // Dev: the sibling virtual-mic repo, built in place next to this app repo.
    join(app.getAppPath(), '..', 'salesos-virtualmic', 'build', 'michelper')
  ].filter((p): p is string => typeof p === 'string' && p.length > 0)

  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

function getStatus(): VirtualMicStatus {
  const helperPath = resolveHelperPath()
  return {
    driverInstalled: existsSync(DRIVER_PATH),
    helperAvailable: helperPath !== null,
    helperRunning: child !== null,
    denoiseActive,
    helperPath
  }
}

function broadcast(): void {
  const status = getStatus()
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('virtualmic:changed', status)
  }
}

function startHelper(): { ok: boolean; error?: string } {
  if (child) return { ok: true } // already running
  const helperPath = resolveHelperPath()
  if (!helperPath) {
    return { ok: false, error: 'noise-cancellation helper not found' }
  }
  if (!existsSync(DRIVER_PATH)) {
    return { ok: false, error: 'driver not installed' }
  }

  // Guard against the multi-writer case: if a previous helper was orphaned (an
  // app crash, or one the user launched by hand), a second writer to the same
  // shared-memory ring produces corrupted/static audio. Kill any stray helper
  // BEFORE we spawn ours — synchronously, so pkill can't race and match the
  // process we're about to start (which doesn't exist yet). The pattern is
  // regex-ESCAPED and ANCHORED (^…$): since we launch michelper with no args,
  // its command line is exactly this path, so the anchored exact-match hits
  // only stray michelpers and never an unrelated process (a plain unescaped
  // `pkill -f <path>` would treat metacharacters in the path as regex and
  // could match far too broadly). Best-effort: execFileSync throws when pkill
  // finds nothing (the normal case), which we ignore.
  try {
    execFileSync('/usr/bin/pkill', ['-f', `^${escapeRegex(helperPath)}$`])
  } catch {
    /* no stray to kill (or pkill unavailable) — proceed */
  }

  let proc: ChildProcess
  try {
    // stderr is 'ignore' (not 'pipe'): we never read it, and an un-drained
    // stderr pipe could fill its kernel buffer and BLOCK the helper mid-call.
    // stdout stays piped because we scan its startup banner below (and reading
    // it keeps that pipe drained — the helper prints a periodic level meter).
    proc = spawn(helperPath, [], { stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return { ok: false, error: 'could not launch helper' }
  }

  child = proc
  denoiseActive = false
  let sawBanner = false
  let acc = ''

  // michelper prints a one-line startup banner: "…(ENABLED)" when the denoiser
  // loaded, or "Denoiser: DISABLED …" when it fell back to raw passthrough.
  // We accumulate stdout until we see one of those markers so a banner split
  // across chunk boundaries is still matched (a single-chunk `includes` check
  // would miss "…(ENA" + "BLED)…").
  const watchdog = setTimeout(() => {
    if (child === proc && !sawBanner) {
      // Never confirmed startup (most likely wedged on a mic-permission prompt).
      // Kill it so it can't hold the mic; the exit handler resets our state.
      proc.kill('SIGKILL')
    }
  }, STARTUP_CONFIRM_MS)

  proc.stdout?.on('data', (chunk: Buffer) => {
    if (!sawBanner) {
      acc += chunk.toString()
      if (acc.includes('(ENABLED)')) {
        denoiseActive = true
        sawBanner = true
        broadcast()
      } else if (acc.includes('Denoiser: DISABLED')) {
        sawBanner = true // running, but in raw passthrough — leave denoiseActive false
        broadcast()
      } else if (acc.length > 16384) {
        acc = '' // banner appears at startup; stop growing if it never came
      }
    }
    // After the banner, keep draining stdout (the level meter) by ignoring it.
  })

  proc.on('exit', () => {
    clearTimeout(watchdog)
    if (child === proc) {
      child = null
      denoiseActive = false
      broadcast()
    }
  })
  proc.on('error', () => {
    clearTimeout(watchdog)
    if (child === proc) {
      child = null
      denoiseActive = false
      broadcast()
    }
  })

  broadcast()
  return { ok: true }
}

function stopHelper(): { ok: boolean } {
  if (child) {
    const proc = child
    child = null
    denoiseActive = false
    proc.kill('SIGTERM')
    // Escalate to SIGKILL if it doesn't exit on SIGTERM within the grace period,
    // so a stubborn helper can't outlive the app and keep holding the mic.
    const escalate = setTimeout(() => {
      try {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, KILL_GRACE_MS)
    proc.once('exit', () => clearTimeout(escalate))
    broadcast()
  }
  return { ok: true }
}

export function registerVirtualMic(): void {
  ipcMain.handle('virtualmic:getStatus', () => getStatus())
  ipcMain.handle('virtualmic:start', () => startHelper())
  ipcMain.handle('virtualmic:stop', () => stopHelper())
}

// Ensure the helper never outlives the app (it captures the mic).
export function disposeVirtualMic(): void {
  stopHelper()
}
