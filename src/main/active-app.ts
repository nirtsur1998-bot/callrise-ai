// Foreground-app detection for AI Note Taker's "exclude these apps" feature.
// Needs macOS Accessibility permission (active-win's native helper fails
// without it) — detection is always best-effort: any failure (permission
// not granted, unsupported platform, helper crash) resolves to null, and
// callers must fail OPEN (never block auto-start just because detection
// itself didn't work).
import { ipcMain, shell } from 'electron'
import activeWin from 'active-win'

/** The frontmost app's name, or null if detection isn't available/failed. */
export async function getActiveAppName(): Promise<string | null> {
  try {
    const result = await activeWin()
    const name = result?.owner?.name
    return typeof name === 'string' && name ? name : null
  } catch {
    return null
  }
}

let registered = false

export function registerActiveApp(): void {
  if (registered) return
  registered = true

  ipcMain.handle('app:getActiveApp', (): Promise<string | null> => getActiveAppName())

  // Deep-link to the permission active-win needs, mirroring the mic/screen-
  // recording settings links elsewhere in this app.
  ipcMain.handle('app:openAccessibilitySettings', async () => {
    if (process.platform !== 'darwin') {
      return { ok: false as const, error: 'not applicable on this platform' }
    }
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
    )
    return { ok: true as const }
  })
}
