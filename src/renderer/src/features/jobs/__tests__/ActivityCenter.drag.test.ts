// @vitest-environment happy-dom
//
// M27 re-audit, row 12 — the draggable Activity button, driven by REAL
// pointer events on the REAL component.
//
// activityButtonPosition.test.ts covers the geometry (defaultPosition,
// clampToViewport, panelPlacement) exhaustively, and those are pure
// functions that deserve exactly that treatment. But the geometry is not
// where the behaviour lives. What a user actually experiences is assembled
// in the component's pointer handlers: a 4px threshold separating a click
// from a drag, a suppression flag so the drop does not also open the panel,
// pointer capture so a fast drag does not outrun a 40px target, and a write
// to localStorage on drop only.
//
// None of that was exercised by anything (taxonomy species 21: the unit is
// tested, the door the user comes through is not). The specific bug this
// shape hides is the one a user notices immediately — drag the button and
// the panel pops open on release, because the click that follows a drag was
// never suppressed.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/lib/platform', () => ({ isMac: false, isWindows: true }))

// The panel's contents are irrelevant here and drag a large dependency tree
// behind them; this file is about the button's pointer behaviour.
vi.mock('../JobList', () => ({ JobList: () => null }))

// The component calls useToast(), which throws outside <ToastProvider>.
// Mocked rather than wrapped: this file is about pointer behaviour, and
// rendering the real provider would pull in the notification stack for no
// benefit here.
vi.mock('@renderer/features/notifications/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() })
}))

const POSITION_KEY = 'salesos.activityCenter.position'

/** Every jobs API the component touches. Discovered by grepping the
 *  component rather than guessing — a missing one throws at render and every
 *  test in the file fails for a reason unrelated to what it asserts. */
const unsubscribe = (): void => {}
const jobsApi = {
  list: vi.fn(async () => []),
  onChanged: vi.fn(() => unsubscribe),
  onNotify: vi.fn(() => unsubscribe),
  onOpenRequested: vi.fn(() => unsubscribe),
  cancel: vi.fn(async () => ({ ok: true })),
  retry: vi.fn(async () => ({ ok: true })),
  resume: vi.fn(async () => ({ ok: true })),
  dismiss: vi.fn(async () => ({ ok: true }))
}
vi.stubGlobal('window', globalThis.window)
;(globalThis as unknown as { window: Record<string, unknown> }).window.api = { jobs: jobsApi }

const { ActivityCenter } = await import('../ActivityCenter')

let container: HTMLDivElement
let root: Root

/** A real PointerEvent through the real listener. happy-dom does not
 *  implement pointer capture, so those are stubbed on the element — their
 *  absence would otherwise throw and make every test here fail for a reason
 *  that has nothing to do with the behaviour under test. */
function pointer(el: Element, type: string, x: number, y: number): void {
  const ev = new window.MouseEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0 })
  Object.defineProperty(ev, 'pointerId', { value: 1 })
  act(() => {
    el.dispatchEvent(ev)
  })
}

/** Open vs closed, discriminated by the panel's own <h3>Activity</h3>.
 *
 *  The first version of this file asserted on container.textContent
 *  containing "Activity" — which is ALWAYS true, because the button carries
 *  title="Activity — drag to move". Three "the panel opened" assertions and
 *  one "it did not open" assertion were therefore vacuous, and the red check
 *  proved it: removing the click-suppression failed only ONE of the six
 *  tests, and not the one written to catch exactly that bug. Species 5,
 *  found the only way it ever is — by reverting the fix and reading which
 *  tests actually noticed. */
function panelIsOpen(): boolean {
  return container.querySelector('h3') !== null
}

function button(): HTMLButtonElement {
  const btns = Array.from(container.querySelectorAll('button'))
  const b = btns[0]
  if (!b) throw new Error('the Activity button did not render')
  return b as HTMLButtonElement
}

beforeEach(() => {
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(createElement(ActivityCenter))
  })
  const b = button()
  // happy-dom lacks these entirely.
  b.setPointerCapture = (): void => {}
  b.releasePointerCapture = (): void => {}
  b.hasPointerCapture = (): boolean => true
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  localStorage.clear()
})

describe('a click is still a click', () => {
  it('opens the panel when the pointer does not move', () => {
    const b = button()
    pointer(b, 'pointerdown', 100, 100)
    pointer(b, 'pointerup', 100, 100)
    act(() => b.click())

    expect(panelIsOpen()).toBe(true)
  })

  it('still opens after a movement UNDER the 4px threshold', () => {
    const b = button()
    pointer(b, 'pointerdown', 100, 100)
    pointer(b, 'pointermove', 102, 100) // 2px — a hand tremor, not a drag
    pointer(b, 'pointerup', 102, 100)
    act(() => b.click())

    expect(panelIsOpen()).toBe(true)
    // And a sub-threshold wobble must not be mistaken for a reposition.
    expect(localStorage.getItem(POSITION_KEY)).toBeNull()
  })
})

describe('a drag is not a click', () => {
  it('does NOT open the panel when the drop follows a real drag', () => {
    const b = button()
    pointer(b, 'pointerdown', 100, 100)
    pointer(b, 'pointermove', 300, 300)
    pointer(b, 'pointerup', 300, 300)
    // The browser fires click after pointerup on the same element. Without
    // the suppression flag this is the bug: the panel opens on every drop.
    act(() => b.click())

    expect(panelIsOpen()).toBe(false)
  })

  it('suppresses only ONE click, so the next real click still works', () => {
    const b = button()
    pointer(b, 'pointerdown', 100, 100)
    pointer(b, 'pointermove', 300, 300)
    pointer(b, 'pointerup', 300, 300)
    act(() => b.click()) // swallowed

    act(() => b.click()) // a genuine click afterwards
    expect(panelIsOpen()).toBe(true)
  })

  it('persists the position on drop, and only on drop', () => {
    const b = button()
    pointer(b, 'pointerdown', 100, 100)
    pointer(b, 'pointermove', 300, 300)
    // Mid-drag: nothing written yet. A drag is dozens of frames and
    // localStorage is synchronous, which is why the write waits for the drop.
    expect(localStorage.getItem(POSITION_KEY)).toBeNull()

    pointer(b, 'pointerup', 300, 300)
    const saved = localStorage.getItem(POSITION_KEY)
    expect(saved).not.toBeNull()
    expect(JSON.parse(saved as string)).toMatchObject({ x: expect.any(Number), y: expect.any(Number) })
  })
})

describe('a right-click is not a drag', () => {
  it('ignores a non-primary button', () => {
    const b = button()
    const ev = new window.MouseEvent('pointerdown', {
      clientX: 100,
      clientY: 100,
      bubbles: true,
      button: 2 // right
    })
    Object.defineProperty(ev, 'pointerId', { value: 1 })
    act(() => {
      b.dispatchEvent(ev)
    })
    pointer(b, 'pointermove', 300, 300)
    pointer(b, 'pointerup', 300, 300)

    // No drag started, so nothing was repositioned or persisted.
    expect(localStorage.getItem(POSITION_KEY)).toBeNull()
  })
})
