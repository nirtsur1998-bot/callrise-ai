// @vitest-environment happy-dom
//
// INSTRUMENT PANEL — the glance line's slot is always mounted.
//
// Before the restyle GlanceLine returned null between cues, and it sat in a
// space-y-2 column above "Hide transcript" and the transcript itself. So
// every cue arrival pushed the transcript down and every expiry pulled it
// back up — twice per cue, on the one screen whose rule is that nothing
// moves. The slot is the fix: a 44px box that exists whether or not a cue
// does. This pins the two halves of that claim at once — the slot is there
// with no cue, and the cue element (the thing the older "absent when no
// cue" test looks for) is not — so the fix cannot quietly regress into
// either "the slot only mounts with a cue" or "the slot IS the cue".
import { vi } from 'vitest'
vi.hoisted(() => {
  ;(globalThis as unknown as { window: { api?: unknown } }).window.api = { platform: 'win32' }
})
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GlanceLine } from '../GlanceLine'

let roots: Root[] = []
function mount(el: React.ReactElement): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(el))
  return container
}
beforeEach(() => {
  roots = []
  localStorage.clear()
})
afterEach(() => {
  for (const r of roots) act(() => r.unmount())
  document.body.innerHTML = ''
})

describe('GlanceLine slot (Instrument Panel)', () => {
  it('mounts the slot with no cue, and the cue element is absent', () => {
    const c = mount(createElement(GlanceLine, { cue: null, onDismiss: () => {} }))
    expect(
      c.querySelector('[data-testid="glance-slot"]'),
      'the slot must exist without a cue'
    ).not.toBeNull()
    expect(c.querySelector('[data-testid="glance-line"]'), 'no cue means no cue element').toBeNull()
  })

  it('keeps the same slot across a cue arriving and leaving — the cue lives INSIDE it', () => {
    const cue = {
      id: 7,
      kind: 'objection',
      text: 'Anchor on the monthly bill',
      evidence: { kind: 'heard' as const, quote: "that's more than we budgeted" },
      source: 'heard' as const
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => root.render(createElement(GlanceLine, { cue: null, onDismiss: () => {} })))
    const slotBefore = container.querySelector('[data-testid="glance-slot"]')
    expect(slotBefore).not.toBeNull()
    act(() => root.render(createElement(GlanceLine, { cue, onDismiss: () => {} })))
    const line = container.querySelector('[data-testid="glance-line"]')
    expect(line).not.toBeNull()
    expect(line!.closest('[data-testid="glance-slot"]'), 'the cue renders inside the slot').toBe(
      slotBefore
    )
    act(() => root.render(createElement(GlanceLine, { cue: null, onDismiss: () => {} })))
    expect(
      container.querySelector('[data-testid="glance-slot"]'),
      'the slot survives the cue leaving'
    ).toBe(slotBefore)
    expect(
      container.querySelector('[data-testid="glance-line"]'),
      'the cue element leaves with the cue'
    ).toBeNull()
  })
})
