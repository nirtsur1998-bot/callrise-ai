// BUG-171 — does the expanded Voice AI rail FIT beside the centre column?
//
// The shell is three fixed-or-flex columns: the 240px sidebar, the centre
// (`flex-1 min-w-0`), and the Voice AI rail (320px expanded, 64px collapsed).
// Nothing ever floored the centre, so it was simply "window − 560" with the
// rail open: at the 880px window minimum that is 320px, and the live screen
// then reserves 280px more for the cue rail (BUG-165) — ~40px of transcript.
// Measured on the founder's app, 2026-09-05: main 1072/796/576 at
// 1376/1100/880 with the rail collapsed; subtract 256 more when it is open.
//
// Founder's shape (2026-09-05): below a floor the rail folds to its 64px strip
// on its own and unfolds again when there is room; the user's OWN choice is
// remembered, never overwritten. Floor 560px — with cues showing that leaves
// the live transcript ~280px, and the founder's 1280 window is unaffected.
//
// Pure: the numbers live here so the fit can be tested without a DOM, and so
// the widths are one source of truth the shell reads rather than a second
// copy that drifts the first time `w-60` or `w-80` changes.

/** AppShell's left sidebar: `w-60`. */
export const SIDEBAR_WIDTH_PX = 240
/** AppShell's Voice AI rail when expanded: `w-80`. */
export const VOICE_AI_EXPANDED_WIDTH_PX = 320
/** AppShell's Voice AI rail when collapsed: `w-16`. */
export const VOICE_AI_COLLAPSED_WIDTH_PX = 64
/** The centre column never goes below this while the rail is open. */
export const CENTRE_FLOOR_PX = 560

/** The narrowest window at which the expanded rail still fits. */
export const VOICE_AI_FITS_FROM_PX = SIDEBAR_WIDTH_PX + VOICE_AI_EXPANDED_WIDTH_PX + CENTRE_FLOOR_PX

/** True when an expanded rail leaves the centre at least CENTRE_FLOOR_PX. */
export function voiceAiFitsAt(windowWidthPx: number): boolean {
  // NaN never fits (a rail open on a width nobody measured is the bug again);
  // Infinity does — it is "no constraint", not "no width".
  return !Number.isNaN(windowWidthPx) && windowWidthPx >= VOICE_AI_FITS_FROM_PX
}

/**
 * What the shell should actually show: the user's choice, unless the rail
 * does not fit — then collapsed, whatever the choice. The choice itself is
 * untouched, so widening the window brings the rail straight back.
 */
export function effectiveVoiceAiCollapsed(userCollapsed: boolean, windowWidthPx: number): boolean {
  return userCollapsed || !voiceAiFitsAt(windowWidthPx)
}
