// Pure UI preferences for the calendar — renderer-only localStorage, same
// pattern as navigation/navigationPreview.ts and settings/theme.ts.
// Device-local, not synced to AppSettings/cloud: both of these are personal
// per-machine view choices, not account state that should follow the user.

const KEY = 'salesos.calendar.preview'
const CONNECT_BANNER_KEY = 'salesos.calendar.connectBannerDismissed'

export function loadCalendarPreview(): boolean {
  try {
    return localStorage.getItem(KEY) === 'true' // default: today's calendar, unchanged
  } catch {
    return false
  }
}

export function saveCalendarPreview(enabled: boolean): void {
  try {
    localStorage.setItem(KEY, String(enabled))
  } catch {
    /* best-effort: a calendar-layout preference is non-critical */
  }
}

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
