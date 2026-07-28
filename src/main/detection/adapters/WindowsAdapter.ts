import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import {
  isKnownConferencingApp,
  isOwnProcess,
  matchTitle,
  normalizeAppIdentity
} from '../appRegistry'
import type { DetectionSignal } from '../types'
import type { ICallDetectorAdapter } from './ICallDetectorAdapter'

interface NativeRunningProcess {
  pid: number
  exeName: string // lowercase basename, e.g. 'zoom.exe'
}

interface NativeInputActivity {
  pid: number
  exeName: string
}

interface NativeWindowInfo {
  pid: number
  title: string
}

interface NativeAddon {
  getRunningConferencingProcesses(): NativeRunningProcess[]
  getAudioInputActivity(): NativeInputActivity[]
  getWindowTitles(): NativeWindowInfo[]
}

/** Same rationale as MacAdapter: a plain poll loop, no OS push notifications. See win-audio-sessions/src/addon.cc's header comment. */
const SAMPLE_INTERVAL_MS = 1_000

const ADDON_RELATIVE_PATH = 'native/win-audio-sessions/build/Release/win_audio_sessions.node'

function resolveAddonPath(): string {
  // Dev: running via electron-vite from the project root.
  const devPath = join(process.cwd(), ADDON_RELATIVE_PATH)
  if (existsSync(devPath)) return devPath

  // Packaged: electron-builder.yml's asarUnpack keeps this out of app.asar (a
  // .node file can't be require()'d from inside an asar archive at all) at
  // the mirrored app.asar.unpacked path alongside it. Guarded separately -
  // `app` isn't a real Electron App instance outside a full app process (e.g.
  // the headless debug CLI run via ELECTRON_RUN_AS_NODE), so this must never
  // throw before the dev path above gets a chance.
  try {
    const packagedPath = join(
      app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'),
      ADDON_RELATIVE_PATH
    )
    if (existsSync(packagedPath)) return packagedPath
  } catch {
    /* not running inside a ready Electron app process - fall through */
  }
  return devPath
}

function loadNativeAddon(): { addon: NativeAddon | null; error: unknown } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const addon = require(resolveAddonPath()) as NativeAddon
    return { addon, error: null }
  } catch (error) {
    return { addon: null, error }
  }
}

/**
 * Windows adapter: mirrors MacAdapter's structure exactly (poll loop, same
 * safe-call-degrades-to-nothing pattern), backed by the win-audio-sessions
 * native addon (WASAPI capture-session enumeration, process snapshot, window
 * titles). Never emits 'own-virtual-device' - there is no Windows virtual mic
 * yet (see the "Windows virtual mic program" work, currently paused), so that
 * signal simply never fires on this platform in this milestone.
 *
 * NOTE: confirmed working on real Windows hardware - process enumeration and
 * WASAPI mic-session detection correctly detected a live WhatsApp call end to
 * end via `npm run detect:debug` (see addon.cc's header comment for exactly
 * what's verified vs. still unexercised, e.g. the window-title path).
 */
export class WindowsAdapter implements ICallDetectorAdapter {
  // Deliberately NOT loaded in the constructor — a WindowsAdapter is created
  // unconditionally at every app startup (detection-service.ts's
  // startDetectionService(), regardless of the ff_ambient_detection setting),
  // so an eager require() here means a bad/incompatible .node file on the
  // user's machine (e.g. a missing VC++ runtime DLL) could crash the WHOLE
  // APP on every single launch, for every user, even ones who never touched
  // this feature — confirmed as the real-world cause of "installs fine, then
  // never opens, no error" on multiple Windows testers' machines. Loading is
  // deferred to the first isSupported()/start() call, both of which only
  // happen once the feature is actually enabled — so a broken addon can only
  // ever break detection, never the app's ability to open.
  private addon: NativeAddon | null = null
  private addonLoadAttempted = false
  loadError: unknown = null
  private readonly now: () => number

  private listeners = new Set<(signal: DetectionSignal) => void>()
  private pollTimer?: ReturnType<typeof setInterval>

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now
  }

  private ensureAddonLoaded(): NativeAddon | null {
    if (!this.addonLoadAttempted) {
      this.addonLoadAttempted = true
      const { addon, error } = loadNativeAddon()
      this.addon = addon
      this.loadError = error
    }
    return this.addon
  }

  isSupported(): boolean {
    return process.platform === 'win32' && this.ensureAddonLoaded() != null
  }

  start(): void {
    if (!this.ensureAddonLoaded() || this.pollTimer) return
    this.sample()
    this.pollTimer = setInterval(() => this.sample(), SAMPLE_INTERVAL_MS)
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
  }

  onSignal(callback: (signal: DetectionSignal) => void): () => void {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  private emit(signal: DetectionSignal): void {
    for (const listener of this.listeners) listener(signal)
  }

  private safeCall<T>(fn: () => T, fallback: T): T {
    try {
      return fn()
    } catch {
      return fallback
    }
  }

  private sample(): void {
    if (!this.addon) return
    const now = this.now()

    const runningApps = this.safeCall(
      () => this.addon!.getRunningConferencingProcesses(),
      [] as NativeRunningProcess[]
    )
    const byPid = new Map(runningApps.map((p) => [p.pid, p]))

    for (const app of runningApps) {
      if (isOwnProcess({ pid: app.pid, processName: app.exeName })) continue
      const identity = normalizeAppIdentity({ windowsExeName: app.exeName })
      if (!identity.known) continue
      this.emit({
        kind: 'process',
        appId: identity.appId,
        displayName: identity.displayName,
        pid: app.pid,
        observedAt: now,
        weight: 0
      })
    }

    const activity = this.safeCall(
      () => this.addon!.getAudioInputActivity(),
      [] as NativeInputActivity[]
    )
    for (const session of activity) {
      if (isOwnProcess({ pid: session.pid, processName: session.exeName })) continue
      const identity = normalizeAppIdentity({ windowsExeName: session.exeName })
      this.emit({
        kind: 'mic-session',
        appId: identity.appId,
        displayName: byPid.get(session.pid)?.exeName ?? identity.displayName,
        pid: session.pid,
        observedAt: now,
        weight: 0
      })
    }

    const windows = this.safeCall(() => this.addon!.getWindowTitles(), [] as NativeWindowInfo[])
    for (const w of windows) {
      if (!w.title || isOwnProcess({ pid: w.pid })) continue
      const match = matchTitle(w.title)
      if (!match) continue
      this.emit({
        kind: 'window-title',
        appId: match.appId,
        displayName: match.displayName,
        pid: w.pid,
        title: w.title,
        observedAt: now,
        weight: 0
      })
      // Mirrors MacAdapter: a matched title on a process not already flagged
      // as a known app (the browser-hosted case - e.g. Google Meet in Chrome,
      // which has no windowsExeNames/bundleId entry, only a titlePattern) is
      // still useful as a weak corroborating `process` signal.
      const exeApp = byPid.get(w.pid)
      if (
        exeApp &&
        !isKnownConferencingApp(normalizeAppIdentity({ windowsExeName: exeApp.exeName }).appId)
      ) {
        this.emit({
          kind: 'process',
          appId: match.appId,
          displayName: match.displayName,
          pid: w.pid,
          observedAt: now,
          weight: 0
        })
      }
    }
  }
}
