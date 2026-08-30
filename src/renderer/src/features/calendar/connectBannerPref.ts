// The "connect a calendar" prompt's dismissed state.
//
// This used to live in calendarPreview.ts alongside the calendar preview
// FLAG. When the four M31 preview flags collapsed into one, that file was
// deleted — and this went with it, which it should not have: it is an
// ordinary user preference with nothing to do with the redesign, and it must
// keep working whether the new design is on or off.
//
// Split out rather than folded into designPreview.ts for exactly that reason:
// bundling an unrelated preference with a temporary rollout flag is how it
// gets deleted again when the flag eventually goes away.

const CONNECT_BANNER_KEY = 'salesos.calendar.connectBannerDismissed'

/** Whether the "connect a calendar" prompt has been dismissed. Dismissing it
 *  must never STRAND the feature — the header keeps a permanent low-key
 *  Connect entry point either way (see CalendarConnectBar), matching the
 *  audit's visible-off rule. */
export function loadConnectBannerDismissed(): boolean {
  try {
    return localStorage.getItem(CONNECT_BANNER_KEY) === 'true'
  } catch {
    return false
  }
}

export function saveConnectBannerDismissed(dismissed: boolean): void {
  try {
    localStorage.setItem(CONNECT_BANNER_KEY, String(dismissed))
  } catch {
    /* best-effort */
  }
}
