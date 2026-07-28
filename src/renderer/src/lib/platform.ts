// The renderer runs sandboxed; `window.electron.process` (exposed by
// @electron-toolkit/preload) is the only place it can read the OS platform.
export const isMac = window.electron.process.platform === 'darwin'
export const isWindows = window.electron.process.platform === 'win32'

/** Buyer-side (other-party) capture — Electron's getDisplayMedia +
 *  `audio: 'loopback'` is genuinely cross-platform (WASAPI loopback on
 *  Windows, ScreenCaptureKit-backed loopback on macOS); only Linux has no
 *  supported path. Kept as one flag so every "is this platform capable"
 *  check across the app/main processes agrees with the single source of
 *  truth in main/loopback.ts. */
export const supportsOtherPartyCapture = isMac || isWindows
