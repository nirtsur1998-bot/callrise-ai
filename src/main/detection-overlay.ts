// Manages the ONE always-on-top overlay window used for all three ambient-
// detection UI surfaces (live capture banner, detection toast, switch
// prompt) — a single window whose renderer content (features/detection/
// DetectionOverlay.tsx) switches what it shows based on IPC state, rather
// than three independently-managed windows. Never steals focus
// (focusable: false + showInactive()); position is remembered across drags.
import { app, BrowserWindow, screen } from 'electron'
import { is } from '@electron-toolkit/utils'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { writeJsonAtomicSync } from './atomic-write'

const WIDTH = 360
const HEIGHT = 180
const MARGIN = 20

let overlayWindow: BrowserWindow | null = null
let savePositionTimer: ReturnType<typeof setTimeout> | undefined

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
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
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
  loadOverlayContent(win)
  return win
}

/** Show the overlay (creating it on first use). Never activates the app - this must not steal focus from whatever the rep is doing. */
export function showOverlay(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) overlayWindow = createOverlayWindow()
  if (!overlayWindow.isVisible()) overlayWindow.showInactive()
}

export function hideOverlay(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide()
}

export function disposeOverlay(): void {
  clearTimeout(savePositionTimer)
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close()
  overlayWindow = null
}
