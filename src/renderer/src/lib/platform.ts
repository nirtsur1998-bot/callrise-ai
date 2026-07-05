// The renderer runs sandboxed; `window.electron.process` (exposed by
// @electron-toolkit/preload) is the only place it can read the OS platform.
export const isMac = window.electron.process.platform === 'darwin'
export const isWindows = window.electron.process.platform === 'win32'
