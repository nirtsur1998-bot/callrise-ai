// Foreground-app detection for AI Note Taker's "exclude these apps" feature.
// Only the frontmost app's NAME is used (never its window title or URL), and
// active-win only needs macOS Accessibility/Screen Recording permission to
// fetch those two extra fields — so both are explicitly disabled via its
// `accessibilityPermission`/`screenRecordingPermission: false` options.
//
// That alone turned out NOT to be enough to stop the repeated native
// permission prompt (reported 2026-07-28, after the flags above had already
// shipped): active-win's macOS helper is a separately compiled binary
// (node_modules/active-win/main) that still performs its OWN baseline
// Accessibility-trust check before it can honor those flags at all — and
// on an unsigned/ad-hoc-signed rebuild (a NEW code-signing identity every
// build, which TCC treats as a different app each time, even at the same
// bundle id), THAT check itself is what triggers the OS prompt, regardless
// of what the flags say to skip afterward. The poll below fires
// automatically every 5s whenever the window loses focus — with no user
// gesture attached to it, that background poll was silently re-triggering
// the prompt on every blur, on a machine where the CURRENT build's identity
// had never actually been granted (even though an OLDER build's identity
// still shows as "granted" in System Settings, which is exactly the
// confusing "it says it's allowed but keeps asking" symptom).
//
// Fix: check trust via Electron's OWN non-prompting API
// (`systemPreferences.isTrustedAccessibilityClient(false)` — the `false`
// means "just tell me, don't ask") BEFORE ever invoking active-win's
// helper. If this build's identity isn't currently trusted, skip the
// active-win call entirely — the exclusion-detection feature just silently
// doesn't work until the user (re-)grants it for this exact build, which is
// far better than nagging them with a system prompt they can't seem to
// satisfy every few seconds.
import { app, ipcMain, BrowserWindow, systemPreferences } from 'electron'
import activeWin from 'active-win'
import { isKnownCallingApp } from './known-calling-apps'

function hasAccessibilityTrust(): boolean {
  // Only macOS gates this; other platforms have no equivalent TCC prompt.
  if (process.platform !== 'darwin') return true
  try {
    return systemPreferences.isTrustedAccessibilityClient(false)
  } catch {
    return false // never risk a prompt if the check itself is unavailable
  }
}

/** The frontmost app's name, or null if detection isn't available/failed. */
export async function getActiveAppName(): Promise<string | null> {
  if (!hasAccessibilityTrust()) return null
  try {
    const result = await activeWin({
      accessibilityPermission: false,
      screenRecordingPermission: false
    })
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

// --- Known-calling-app detection --------------------------------------------
// A lightweight heuristic layered on the same poll: if the frontmost app
// while we're blurred matches a known calling app (WhatsApp, Zoom, Teams,
// MicroSIP, …), tell every window once so it can offer to start transcribing.
// `lastNotifiedApp` prevents re-notifying every 5s for the same ongoing call —
// it only resets when the rep returns to CallRise (a fresh blur means a fresh
// chance to notice a NEW call, even in the same app).
let lastNotifiedApp: string | null = null

function broadcastCallDetected(appName: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('app:callDetected', appName)
  }
}

async function sampleExternalApp(): Promise<void> {
  const name = await getActiveAppName()
  if (!name || isSelf(name)) return
  lastExternalApp = name
  if (isKnownCallingApp(name) && name !== lastNotifiedApp) {
    lastNotifiedApp = name
    broadcastCallDetected(name)
  }
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
  // A fresh return-to-CallRise means the next blur should be able to notice a
  // new call, even one in the same app the rep was just using.
  lastNotifiedApp = null
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

  // Lets the renderer show the right "fix this" instructions — a packaged
  // install has no `npm run dev` to restart, it just needs relaunching.
  ipcMain.handle('app:isPackaged', (): boolean => app.isPackaged)
}
