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
  bundleId: string
  name: string
}

interface NativeProcessInputActivity {
  pid: number
  bundleId: string
  deviceUIDs: string[]
}

interface NativeLegacyDeviceActivity {
  deviceUID: string
  deviceName: string
  isRunning: boolean
}

interface NativeAudioInputActivity {
  supported: boolean
  processes: NativeProcessInputActivity[]
  legacyDevices: NativeLegacyDeviceActivity[]
}

interface NativeWindowInfo {
  pid: number
  ownerName: string
  title: string
}

interface NativeAddon {
  getRunningConferencingProcesses(): NativeRunningProcess[]
  isMacOS14OrLater(): boolean
  getVirtualMicDeviceUID(): string | null
  getAudioInputActivity(): NativeAudioInputActivity
  getWindowTitles(): NativeWindowInfo[] | null
}

/** How often MacAdapter samples the OS. The FSM's own tick cadence (DETECTION_TUNING.pollIdleMs/pollCandidateMs) is separate - this just needs to keep the signal buffer fresh within the 10s fusion window. */
const SAMPLE_INTERVAL_MS = 1_000

const ADDON_RELATIVE_PATH = 'native/mac-audio-activity/build/Release/mac_audio_activity.node'

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
 * macOS adapter: a thin poll loop around the mac-audio-activity native addon.
 * Every OS call is wrapped so a native failure degrades to "no signal this
 * tick" rather than crashing the detector - callers should treat a failed
 * `start()` load as `detection:unavailable` (native-load-failed) and fall
 * back to manual capture.
 */
export class MacAdapter implements ICallDetectorAdapter {
  // Deliberately NOT loaded in the constructor — see WindowsAdapter's
  // identical comment. A MacAdapter is created unconditionally at every app
  // startup regardless of the ff_ambient_detection setting, so loading stays
  // deferred to the first isSupported()/start() call so a broken addon can
  // never prevent the app itself from opening.
  private addon: NativeAddon | null = null
  private addonLoadAttempted = false
  loadError: unknown = null
  private readonly now: () => number
  private readonly onUnavailableWindowTitles?: () => void

  private listeners = new Set<(signal: DetectionSignal) => void>()
  private pollTimer?: ReturnType<typeof setInterval>
  private virtualMicUID: string | null = null
  private warnedNoScreenRecording = false

  constructor(options: { now?: () => number; onUnavailableWindowTitles?: () => void } = {}) {
    this.now = options.now ?? Date.now
    this.onUnavailableWindowTitles = options.onUnavailableWindowTitles
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
    return process.platform === 'darwin' && this.ensureAddonLoaded() != null
  }

  start(): void {
    if (!this.ensureAddonLoaded() || this.pollTimer) return
    // sample() itself resolves virtualMicUID on its first call (and keeps
    // re-checking on every later call for as long as it stays null).
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

    // Re-check if we haven't found it yet - the virtual mic device may not
    // exist yet when detection starts (e.g. noise cancellation turned on
    // only later, mid-run). CoreAudio device enumeration is cheap and
    // safeCall already tolerates failure, so this costs nothing once found
    // (never re-checked again) and nothing extra if it never appears.
    if (this.virtualMicUID == null) {
      this.virtualMicUID = this.safeCall(() => this.addon!.getVirtualMicDeviceUID(), null)
    }

    const runningApps = this.safeCall(
      () => this.addon!.getRunningConferencingProcesses(),
      [] as NativeRunningProcess[]
    )
    const byPid = new Map(runningApps.map((p) => [p.pid, p]))

    this.emitProcessSignals(runningApps, now)
    this.emitInputActivitySignals(byPid, now)
    this.emitWindowTitleSignals(byPid, now)
  }

  private emitProcessSignals(runningApps: NativeRunningProcess[], now: number): void {
    for (const app of runningApps) {
      if (isOwnProcess({ pid: app.pid, bundleId: app.bundleId, processName: app.name })) continue
      const identity = normalizeAppIdentity({ macBundleId: app.bundleId, processName: app.name })
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
  }

  private emitInputActivitySignals(byPid: Map<number, NativeRunningProcess>, now: number): void {
    const activity = this.safeCall(() => this.addon!.getAudioInputActivity(), {
      supported: false,
      processes: [],
      legacyDevices: []
    } as NativeAudioInputActivity)

    if (activity.supported) {
      for (const proc of activity.processes) {
        if (isOwnProcess({ pid: proc.pid, bundleId: proc.bundleId })) continue
        const runningApp = byPid.get(proc.pid)
        const identity = normalizeAppIdentity({
          macBundleId: proc.bundleId,
          processName: runningApp?.name
        })
        const usesOurMic =
          this.virtualMicUID != null && proc.deviceUIDs.includes(this.virtualMicUID)
        this.emit({
          kind: usesOurMic ? 'own-virtual-device' : 'mic-session',
          appId: identity.appId,
          displayName: runningApp?.name || identity.displayName,
          pid: proc.pid,
          observedAt: now,
          weight: 0
        })
      }
      return
    }

    // Legacy fallback: device-level activity, no pid attribution - pair it with
    // whichever known conferencing apps are currently running (per the spec).
    const anyOtherDeviceRunning = activity.legacyDevices.some(
      (d) => d.isRunning && d.deviceUID !== this.virtualMicUID
    )
    const ourMicRunning = activity.legacyDevices.some(
      (d) => d.isRunning && d.deviceUID === this.virtualMicUID
    )
    if (!anyOtherDeviceRunning && !ourMicRunning) return

    for (const [pid, app] of byPid) {
      const identity = normalizeAppIdentity({ macBundleId: app.bundleId, processName: app.name })
      if (!identity.known || isOwnProcess({ pid, bundleId: app.bundleId, processName: app.name }))
        continue
      this.emit({
        kind: ourMicRunning ? 'own-virtual-device' : 'mic-session',
        appId: identity.appId,
        displayName: app.name,
        pid,
        observedAt: now,
        weight: 0
      })
    }
  }

  private emitWindowTitleSignals(byPid: Map<number, NativeRunningProcess>, now: number): void {
    const windows = this.safeCall(() => this.addon!.getWindowTitles(), undefined)
    if (windows === undefined) return // native call itself failed - already logged via safeCall's silent fallback
    if (windows === null) {
      if (!this.warnedNoScreenRecording) {
        this.warnedNoScreenRecording = true
        this.onUnavailableWindowTitles?.()
      }
      return
    }

    for (const w of windows) {
      if (!w.title) continue
      if (isOwnProcess({ pid: w.pid, processName: w.ownerName })) continue
      const match = matchTitle(w.title)
      if (!match) continue
      const app = byPid.get(w.pid)
      this.emit({
        kind: 'window-title',
        appId: match.appId,
        displayName: match.displayName,
        pid: w.pid,
        title: w.title,
        observedAt: now,
        weight: 0
      })
      // A matched title on a process CoreAudio didn't already flag as a known
      // app is still useful as a weak `process` corroboration.
      if (
        app &&
        !isKnownConferencingApp(normalizeAppIdentity({ macBundleId: app.bundleId }).appId)
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
