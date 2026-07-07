// App-managed noise cancellation (Step 1: main-process service, no UI yet).
//
// "Sales OS Microphone" is a separate virtual-audio program (its own repo). It
// installs a Core Audio driver and runs a small helper, `michelper`, that
// captures the real mic, denoises it with DeepFilterNet3, and publishes the
// clean audio as the "Sales OS Microphone" input device. Any app (Zoom, Meet,
// or CallRise AI itself) that selects that device then hears the denoised voice.
//
// This module lets the app DETECT and CONTROL that helper: is the driver
// installed, is the helper running, and start/stop it as a child process.
// It deliberately does NOT install the driver (that needs an admin password —
// the UI guides the user instead) and it never touches the consent/loopback
// path (denoising the rep's own mic is orthogonal to buyer capture).
//
// Fail-safe posture: everything here degrades gracefully. If the helper binary
// or driver is missing, we report that in the status and simply can't start —
// no crash. If the helper dies UNEXPECTEDLY (a crash, not a user-initiated
// stop), we don't just quietly reset state: the whole point of this feature
// is cleaning the audio a call app is actively sending, so a silent mid-call
// failure is the worst possible outcome (the user finds out when the other
// person says "I think you're on mute"). So an unexpected death also (a)
// shows a native OS notification, since the only in-app status indicator is
// a Home-screen card nobody's looking at during a call, and (b) attempts a
// bounded auto-restart if the helper had actually gotten up and running
// first — never for a helper that never confirmed startup or died within
// seconds, since that's a real, likely-repeatable problem a blind restart
// would just loop on.
import { ipcMain, BrowserWindow, app, systemPreferences, Notification } from 'electron'
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

// A crash is only worth auto-restarting if the helper actually got up and
// running first and stayed healthy a while -- a helper that dies before
// confirming startup, or seconds after, is failing for a real, likely
// repeatable reason (bad device, missing model file, etc.), and blindly
// respawning it would risk a tight crash loop instead of fixing anything.
const MIN_HEALTHY_MS = 10_000
// Cap consecutive auto-restarts so a repeatable failure can't loop forever.
const MAX_RESTART_ATTEMPTS = 3
// If nothing crashes for this long after a restart, treat the helper as
// stable again and give it a fresh set of restart attempts.
const RESTART_ATTEMPTS_RESET_MS = 5 * 60_000

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
// Re-entrancy guard: startHelper() now awaits the mic-permission prompt
// (which can take a human seconds or minutes to answer) BEFORE `child` gets
// set. Without this flag, two overlapping calls (a double-click, or two
// windows) could both pass the `if (child) return` check before either
// finishes and spawn two michelpers. Set synchronously at entry -- before
// any await -- so it closes the window the permission-check await opens.
let starting = false
// Set when stopHelper() is called during startHelper()'s startup window
// (starting === true but `child` is still null, e.g. while the mic-permission
// prompt is being awaited). Without this, that stop would be a silent no-op
// and the helper would go on to start and keep running. startHelper() checks
// it right before declaring success and tears the fresh helper back down.
let stopRequested = false
// Consecutive-restart counter and its reset timer -- see MAX_RESTART_ATTEMPTS
// and RESTART_ATTEMPTS_RESET_MS above.
let restartAttempts = 0
let restartResetTimer: NodeJS.Timeout | null = null

// Shows a native macOS notification. This is the whole point of this
// feature: if the helper dies while the user is on a call in Zoom/WhatsApp/
// etc, the ONLY status indicator today is a card on the Home screen nobody
// is looking at during a call -- without a notification, a mid-call crash is
// a SILENT failure the user only discovers when the other person says
// "I think you're on mute."
function notifyUser(title: string, body: string): void {
  if (!Notification.isSupported()) return
  new Notification({ title, body }).show()
}

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

