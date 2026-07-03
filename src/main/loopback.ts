// Lets the renderer's getDisplayMedia() receive macOS system-audio loopback —
// the other party's voice coming through the rep's headphones/output (M12).
//
// Security note: the renderer only ever calls getDisplayMedia AFTER the user
// records consent (the M11 "no consent = no capture" invariant lives at the
// call site + in the main-process retention strip). This handler simply hands
// back a screen as the (required) video source — which the renderer discards —
// plus system-audio loopback when asked.
import { session, desktopCapturer } from 'electron'

export function registerLoopbackCapture(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
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
