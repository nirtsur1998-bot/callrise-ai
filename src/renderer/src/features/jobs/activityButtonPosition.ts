// M27 — the Activity Center button is draggable anywhere in the window, so
// it can be parked wherever it doesn't cover whatever the rep is actually
// working on (its fixed bottom-right home sat over the Voice AI panel's own
// controls on the live-call screen).
//
// Pure geometry, no React and no DOM — same convention as the rest of this
// codebase's logic/wiring split (auto-stop.ts's IdleStopWatcher,
// jobs/activity.ts's ActivityNotifier). The component owns pointer events;
// everything that could be gotten *wrong* — staying on screen, not opening a
// panel off the edge — lives here where it can be unit-tested directly.

export interface Point {
  x: number
  y: number
}

export interface Viewport {
  width: number
  height: number
}

/** Matches the button's own `h-10 w-10`. */
export const BUTTON_SIZE = 40
/** Matches the panel's `w-80`. */
export const PANEL_WIDTH = 320
/** Kept clear of every edge so the button never half-hangs off the window
 *  (and never lands under the rounded window corners on Windows 11). */
const EDGE_MARGIN = 8
/** Roughly the panel's own `max-h-[70vh]` at a typical window height — only
 *  used to decide which SIDE to open toward, never to size anything, so an
 *  approximation is fine. */
const PANEL_HEIGHT_ESTIMATE = 380

/** Where the button sits before anyone has dragged it: the original
 *  bottom-right home (`right-6 bottom-24`), preserved exactly so nothing
 *  moves for a rep who never touches it. */
export function defaultPosition(v: Viewport): Point {
  return { x: v.width - 24 - BUTTON_SIZE, y: v.height - 96 - BUTTON_SIZE }
}

/**
 * Keep the button fully on screen.
 *
 * Runs on every drag frame AND on window resize — the second is what stops a
 * button parked at the right edge of a maximised window from becoming
 * unreachable when the window is restored to half width. Without it, "drag it
 * anywhere" would include "drag it somewhere you can never get it back from".
 */
export function clampToViewport(p: Point, v: Viewport): Point {
  // Math.max guards a viewport smaller than the button itself (possible
  // mid-resize) — without it the max would fall below the min and the button
  // would snap to a negative coordinate.
  const maxX = Math.max(EDGE_MARGIN, v.width - BUTTON_SIZE - EDGE_MARGIN)
  const maxY = Math.max(EDGE_MARGIN, v.height - BUTTON_SIZE - EDGE_MARGIN)
  return {
    x: Math.min(Math.max(p.x, EDGE_MARGIN), maxX),
    y: Math.min(Math.max(p.y, EDGE_MARGIN), maxY)
  }
}

export interface PanelPlacement {
  /** Which way the panel opens from the button. */
  vertical: 'above' | 'below'
  /** Which of the panel's edges is pinned to the button's matching edge. */
  horizontal: 'left' | 'right'
}

/**
 * Which way the panel should open, given where the button ended up.
 *
 * The whole reason this exists: the panel used to be hardcoded `right-0
 * bottom-12`, which is correct ONLY for a button in the bottom-right corner.
 * Once the button can be dragged to the top-left, that same panel would open
 * upward and leftward — i.e. off-screen, twice. Each axis independently picks
 * the side with room.
 */
export function panelPlacement(p: Point, v: Viewport): PanelPlacement {
  const roomAbove = p.y
  const roomBelow = v.height - (p.y + BUTTON_SIZE)
  // Prefer opening upward (the original, familiar direction) whenever there
  // is genuinely room for it; only flip when there isn't.
  const vertical: PanelPlacement['vertical'] =
    roomAbove >= PANEL_HEIGHT_ESTIMATE || roomAbove >= roomBelow ? 'above' : 'below'

  // Anchoring the panel's RIGHT edge to the button's right edge makes it
  // extend leftward — correct near the right edge of the window.
  const wouldOverflowRight = p.x + PANEL_WIDTH > v.width
  return { vertical, horizontal: wouldOverflowRight ? 'right' : 'left' }
}
