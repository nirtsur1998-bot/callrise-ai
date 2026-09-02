// Manages the ONE always-on-top overlay window used for all three ambient-
// detection UI surfaces (live capture banner, detection toast, switch
// prompt) — a single window whose renderer content (features/detection/
// DetectionOverlay.tsx) switches what it shows based on IPC state, rather
// than three independently-managed windows. Never steals focus
// (focusable: false + showInactive()); position is remembered across drags.
import { app, BrowserWindow, Menu, globalShortcut, screen } from 'electron'
import { is } from '@electron-toolkit/utils'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { writeJsonAtomicSync } from './atomic-write'

// The visible card is smaller than the window (see DetectionOverlay.tsx's
// OverlayShell — it wraps the card in CARD_INSET of transparent padding on
// every side) so the card's own drop shadow has room to render instead of
// being clipped flush at the window's bounds.
const CARD_INSET = 16
const WIDTH = 360 + CARD_INSET * 2
const HEIGHT = 180 + CARD_INSET * 2
const MARGIN = 20

/** Actions the overlay's right-click menu and global shortcuts act on —
 *  passed in once from detection-service.ts (which already owns these as
 *  `trayActions`) rather than this module reaching back into that one and
 *  creating a circular import. */
export interface OverlayActions {
  openMainWindow: () => void
  pauseDetection: () => void
  resumeDetection: () => void
  stopCapture: () => void
  snoozeDetection: (minutes: number) => void
  /** Whether detection is currently running (unpaused) — drives the
   *  Pause/Resume menu label, mirrors detection-tray.ts's own snapshot. */
  isRunning: () => boolean
}

let overlayWindow: BrowserWindow | null = null
let overlayActions: OverlayActions | null = null
let savePositionTimer: ReturnType<typeof setTimeout> | undefined
let shortcutsRegistered = false

/** BUG-155 — called from the overlay renderer as the pointer enters and
 *  leaves the visible card. Guarded on the live window: the renderer can
 *  emit one last 'release' as the window is being destroyed.
 *
 *  Exported for detection-service.ts to register, keeping every ipcMain
 *  handler in the one module that already owns them. */
export function setOverlayInteractive(interactive: boolean): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  overlayWindow.setIgnoreMouseEvents(!interactive, { forward: true })
}

function positionPath(): string {
  return join(app.getPath('userData'), 'detection-banner-position.json')
}

function loadSavedPosition(): { x: number; y: number } | null {
  try {
    const parsed = JSON.parse(readFileSync(positionPath(), 'utf8')) as { x?: unknown; y?: unknown }
    if (typeof parsed.x === 'number' && typeof parsed.y === 'number')
      return { x: parsed.x, y: parsed.y }
  } catch {
    /* no saved position yet, or it's corrupt - fall back to the default corner */
  }
  return null
}

function savePositionDebounced(x: number, y: number): void {
  clearTimeout(savePositionTimer)
  savePositionTimer = setTimeout(() => {
    try {
      writeJsonAtomicSync(positionPath(), { x, y })
    } catch {
      /* non-fatal - the banner just resets to the default corner next launch */
    }
  }, 500)
}

function defaultPosition(): { x: number; y: number } {
  const { workArea } = screen.getPrimaryDisplay()
  return {
    x: workArea.x + workArea.width - WIDTH - MARGIN,
    y: workArea.y + workArea.height - HEIGHT - MARGIN
  }
}

function loadOverlayContent(win: BrowserWindow): void {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#/detection-overlay`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/detection-overlay' })
  }
}

