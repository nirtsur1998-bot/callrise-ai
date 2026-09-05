// BUG-188 — closing the window does not quit CallRise. The detection overlay
// window keeps the app alive, so `window-all-closed` never fires and the app
// stays in the tray — which is what a call-detection app should do, and which
// nothing ever told the founder: "I didn't notice that closing the window
// doesn't quit the app until you told me. If that isn't obvious to me it isn't
// obvious to anyone."
//
// So: say it, ONCE, at the moment it happens. A native notification the first
// time the main window closes while the app keeps running, remembered by a
// marker file in userData (the same once-only shape as the migration markers).
// Not a behaviour change — the tray behaviour is right; the silence was the gap.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const TRAY_NOTICE_MARKER = 'tray-notice-shown.json'

export const TRAY_NOTICE = {
  title: 'CallRise AI is still running',
  body: 'Closing the window keeps CallRise in the tray so your calls are still detected. Open it again or quit from the tray icon.'
} as const

/**
 * Decide and record. Returns true exactly once per install — the first close
 * of the main window while the app keeps running. Pure apart from the marker.
 */
export function noteMainWindowClosedToTray(
  userData: string,
  stillRunning: boolean,
  show: (n: { title: string; body: string }) => void
): boolean {
  if (!stillRunning) return false
  const marker = join(userData, TRAY_NOTICE_MARKER)
  try {
    if (existsSync(marker)) return false
    mkdirSync(userData, { recursive: true })
    writeFileSync(marker, JSON.stringify({ shownAt: new Date().toISOString() }))
  } catch {
    // If the marker cannot be written, still say it once now rather than never.
  }
  try {
    show(TRAY_NOTICE)
  } catch {
    /* a notification that cannot show must never break closing the window */
  }
  return true
}
