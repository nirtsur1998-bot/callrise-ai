// State-reflecting tray icon for ambient call detection. SIMPLIFICATION
// FLAGGED: the spec calls for a distinct icon glyph per state (idle /
// detected-not-capturing / capturing / paused) - that needs real designed
// icon assets, which don't exist in this repo. This uses the app's one
// existing icon for every state and instead reflects state via the tooltip
// text and the (disabled) top menu item, updated on every transition - state
// is genuinely reflected, just via text rather than four distinct glyphs.
import { Menu, Tray } from 'electron'
import icon from '../../resources/icon.png?asset'

export interface TrayActions {
  openMainWindow: () => void
  pauseDetection: () => void
  resumeDetection: () => void
  stopCapture: () => void
  snoozeDetection: (minutes: number) => void
}

export interface TraySnapshot {
  /** Whether the detector is actually running (adapter started) - distinct from the ff_ambient_detection setting, since Pause/Resume toggles this without touching the setting. */
  running: boolean
  stateName:
    | 'idle'
    | 'candidate'
    | 'detected'
    | 'capturing'
    | 'capturing-with-pending'
    | 'ending'
    | undefined
}

let tray: Tray | null = null

function statusLabel(snapshot: TraySnapshot): string {
  if (!snapshot.running) return 'Detection paused'
  switch (snapshot.stateName) {
    case 'capturing':
    case 'capturing-with-pending':
      return 'Capturing a call'
    case 'ending':
      return 'Wrapping up…'
    case 'candidate':
    case 'detected':
      return 'Call detected'
    default:
      return 'Watching for calls'
  }
}

export function registerDetectionTray(actions: TrayActions): void {
  if (tray) return
  tray = new Tray(icon)
  tray.setToolTip('CallRise AI')
  updateTray({ running: false, stateName: 'idle' }, actions)
}

export function updateTray(snapshot: TraySnapshot, actions: TrayActions): void {
  if (!tray) return
  const capturing =
    snapshot.stateName === 'capturing' || snapshot.stateName === 'capturing-with-pending'
  const label = statusLabel(snapshot)

  tray.setToolTip(`CallRise AI — ${label}`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label, enabled: false },
      { type: 'separator' },
      { label: 'Open CallRise AI', click: () => actions.openMainWindow() },
      { type: 'separator' },
      snapshot.running
        ? { label: 'Pause detection', click: () => actions.pauseDetection() }
        : { label: 'Resume detection', click: () => actions.resumeDetection() },
      { label: 'Pause detection for 1 hour', click: () => actions.snoozeDetection(60) },
      ...(capturing ? [{ label: 'Stop capturing', click: () => actions.stopCapture() }] : [])
    ])
  )
}

export function disposeTray(): void {
  tray?.destroy()
  tray = null
}
