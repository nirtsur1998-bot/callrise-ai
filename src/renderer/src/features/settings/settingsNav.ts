import type { SettingsPageId } from './settings-nav'

/**
 * "Open Settings, on THIS page."
 *
 * M31 Stage 3, discoverability policy item 3. The audit found that every
 * "in Settings → X" line in the product was a dead end: Settings always
 * opened on Account, so the user landed somewhere else and had to go hunting
 * through a 21-item list for a page whose name they had just been told but
 * which was, at the time, named after the subsystem rather than the thing
 * they wanted. Two separate failures compounding.
 *
 * That is why this comes FIRST in Stage 3 rather than alongside it: the
 * visible-off states are all of the form "this is switched off — turn it on",
 * and a button that lands on the wrong page is worse than no button, because
 * it costs a click to learn it does not work. An off-state without a working
 * destination would just be a prettier dead end.
 *
 * Same single-listener shape as jobNav.ts / assistantNav.ts / liveCallNav.ts,
 * and for the same structural reason: MainApp owns `active`, and callers are
 * scattered across screens that are nowhere near it in the tree. A no-op when
 * MainApp isn't mounted — never throws.
 */

let listener: ((page: SettingsPageId) => void) | null = null

/** Called once by MainApp in an effect. */
export function setSettingsNavListener(fn: ((page: SettingsPageId) => void) | null): void {
  listener = fn
}

/** Open the Settings surface directly on `page`. */
export function openSettingsAt(page: SettingsPageId): void {
  listener?.(page)
}
