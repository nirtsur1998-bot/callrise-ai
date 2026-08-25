// Reads the OS platform through the app's own narrow bridge.
//
// This used to read `window.electron.process.platform`, under a comment
// asserting that the renderer "runs sandboxed" and that `window.electron`
// was "the only place it can read the OS platform". BOTH were false:
// `sandbox: false` is set explicitly on both windows (main/index.ts:254,
// main/detection-overlay.ts:114), and `window.api.platform` — the same
// value — has existed in the preload all along (preload/index.ts:21) and
// was already being used directly by DetectionOverlay.tsx.
//
// It mattered because those three lines were the ENTIRE justification for
// `contextBridge.exposeInMainWorld('electron', electronAPI)`, which handed
// the renderer a raw `ipcRenderer` taking the channel name as a FREE
// PARAMETER — every `ipcMain.handle`/`on` channel in the app, reachable
// regardless of the curated `api` object — plus `process.env`, which holds
// the user's AI API keys. A comment claiming the bridge was load-bearing is
// what kept it alive; that is why this note is long.
export const isMac = window.api.platform === 'darwin'
export const isWindows = window.api.platform === 'win32'

/** Buyer-side (other-party) capture — Electron's getDisplayMedia +
 *  `audio: 'loopback'` is genuinely cross-platform (WASAPI loopback on
 *  Windows, ScreenCaptureKit-backed loopback on macOS); only Linux has no
 *  supported path. Kept as one flag so every "is this platform capable"
 *  check across the app/main processes agrees with the single source of
 *  truth in main/loopback.ts. */
export const supportsOtherPartyCapture = isMac || isWindows