function createOverlayWindow(): BrowserWindow {
  const pos = loadSavedPosition() ?? defaultPosition()
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    focusable: false,
    show: false,
    hasShadow: true,
    backgroundColor: '#00000000',
    // Native translucent material so the glass-capsule content (backdrop-blur
    // in CSS) reads as a genuinely native surface rather than a flat image of
    // one. macOS only: Windows' equivalent (backgroundMaterial: 'acrylic')
    // was tried and reverted — on a transparent, frameless BrowserWindow it
    // paints its own square backdrop at the OS compositor level, which has no
    // idea about DetectionOverlay.tsx's rounded-corner CSS clip, so it shows
    // through as an ugly square behind the actual rounded card (confirmed on
    // real Windows hardware, not a theoretical incompatibility). The CSS-only
    // backdrop-blur in .glass-hud already renders correctly on Windows
    // without it — this is the same fallback the removed comment described,
    // just now the ONLY path on win32 instead of an assumed-safe upgrade.
    vibrancy: process.platform === 'darwin' ? 'under-window' : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')

  // BUG-155 (founder, 2026-09-01): "while you are navigating the app and
  // there is the in-app CallRise call-detecting symbol asking if the user
  // wants to start recording, the user cannot scroll in the app at all".
  //
  // This window is always-on-top at screen-saver level and had no mouse
  // policy at all, so it swallowed every click and wheel event across its
  // FULL RECT -- which is larger than anything visible, because the card is
  // inset by CARD_INSET on all four sides to give its shadow room. The user
  // sees empty desktop, the OS sees a window, and the scroll goes nowhere.
  //
  // The in-app banner was measured and ruled out first: 45px tall, 5% of the
  // viewport, and elementFromPoint at mid-screen returns the scroll
  // container, so it is not the cause.
  //
  // forward: true keeps mousemove flowing to the renderer while ignoring is
  // on -- that is what lets DetectionOverlay notice the pointer entering the
  // card and ask for input back. Without forwarding, the window would be
  // permanently click-through and its buttons unusable.
  // INVERTED after driving it: the window starts INTERACTIVE and is only
  // released once the renderer has positively established that the pointer is
  // in the transparent inset.
  //
  // The first version started ignoring and relied on the renderer claiming the
  // pointer back on mousemove. Hit-testing the real window proved both toggle
  // directions work (WS_EX_TRANSPARENT set / cleared, WindowFromPoint agrees),
  // but NOT that the claim reliably fires — a synthetic mousemove over the card
  // recorded no call at all. If that trigger ever misses, ignore-by-default
  // leaves the card unclickable: Start transcribing and Dismiss both dead.
  //
  // That failure is worse than the bug being fixed. Interactive-by-default
  // makes the worst case identical to the old behaviour (the window swallows a
  // scroll over its inset) and the best case the fix, with no state in between
  // that breaks the buttons.
  win.setIgnoreMouseEvents(false)

  // EXCLUDE THIS WINDOW FROM SCREEN CAPTURE. Not a nicety — the entire
  // live-coaching thesis dies the first time a rep's battlecard about the
  // prospect's competitor renders on the prospect's own screen during a share.
  // This overlay floats above everything by design, which is exactly what
  // makes it leak.
  //
  // One call covers both platforms: Electron maps it to NSWindowSharingNone on
  // macOS and SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) on Windows 10
  // 2004+ (falling back to WDA_MONITOR on older builds, which blanks the
  // window in the capture rather than hiding it — still not a leak).
  //
  // Applied unconditionally and never exposed as a setting: a toggle here is
  // one mis-click away from the failure it exists to prevent, and the value of
  // being able to show the overlay in a share does not come close.
  //
  // Our own buyer-side capture is unaffected: getDisplayMedia is opened for
  // its audio and the video track is stopped immediately (useTranscription).
  win.setContentProtection(true)

  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }
  win.on('moved', () => {
    const [x, y] = win.getPosition()
    savePositionDebounced(x, y)
  })
  win.on('closed', () => {
    overlayWindow = null
  })
  win.webContents.on('context-menu', () => {
    if (!overlayActions) return
    const running = overlayActions.isRunning()
    Menu.buildFromTemplate([
      { label: 'Open CallRise AI', click: () => overlayActions?.openMainWindow() },
      { type: 'separator' },
      running
        ? { label: 'Pause detection', click: () => overlayActions?.pauseDetection() }
        : { label: 'Resume detection', click: () => overlayActions?.resumeDetection() },
      { label: 'Pause detection for 1 hour', click: () => overlayActions?.snoozeDetection(60) }
    ]).popup({ window: win })
  })
  loadOverlayContent(win)
  return win
}

/**
 * Global (system-wide) shortcuts for the two actions a rep most wants
 * mid-call without hunting for the overlay's small buttons — Cmd/Ctrl+Shift+S
 * to stop, Cmd/Ctrl+Shift+P to pause/resume. `globalShortcut.register`
 * returns false (not a thrown error) if another app already holds the
 * combo — checked and left silently unregistered rather than fighting for
 * it, per the "only if they don't conflict" requirement.
 *
 * Gated on the SAME ff_ambient_detection enablement as the tray (see
 * detection-service.ts's syncTrayPresence) — a system-wide hotkey claimed
 * even while the feature is off would violate the "off means zero
 * footprint" rule the tray already follows. detection-service.ts calls
 * these alongside syncTrayPresence, not unconditionally at boot.
 */
export function enableOverlayShortcuts(): void {
  if (shortcutsRegistered || !overlayActions) return
  shortcutsRegistered = true
  const actions = overlayActions
  const stopOk = globalShortcut.register('CommandOrControl+Shift+S', () => actions.stopCapture())
  const pauseOk = globalShortcut.register('CommandOrControl+Shift+P', () => {
    if (actions.isRunning()) actions.pauseDetection()
    else actions.resumeDetection()
  })
  if (!stopOk) console.log('[detection-overlay] Cmd/Ctrl+Shift+S already taken by another app')
  if (!pauseOk) console.log('[detection-overlay] Cmd/Ctrl+Shift+P already taken by another app')
}

export function disableOverlayShortcuts(): void {
  if (!shortcutsRegistered) return
  shortcutsRegistered = false
  globalShortcut.unregister('CommandOrControl+Shift+S')
  globalShortcut.unregister('CommandOrControl+Shift+P')
}

/**
 * Pre-create the (hidden) overlay window at app boot rather than lazily on
 * first showOverlay() — window creation + first content load takes far
 * longer than the <100ms show budget on its own; by the time a call is
 * actually detected, this window already exists and showInactive() is
 * effectively instant. Safe to call unconditionally at startup regardless of
 * whether ambient detection ends up enabled - an unused hidden window costs
 * negligible memory and is never shown until showOverlay() is actually called.
 */
export function initOverlay(actions: OverlayActions): void {
  overlayActions = actions
  if (!overlayWindow || overlayWindow.isDestroyed()) overlayWindow = createOverlayWindow()
}

/** Show the overlay (creating it first if initOverlay() hasn't run yet). Never activates the app - this must not steal focus from whatever the rep is doing. */
export function showOverlay(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) overlayWindow = createOverlayWindow()
  if (!overlayWindow.isVisible()) overlayWindow.showInactive()
}

export function hideOverlay(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide()
}

export function disposeOverlay(): void {
  clearTimeout(savePositionTimer)
  disableOverlayShortcuts()
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close()
  overlayWindow = null
}
