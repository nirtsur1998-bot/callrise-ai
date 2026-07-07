// Foreground-app detection for AI Note Taker's "exclude these apps" feature.
// Needs macOS Accessibility permission (active-win's native helper fails
// without it) — detection is always best-effort: any failure (permission
// not granted, unsupported platform, helper crash) resolves to null, and
// callers must fail OPEN (never block auto-start just because detection
// itself didn't work).
import { app, ipcMain, shell } from 'electron'
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

// --- Last EXTERNAL app -------------------------------------------------------
// The exclusion check fires when the Live Calls screen mounts — but the user
// just clicked into THIS app to get there, so the frontmost app at that moment
// is always CallRise AI itself and the excluded-apps list never matched anything.
// The meaningful signal is what the rep was using BEFORE switching here, so we
// sample the frontmost app while OUR window is unfocused (one cheap check every
// few seconds, only while blurred, name kept in memory only) and remember the
// last one that isn't us.
let lastExternalApp: string | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
const POLL_MS = 5_000

function isSelf(name: string): boolean {
  return name === app.getName() || name === 'Electron'
}

async function sampleExternalApp(): Promise<void> {
  const name = await getActiveAppName()
  if (name && !isSelf(name)) lastExternalApp = name
}

function startSampling(): void {
  if (pollTimer) return
  void sampleExternalApp()
  pollTimer = setInterval(() => void sampleExternalApp(), POLL_MS)
}

function stopSampling(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

let registered = false

export function registerActiveApp(): void {
  if (registered) return
  registered = true

  app.on('browser-window-blur', startSampling)
  app.on('browser-window-focus', stopSampling)

  ipcMain.handle('app:getActiveApp', (): Promise<string | null> => getActiveAppName())
  // What the rep was using before switching into this app — the value the
  // auto-start exclusion check actually needs.
  ipcMain.handle('app:getLastExternalApp', (): string | null => lastExternalApp)

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
