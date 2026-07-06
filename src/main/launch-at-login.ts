// "Launch at login" — a real OS-level setting via Electron's built-in login
// item API (macOS/Windows). No separate storage: the OS itself is the source
// of truth, read fresh on every check.
import { app, ipcMain } from 'electron'

export function getLaunchAtLogin(): boolean {
  return app.getLoginItemSettings().openAtLogin
}

export function setLaunchAtLogin(value: boolean): boolean {
  app.setLoginItemSettings({ openAtLogin: value })
  return app.getLoginItemSettings().openAtLogin
}

let registered = false

export function registerLaunchAtLogin(): void {
  if (registered) return
  registered = true
  ipcMain.handle('app:getLaunchAtLogin', (): boolean => getLaunchAtLogin())
  ipcMain.handle('app:setLaunchAtLogin', (_event, value: unknown): boolean =>
    setLaunchAtLogin(value === true)
  )
}
