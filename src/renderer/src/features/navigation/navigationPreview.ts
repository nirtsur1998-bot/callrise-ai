// Pure UI preference — renderer-only localStorage, same pattern as theme.ts.
// The main process never needs to know which nav layout is showing, and this
// deliberately does NOT live in AppSettings: it's a personal, device-local
// "try the new look" toggle, not something that should follow the user to
// another machine or get swept into a cloud restore.

const KEY = 'salesos.navigation.preview'

export function loadNavigationPreview(): boolean {
  try {
    return localStorage.getItem(KEY) === 'true' // default: today's 12-item nav, unchanged
  } catch {
    return false
  }
}

export function saveNavigationPreview(enabled: boolean): void {
  try {
    localStorage.setItem(KEY, String(enabled))
  } catch {
    /* best-effort: a nav-layout preference is non-critical */
  }
}
