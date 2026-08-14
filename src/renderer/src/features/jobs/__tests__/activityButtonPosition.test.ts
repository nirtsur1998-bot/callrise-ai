// M27 — the Activity Center button is draggable anywhere in the window.
// These cover the two things a drag feature actually gets wrong: letting the
// button escape the window (or become unreachable after a resize), and
// opening its panel off-screen once the button is no longer in the corner it
// was designed around.
import { describe, expect, it } from 'vitest'
import {
  BUTTON_SIZE,
  PANEL_WIDTH,
  clampToViewport,
  defaultPosition,
  panelPlacement
} from '../activityButtonPosition'

const DESKTOP = { width: 1440, height: 900 }

describe('defaultPosition — unchanged for anyone who never drags it', () => {
  it('is the original bottom-right corner (right-6 bottom-24)', () => {
    const p = defaultPosition(DESKTOP)
    // right-6 = 24px from the right edge; bottom-24 = 96px from the bottom.
    expect(DESKTOP.width - (p.x + BUTTON_SIZE)).toBe(24)
    expect(DESKTOP.height - (p.y + BUTTON_SIZE)).toBe(96)
  })
})

describe('clampToViewport — the button can never be lost', () => {
  it('keeps a button dragged past the right/bottom edges fully on screen', () => {
    const p = clampToViewport({ x: 5000, y: 5000 }, DESKTOP)
    expect(p.x + BUTTON_SIZE).toBeLessThanOrEqual(DESKTOP.width)
    expect(p.y + BUTTON_SIZE).toBeLessThanOrEqual(DESKTOP.height)
  })

  it('keeps a button dragged past the top/left edges fully on screen', () => {
    const p = clampToViewport({ x: -500, y: -500 }, DESKTOP)
    expect(p.x).toBeGreaterThanOrEqual(0)
    expect(p.y).toBeGreaterThanOrEqual(0)
  })

  it('pulls an off-screen button back when the window SHRINKS — the unreachable case', () => {
    // The real scenario this exists for: parked at the right edge of a
    // maximised window, then the window is restored to half width. Without
    // re-clamping on resize, "drag it anywhere" would include "drag it
    // somewhere you can never get it back from".
    const parkedFarRight = defaultPosition({ width: 2560, height: 1440 })
    const afterRestore = clampToViewport(parkedFarRight, { width: 1024, height: 768 })
    expect(afterRestore.x + BUTTON_SIZE).toBeLessThanOrEqual(1024)
    expect(afterRestore.y + BUTTON_SIZE).toBeLessThanOrEqual(768)
  })

  it('leaves a position that is already comfortably inside completely alone', () => {
    // Clamping must be a no-op in the common case — otherwise a drag would
    // feel like it was fighting the pointer.
    const inside = { x: 600, y: 400 }
    expect(clampToViewport(inside, DESKTOP)).toEqual(inside)
  })

  it('never returns a negative coordinate even if the viewport is smaller than the button', () => {
    // Possible for a frame mid-resize; the max/min would otherwise cross over.
    const p = clampToViewport({ x: 10, y: 10 }, { width: 20, height: 20 })
    expect(p.x).toBeGreaterThanOrEqual(0)
    expect(p.y).toBeGreaterThanOrEqual(0)
  })
})

describe('panelPlacement — the panel opens where there is room', () => {
  it('opens up-and-leftward from the default bottom-right corner (unchanged behaviour)', () => {
    // The pre-drag hardcoded placement was `bottom-12 right-0`; the default
    // position must still produce exactly that, so nothing moves for a rep
    // who never drags the button.
    expect(panelPlacement(defaultPosition(DESKTOP), DESKTOP)).toEqual({
      vertical: 'above',
      horizontal: 'right'
    })
  })

  it('opens DOWNWARD when the button is dragged to the top', () => {
    // The bug this prevents: the old hardcoded `bottom-12` would render the
    // panel above a top-edge button — i.e. off the top of the window.
    expect(panelPlacement({ x: 600, y: 10 }, DESKTOP).vertical).toBe('below')
  })

  it('opens RIGHTWARD when the button is dragged to the left edge', () => {
    // Likewise `right-0` on a left-edge button would push the panel's left
    // edge to roughly -280px.
    expect(panelPlacement({ x: 10, y: 500 }, DESKTOP).horizontal).toBe('left')
  })

  it('handles the top-left corner — both axes flip at once', () => {
    expect(panelPlacement({ x: 10, y: 10 }, DESKTOP)).toEqual({
      vertical: 'below',
      horizontal: 'left'
    })
  })

  it('keeps the panel on screen horizontally wherever the button is', () => {
    // Sweeps the full width rather than testing two hand-picked points: for
    // every x, the chosen anchor must place all PANEL_WIDTH pixels inside the
    // window. A single off-by-one in the overflow check would show up here
    // and not in a two-point test.
    for (let x = 0; x <= DESKTOP.width - BUTTON_SIZE; x += 10) {
      const { horizontal } = panelPlacement({ x, y: 500 }, DESKTOP)
      const left = horizontal === 'left' ? x : x + BUTTON_SIZE - PANEL_WIDTH
      expect(left).toBeGreaterThanOrEqual(0)
      expect(left + PANEL_WIDTH).toBeLessThanOrEqual(DESKTOP.width)
    }
  })
})
