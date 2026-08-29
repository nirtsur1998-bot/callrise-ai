// The reworked-Settings preview flag (M31 Stage 5).
//
// Same shape as navigationPreview / calendarPreview / identityPreview:
// renderer-only localStorage, device-local, never synced.
//
// Why this is flagged at all, given it only regroups a nav: taxonomy species
// 44. "This changes no behaviour" is not "this needs no consent" — the
// Settings sidebar is what someone meets every time they go looking for a
// control, and re-grouping it is exactly the kind of change that is invisible
// in a diff and unmissable in use. The rule is now: anything that changes what
// the user sees when they open a screen is opt-in.
//
// DEFAULT: on, matching identityPreview, so the founder sees the new IA
// without hunting for a switch — and the switch is the before/after
// comparison. `!== 'false'` -> `=== 'true'` is the one-line change if it
// should ship off.

const KEY = 'salesos.settings.preview'

export function loadSettingsPreview(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'false'
  } catch {
    return true
  }
}

export function saveSettingsPreview(enabled: boolean): void {
  try {
    localStorage.setItem(KEY, String(enabled))
  } catch {
    /* best-effort: a nav-grouping preference is non-critical */
  }
}
