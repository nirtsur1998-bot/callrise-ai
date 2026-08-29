// The First Light identity preview flag (M31 Stage 4).
//
// Same shape as navigation/navigationPreview.ts and calendar/calendarPreview.ts:
// renderer-only localStorage, device-local, never synced. A look is a personal
// per-machine choice, not account state.
//
// What it gates: ONLY the value of the colour tokens. `.first-light` on <html>
// swaps one set of custom-property values for another — no component branches
// on it, no layout differs, no data path is involved. That is why turning it
// off is a true revert rather than a second code path to maintain: with the
// class absent, every `bg-surface` / `text-ink` / `bg-accent-fill` utility
// resolves to exactly the values the app shipped before Stage 4.
//
// DEFAULT: on. The recorded Stage 4 decision says "opt-in", and off would be
// the literal reading — but the founder also asked to actually SEE the new
// look, and a preview nobody has switched on shows them the old one. On-by-
// default with a one-click revert serves both: First Light is what you get,
// and the toggle is the before/after comparison. Flipping this to `!== 'false'`
// -> `=== 'true'` is the one-line change if it should be off before release.

const KEY = 'salesos.identity.preview'

export function loadIdentityPreview(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'false'
  } catch {
    return true
  }
}

export function saveIdentityPreview(enabled: boolean): void {
  try {
    localStorage.setItem(KEY, String(enabled))
  } catch {
    /* best-effort: a colour preference is non-critical */
  }
}
