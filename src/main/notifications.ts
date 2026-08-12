// M26 Phase 2 — one shared native-notification helper. The app already had
// FOUR independent, hand-duplicated copies of `new Notification({title,
// body})` + `.on('click', ...)` (alerts.ts, contact-intelligence-ipc.ts,
// memory-hooks.ts, virtualmic.ts), flagged in the Phase 0 research as worth
// consolidating. This is that consolidation for anything NEW going through
// the job system; the four existing call sites are untouched for now (a
// separate, unrelated cleanup, not required for M26 to work).
import { BrowserWindow, Notification } from 'electron'

export interface ShowNotificationOptions {
  title: string
  body: string
  /** Called when the user clicks the notification, after the app's main
   *  window has already been restored/focused for them. Optional — a
   *  notification with no click handler still shows and still focuses the
   *  app on click, it just has nothing extra to do once it's there. */
  onClick?: () => void
}

/** No-op when the OS doesn't support notifications at all (matches
 *  virtualmic.ts's existing `Notification.isSupported()` guard) — never
 *  throws, since a missed notification is never worth crashing over. */
export function showNativeNotification({ title, body, onClick }: ShowNotificationOptions): void {
  if (!Notification.isSupported()) return
  const notification = new Notification({ title, body })
  notification.on('click', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
    onClick?.()
  })
  notification.show()
}