async function startHelper(): Promise<{ ok: boolean; error?: string }> {
  // The Core Audio HAL driver + systemPreferences mic-access API this relies
  // on are both macOS-only. DRIVER_PATH never exists on other platforms, so
  // this is already unreachable there in practice — this guard just makes
  // that explicit instead of relying on a hardcoded path never resolving.
  if (process.platform !== 'darwin') {
    return { ok: false, error: 'noise cancellation is only available on macOS' }
  }
  if (child) return { ok: true } // already running
  if (starting) return { ok: false, error: 'already starting' }
  starting = true
  try {
    const helperPath = resolveHelperPath()
    if (!helperPath) {
      return { ok: false, error: 'noise-cancellation helper not found' }
    }
    if (!existsSync(DRIVER_PATH)) {
      return { ok: false, error: 'driver not installed' }
    }

    // Ask for microphone permission BEFORE spawning michelper, not after.
    // michelper itself blocks indefinitely on this exact same system prompt
    // at its own startup. If we spawned first, a first-run user taking more
    // than STARTUP_CONFIRM_MS to click "Allow" would get their helper
    // silently SIGKILLed by our own startup watchdog mid-prompt — the toggle
    // would just flip back off with no explanation. Checking here means the
    // watchdog's clock only starts once permission is already settled, and a
    // denial surfaces as a clear error instead of a silent, unexplained one.
    const micStatus = systemPreferences.getMediaAccessStatus('microphone')
    if (micStatus !== 'granted') {
      const granted = await systemPreferences.askForMediaAccess('microphone')
      if (!granted) {
        return { ok: false, error: 'microphone access denied' }
      }
    }

    // Guard against the multi-writer case: if a previous helper was orphaned
    // (an app crash, or one the user launched by hand), a second writer to
    // the same shared-memory ring produces corrupted/static audio. Kill any
    // stray helper BEFORE we spawn ours — synchronously, so pkill can't race
    // and match the process we're about to start (which doesn't exist yet).
    // The pattern is regex-ESCAPED and ANCHORED (^…$): since we launch
    // michelper with no args, its command line is exactly this path, so the
    // anchored exact-match hits only stray michelpers and never an unrelated
    // process (a plain unescaped `pkill -f <path>` would treat metacharacters
    // in the path as regex and could match far too broadly). Best-effort:
    // execFileSync throws when pkill finds nothing (the normal case), which
    // we ignore.
    try {
      execFileSync('/usr/bin/pkill', ['-f', `^${escapeRegex(helperPath)}$`])
    } catch {
      /* no stray to kill (or pkill unavailable) — proceed */
    }

    let proc: ChildProcess
    try {
      // stderr is 'ignore' (not 'pipe'): we never read it, and an un-drained
      // stderr pipe could fill its kernel buffer and BLOCK the helper
      // mid-call. stdout stays piped because we scan its startup banner
      // below (and reading it keeps that pipe drained — the helper prints a
      // periodic level meter).
      proc = spawn(helperPath, [], { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return { ok: false, error: 'could not launch helper' }
    }

    child = proc
    denoiseActive = false
    let sawBanner = false
    let acc = ''
    const startedAt = Date.now()

    // michelper prints a one-line startup banner: "…(ENABLED)" when the
    // denoiser loaded, or "Denoiser: DISABLED …" when it fell back to raw
    // passthrough. We accumulate stdout until we see one of those markers so
    // a banner split across chunk boundaries is still matched (a
    // single-chunk `includes` check would miss "…(ENA" + "BLED)…").
    const watchdog = setTimeout(() => {
      if (child === proc && !sawBanner) {
        // Never confirmed startup (most likely wedged on a mic-permission
        // prompt). Kill it so it can't hold the mic; the exit handler resets
        // our state.
        proc.kill('SIGKILL')
      }
    }, STARTUP_CONFIRM_MS)

    proc.stdout?.on('data', (chunk: Buffer) => {
      // Guard against stale, already-buffered data from a process we've
      // moved on from (same idiom as the exit/error handlers below). Without
      // this, rapid stop-then-start could have proc A's buffered "(ENABLED)"
      // banner arrive AFTER proc B has already spawned, incorrectly setting
      // the module-level denoiseActive to true for the wrong process.
      if (child !== proc) return
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
      // A user-initiated stop already nulled `child` before killing (see
      // stopHelper), so reaching here with `child === proc` means this exit
      // was UNEXPECTED -- a crash, or the helper quitting on its own.
      if (child === proc) {
        child = null
        denoiseActive = false
        broadcast()

        const wasHealthy = sawBanner && Date.now() - startedAt >= MIN_HEALTHY_MS
        if (wasHealthy && restartAttempts < MAX_RESTART_ATTEMPTS) {
          // Confirmed startup, ran fine for a while, then died -- worth one
          // more try. Cap + a reset-after-quiet-period keep a genuinely
          // broken setup (bad device, corrupted install, etc.) from looping
          // forever instead of just settling into a clear "it's off" state.
          restartAttempts++
          if (restartResetTimer) clearTimeout(restartResetTimer)
          restartResetTimer = setTimeout(() => {
            restartAttempts = 0
          }, RESTART_ATTEMPTS_RESET_MS)
          notifyUser('Noise cancellation stopped unexpectedly', 'Restarting automatically…')
          void startHelper()
        } else {
          restartAttempts = 0
          if (restartResetTimer) {
            clearTimeout(restartResetTimer)
            restartResetTimer = null
          }
          notifyUser(
            'Noise cancellation is off',
            'It stopped and could not restart automatically. Your call app may be sending unclean audio — check CallRise AI or switch microphones.'
          )
        }
      }
    })
    proc.on('error', () => {
      clearTimeout(watchdog)
      if (child === proc) {
        child = null
        denoiseActive = false
        broadcast()
        notifyUser(
          'Noise cancellation is off',
          'The noise-cancellation engine hit an error and stopped.'
        )
      }
    })

    // A stop was requested while we were still starting up (before `child`
    // was assigned, so stopHelper() couldn't act on it). Honor it now: tear
    // down the helper we just spawned and report success — the net effect is
    // "started, then immediately stopped", which is what the user asked for.
    if (stopRequested) {
      stopRequested = false
      stopHelper()
      return { ok: true }
    }

    broadcast()
    return { ok: true }
  } finally {
    starting = false
    // Any pending stop is moot once this attempt ends: either we honored it
    // above, or the start failed and there is nothing running to stop. Clear
    // it so it can't leak into (and silently kill) a future start.
    stopRequested = false
  }
}

function stopHelper(): { ok: boolean } {
  // startHelper() is mid-startup and hasn't assigned `child` yet (it's
  // awaiting the mic-permission prompt / spawning). We can't kill what isn't
  // there, so flag the request; startHelper() checks this right before
  // declaring success and tears the fresh helper down.
  if (starting && !child) {
    stopRequested = true
    return { ok: true }
  }
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
