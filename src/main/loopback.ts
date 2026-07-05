// Lets the renderer's getDisplayMedia() receive macOS system-audio loopback —
// the other party's voice coming through the rep's headphones/output (M12).
//
// Consent backstop: capture is DENIED unless the renderer has "armed" it first.
// The renderer arms exactly one request, synchronously, immediately before each
// getDisplayMedia call — and only after consent has been recorded. The handler
// consumes the arm (one grant per arm) and rejects any un-armed request. This is
// the main-process guard for "no consent = no capture" on the CAPTURE path,
// mirroring the retention guard in calls-fs.ts. It complements — never replaces
// — the renderer-side consent checks.
import { ipcMain, session, desktopCapturer, shell } from 'electron'

// One-shot: set true by 'loopback:arm', consumed the moment a request is granted.
let armed = false

export function registerLoopbackCapture(): void {
  // Deep-link to the OS's screen/system-audio recording permission pane so the
  // rep can grant the permission buyer capture needs (mirrors the mic settings
  // helper). Only macOS gates this behind a permission prompt; Windows has no
  // equivalent per-app screen-recording toggle, so there's nothing to open.
  ipcMain.handle('loopback:openScreenSettings', async () => {
    if (process.platform !== 'darwin') {
      return { ok: false as const, error: 'not applicable on this platform' }
    }
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    )
    return { ok: true as const }
  })

  // Synchronous arm/disarm so the renderer can flip this in the same tick as the
  // click gesture, right before getDisplayMedia (an async IPC would race).
  ipcMain.on('loopback:arm', (event) => {
    armed = true
    event.returnValue = true
  })
  ipcMain.on('loopback:disarm', (event) => {
    armed = false
    event.returnValue = true
  })

  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      if (!armed) {
        callback({}) // deny — not armed by a consent-gated capture start
        return
      }
      armed = false // consume: one grant per arm
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          if (sources.length === 0) {
            callback({})
            return
          }
          callback({ video: sources[0], audio: 'loopback' })
        })
        .catch(() => callback({}))
    },
    { useSystemPicker: false }
  )
}
